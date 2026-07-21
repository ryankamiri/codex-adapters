#!/usr/bin/env node
// spotify-mcp — control Spotify for macOS through AppleScript.
// stdout is reserved for newline-delimited JSON-RPC; diagnostics go to stderr.

import readline from "node:readline";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const toolResult = (id, text, isError = false) =>
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
  });

const SPOTIFY_APP = process.env.SPOTIFY_APP || "Spotify";
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || process.cwd();

const TOOLS = [
  {
    name: "play_song",
    description:
      "Play a song in Spotify. Pass a Spotify URI/URL for an exact item, or a search query such as 'Daft Punk Get Lucky'. This opens Spotify if needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Spotify URI/URL, or a search query. Queries use Spotify's AppleScript search playback.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "skip_song",
    description: "Skip to the next Spotify track.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_volume",
    description: "Set Spotify's volume level from 0 to 100.",
    inputSchema: {
      type: "object",
      properties: {
        level: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "Spotify volume level, where 0 is muted and 100 is full volume.",
        },
      },
      required: ["level"],
    },
  },
  {
    name: "adjust_volume",
    description: "Adjust Spotify's volume up or down by a relative amount. Use negative values to lower volume.",
    inputSchema: {
      type: "object",
      properties: {
        delta: {
          type: "integer",
          minimum: -100,
          maximum: 100,
          description: "Relative volume change. For example, 10 raises volume by 10 and -10 lowers it by 10.",
        },
      },
      required: ["delta"],
    },
  },
  {
    name: "observe_playback",
    description:
      "Observe Spotify playback state, current track, artist, album, duration, position, and volume. Read-only and safe to call anytime.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_status",
    description:
      "Read Spotify playback state, current track, artist, album, duration, position, and volume. Compatibility alias for observe_playback.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capture_status",
    description:
      "Capture the current Spotify playback state as a JSON artifact under ARTIFACTS_DIR and return the file path.",
    inputSchema: { type: "object", properties: {} },
  },
];

function errorText(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error?.message || String(error);
}

function debug(event, details = {}) {
  process.stderr.write(`[spotify-mcp] ${JSON.stringify({ event, ...details })}\n`);
}

async function osa(script, args = []) {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script, "--", ...args], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.replace(/\r?\n$/, "");
}

function normalizeTrackTarget(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("play_song requires a non-empty string argument: query");
  }

  const query = value.trim();
  if (/^spotify:/i.test(query)) return query;

  try {
    const url = new URL(query);
    if (url.hostname === "open.spotify.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return `spotify:${parts[0]}:${parts[1]}`;
    }
  } catch {
    // Not a URL; treat it as a Spotify search query.
  }

  return `spotify:search:${query}`;
}

function parseStatus(raw) {
  const [state, volume, name, artist, album, durationMs, positionSeconds] = raw.split("\t");
  return {
    state: state || "unknown",
    volume: Number(volume || 0),
    track: name || "",
    artist: artist || "",
    album: album || "",
    durationMs: Number(durationMs || 0),
    positionSeconds: Number(positionSeconds || 0),
  };
}

const playTrackScript = String.raw`on run argv
  set appName to item 1 of argv
  set trackTarget to item 2 of argv
  using terms from application "Spotify"
    tell application appName
      activate
      play track trackTarget
      delay 0.2
      return player state as text
    end tell
  end using terms from
end run`;

const skipTrackScript = String.raw`on run argv
  set appName to item 1 of argv
  using terms from application "Spotify"
    tell application appName
      next track
      delay 0.2
      return player state as text
    end tell
  end using terms from
end run`;

const setVolumeScript = String.raw`on run argv
  set appName to item 1 of argv
  set newVolume to (item 2 of argv) as integer
  using terms from application "Spotify"
    tell application appName
      set sound volume to newVolume
      return sound volume as text
    end tell
  end using terms from
end run`;

const adjustVolumeScript = String.raw`on run argv
  set appName to item 1 of argv
  set deltaVolume to (item 2 of argv) as integer
  using terms from application "Spotify"
    tell application appName
      set newVolume to sound volume + deltaVolume
      if newVolume < 0 then set newVolume to 0
      if newVolume > 100 then set newVolume to 100
      set sound volume to newVolume
      return sound volume as text
    end tell
  end using terms from
end run`;

const statusScript = String.raw`on run argv
  set appName to item 1 of argv
  set sep to tab
  tell application "System Events"
    set spotifyRunning to exists application process appName
  end tell
  if spotifyRunning is false then
    return "not running" & sep & "0" & sep & sep & sep & sep & "0" & sep & "0"
  end if
  using terms from application "Spotify"
    tell application appName
      set playbackState to player state as text
      set currentVolume to sound volume as text
      set trackName to ""
      set trackArtist to ""
      set trackAlbum to ""
      set trackDuration to "0"
      set trackPosition to "0"
      if playbackState is not "stopped" then
        try
          set trackName to name of current track
          set trackArtist to artist of current track
          set trackAlbum to album of current track
          set trackDuration to duration of current track as text
          set trackPosition to player position as text
        end try
      end if
      return playbackState & sep & currentVolume & sep & trackName & sep & trackArtist & sep & trackAlbum & sep & trackDuration & sep & trackPosition
    end tell
  end using terms from
end run`;

async function readStatus() {
  return parseStatus(await osa(statusScript, [SPOTIFY_APP]));
}

async function captureStatusArtifact(status) {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  const filePath = path.resolve(ARTIFACTS_DIR, "spotify-status.json");
  await writeFile(filePath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return filePath;
}

async function callTool(id, name, args = {}) {
  const startedAt = Date.now();
  let status = "completed";
  debug("tool_call_started", { tool: name || "<unknown>" });

  try {
    switch (name) {
      case "play_song": {
        const target = normalizeTrackTarget(args.query);
        const state = await osa(playTrackScript, [SPOTIFY_APP, target]);
        return toolResult(id, JSON.stringify({ state, target }));
      }

      case "skip_song": {
        const state = await osa(skipTrackScript, [SPOTIFY_APP]);
        return toolResult(id, JSON.stringify({ state }));
      }

      case "set_volume": {
        if (!Number.isInteger(args.level) || args.level < 0 || args.level > 100) {
          return toolResult(id, "set_volume requires an integer level from 0 to 100", true);
        }
        const volume = await osa(setVolumeScript, [SPOTIFY_APP, String(args.level)]);
        return toolResult(id, JSON.stringify({ volume: Number(volume) }));
      }

      case "adjust_volume": {
        if (!Number.isInteger(args.delta) || args.delta < -100 || args.delta > 100) {
          return toolResult(id, "adjust_volume requires an integer delta from -100 to 100", true);
        }
        const volume = await osa(adjustVolumeScript, [SPOTIFY_APP, String(args.delta)]);
        return toolResult(id, JSON.stringify({ volume: Number(volume) }));
      }

      case "observe_playback":
      case "get_status": {
        return toolResult(id, JSON.stringify(await readStatus()));
      }

      case "capture_status": {
        const status = await readStatus();
        const filePath = await captureStatusArtifact(status);
        return toolResult(id, JSON.stringify({ path: filePath, status }));
      }

      default:
        return toolResult(id, `unknown tool: ${name}`, true);
    }
  } catch (error) {
    status = "failed";
    debug("tool_call_failed", { tool: name || "<unknown>", error: errorText(error) });
    return toolResult(
      id,
      `${name || "tool"} failed: ${errorText(error)}. Make sure Spotify is installed and macOS Automation permission is granted to the process running this adapter.`,
      true,
    );
  } finally {
    debug("tool_call_finished", { tool: name || "<unknown>", status, durationMs: Date.now() - startedAt });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = message;
  if (method === "initialize") {
    debug("client_initialized");
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "spotify-mcp", version: "0.1.0" },
      },
    });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    void callTool(id, params?.name, params?.arguments);
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});

rl.on("close", () => debug("shutdown", { reason: "stdin_closed" }));
process.once("exit", (code) => debug("process_exit", { code }));
debug("ready", { transport: "stdio", app: SPOTIFY_APP });
