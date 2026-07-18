#!/usr/bin/env node
// obs-mcp — Codex Bodies adapter: drives OBS Studio over obs-websocket v5.
//
// A stdio MCP server (newline-delimited JSON-RPC 2.0, one object per line, no
// SDK — same shape as applescript-mcp and the adapter-contract template).
// Contract: ../../adapter-contract/CONTRACT.md
//
// Switch scenes, roll recordings, and hand frames back as artifacts.
//
// IMPORTANT: stdout is the JSON-RPC channel. All logging MUST go to stderr
// (console.error) — a stray console.log would corrupt the protocol stream.

import readline from "node:readline";
import { mkdir, writeFile, stat, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// NOTE the `/json` subpath. The package's exports map sends a bare Node `import`
// to the MSGPACK build; only the `browser` condition resolves to JSON. We want
// JSON here so the wire traffic is greppable and we skip the msgpack dep.
import OBSWebSocket from "obs-websocket-js/json";

const OBS_URL = process.env.OBS_URL ?? "ws://127.0.0.1:4455";
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? process.cwd();

// OBS keeps its own websocket password on disk. Reading it here means the secret
// stays in exactly one place instead of being copied into config.toml, and it
// keeps working if the password is rotated in the OBS UI. OBS_PASSWORD still
// wins when set (remote OBS, or a non-macOS host).
function obsPasswordFromLocalConfig() {
  const cfg = join(
    homedir(),
    "Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json",
  );
  try {
    const { auth_required, server_password } = JSON.parse(readFileSync(cfg, "utf8"));
    return auth_required ? server_password : undefined;
  } catch {
    return undefined; // not macOS, OBS never launched, or a custom layout
  }
}

const OBS_PASSWORD = process.env.OBS_PASSWORD ?? obsPasswordFromLocalConfig();

// ── JSON-RPC plumbing ───────────────────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, text) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
const errResult = (id, text) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });

const str = (v, name) => {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return v;
};

// OBS sends an empty `comment` for several RequestStatus codes (501 among them),
// which would leave the agent staring at a bare number. Fill in the ones an
// agent can actually act on.
const OBS_STATUS = {
  204: "unknown request type — this OBS version doesn't support it",
  300: "a required request field was missing",
  400: "a request field was invalid",
  500: "a recording is already running",
  501: "no recording is running",
  502: "the recording is paused",
  503: "the recording is not paused",
  504: "that output is disabled in OBS settings",
  505: "studio mode is active",
  506: "studio mode is not active",
  600: "no such scene or source in OBS",
  604: "that resource is in the wrong state for this request",
};

// ── connection ──────────────────────────────────────────────────────────────
// obs-websocket-js does NOT auto-reconnect (verified: no reconnect logic in the
// library), so we connect lazily per call and re-dial whenever the socket has
// dropped. Connecting lazily also means tools/list still works with OBS closed,
// which the contract's smoke test requires.
const obs = new OBSWebSocket();
let connected = false;

// Close code 4011 = SessionInvalidated (someone hit "Kick" in the OBS UI). The
// protocol explicitly says a client must NOT auto-reconnect after this one, so
// we latch it and make the user re-authorize rather than silently redialing.
let kicked = false;

obs.on("ConnectionClosed", (err) => {
  connected = false;
  if (err?.code === 4011) kicked = true;
  console.error(`[obs-mcp] connection closed: ${err?.code ?? "?"} ${err?.message ?? ""}`);
});
obs.on("ConnectionError", (err) => {
  connected = false;
  console.error(`[obs-mcp] connection error: ${err?.message ?? err}`);
});

async function ensureObs() {
  if (connected && obs.identified) return obs;
  if (kicked) {
    throw new Error(
      "this session was kicked from OBS (close code 4011). Re-enable the connection in OBS " +
        "(Tools → WebSocket Server Settings) and restart the adapter — auto-reconnect is forbidden after a kick.",
    );
  }
  try {
    const { obsWebSocketVersion } = await obs.connect(OBS_URL, OBS_PASSWORD);
    connected = true;
    console.error(`[obs-mcp] connected to obs-websocket ${obsWebSocketVersion} at ${OBS_URL}`);
    return obs;
  } catch (e) {
    // 4009 is the one failure a user can actually fix from the error text, so
    // separate it from "OBS isn't running" instead of surfacing a bare code.
    if (e?.code === 4009) {
      throw new Error(
        `OBS rejected the password (4009). Set OBS_PASSWORD to the value from OBS → Tools → WebSocket Server Settings → Show Connect Info.`,
      );
    }
    throw new Error(
      `can't reach OBS at ${OBS_URL} (${e?.message ?? e}). Is OBS running with Tools → WebSocket Server Settings → "Enable WebSocket server" checked?`,
    );
  }
}

// ── scenes ──────────────────────────────────────────────────────────────────
// The agent will say "demo" when the scene is "demo screen capture", so match
// case-insensitively and fall back to a unique substring hit. Anything
// ambiguous or missing errors with the real scene list, which is the only way
// the agent can correct itself.
async function resolveSceneName(o, wanted) {
  const { scenes } = await o.call("GetSceneList");
  const names = scenes.map((s) => s.sceneName);

  const exact = names.find((n) => n.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact;

  const partial = names.filter((n) => n.toLowerCase().includes(wanted.toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`"${wanted}" is ambiguous — matches: ${partial.join(", ")}`);
  throw new Error(`no scene matching "${wanted}". Available scenes: ${names.join(", ") || "(none)"}`);
}

// ── screenshots ─────────────────────────────────────────────────────────────
// Filenames are timestamped rather than stable. The workspace panel emits one
// snapshot per NEW path (see IMG_RE in frontend/components/workspace-panel.tsx),
// so a fixed filename would make every screenshot after the first invisible.
async function captureFrame(o, sourceName, label = "obs") {
  const source = sourceName ?? (await o.call("GetCurrentProgramScene")).sceneName;

  // imageFormat is REQUIRED. Width is "scale to inner" — aspect is preserved.
  const { imageData } = await o.call("GetSourceScreenshot", {
    sourceName: source,
    imageFormat: "png",
    imageWidth: 1280,
  });

  // OBS returns a full data URI ("data:image/png;base64,...") even though the
  // protocol docs only say "Base64-encoded". Strip the prefix or the PNG is
  // corrupt. Verified against RequestHandler_Sources.cpp, not the docs.
  const b64 = imageData.replace(/^data:image\/\w+;base64,/, "");

  await mkdir(ARTIFACTS_DIR, { recursive: true });
  const safe = label.replace(/[^\w.-]+/g, "_");
  const file = join(ARTIFACTS_DIR, `${safe}-${Date.now()}.png`);
  await writeFile(file, Buffer.from(b64, "base64"));
  return { path: file, source };
}

// ── recording ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return false;
}

// Newest video file in OBS's record directory. Used to surface a recording even
// when the agent asks to stop one that already stopped — without this, that path
// returns a bare error and the workspace panel gets nothing to render.
async function newestRecording(o) {
  try {
    const { recordDirectory } = await o.call("GetRecordDirectory");
    const files = (await readdir(recordDirectory)).filter((f) => /\.(mp4|mov|mkv|webm)$/i.test(f));
    if (!files.length) return null;
    const stamped = await Promise.all(
      files.map(async (f) => {
        const p = join(recordDirectory, f);
        return { p, t: (await stat(p)).mtimeMs };
      }),
    );
    stamped.sort((a, b) => b.t - a.t);
    return stamped[0].p;
  } catch {
    return null;
  }
}

async function stopRecording(o) {
  // OBS finalizes (remuxes) the file asynchronously after StopRecord returns, so
  // the reply's path can point at a file that isn't fully written. The
  // RecordStateChanged/..._STOPPED event is the real "file is on disk" signal.
  // Register BEFORE calling StopRecord or we race the event.
  const finalized = new Promise((resolve) => {
    const onState = ({ outputState, outputPath }) => {
      if (outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED") {
        obs.off("RecordStateChanged", onState);
        resolve(outputPath);
      }
    };
    obs.on("RecordStateChanged", onState);
    setTimeout(() => {
      obs.off("RecordStateChanged", onState);
      resolve(null); // fall back to StopRecord's own path
    }, 15_000);
  });

  const { outputPath } = await o.call("StopRecord");
  let file = (await finalized) ?? outputPath;

  // The docs call this a "File name" and don't promise it's absolute, so resolve
  // it against the configured record directory when it isn't.
  if (!isAbsolute(file)) {
    const { recordDirectory } = await o.call("GetRecordDirectory");
    file = join(recordDirectory, file);
  }

  let size = "unknown size";
  try {
    const { size: bytes } = await stat(file);
    size = `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  } catch {
    /* OBS may still be flushing, or it recorded to a host we can't see */
  }
  return { file, size };
}

// ── tools ───────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "observe_obs",
    description:
      "Read-only snapshot of OBS: every scene name, which scene is live, whether a recording is rolling (and for how long), and where recordings are saved. Call this FIRST to learn the exact scene names before switching.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "switch_scene",
    description:
      "Make a scene the live (program) scene. Accepts a partial, case-insensitive name — 'demo' matches 'demo screen capture'. If the name is ambiguous or unknown the error lists the real scenes.",
    inputSchema: {
      type: "object",
      properties: { scene: { type: "string", description: "Scene name or a unique part of it, e.g. 'minecraft'" } },
      required: ["scene"],
    },
  },
  {
    name: "start_recording",
    description:
      "Start recording video to disk. Errors if a recording is already running. Use stop_recording to finish and get the file path.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stop_recording",
    description:
      "Stop the current recording and return the absolute path to the saved video file, waiting for OBS to finish writing it. Also saves a PNG thumbnail to the artifacts folder so the frame is viewable in the workspace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capture_screenshot",
    description:
      "Save a PNG of what OBS is showing to the artifacts folder and return its absolute path. Defaults to the live program scene. This is how you SEE what is on screen — use it to verify a scene switch looks right.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Scene or source name to shoot. Defaults to the live program scene." },
        label: { type: "string", description: "Filename prefix for the artifact. Defaults to 'obs'." },
      },
    },
  },
];

async function callTool(id, name, args = {}) {
  try {
    const o = await ensureObs();

    switch (name) {
      case "observe_obs": {
        const { scenes, currentProgramSceneName } = await o.call("GetSceneList");
        const rec = await o.call("GetRecordStatus");
        const { recordDirectory } = await o.call("GetRecordDirectory");
        const names = scenes.map((s) => s.sceneName);
        const recLine = rec.outputActive
          ? `RECORDING${rec.outputPaused ? " (paused)" : ""} — ${rec.outputTimecode}, ${(rec.outputBytes / 1024 / 1024).toFixed(1)} MB so far`
          : "not recording";
        const latest = await newestRecording(o);
        return ok(
          id,
          [
            `live scene: ${currentProgramSceneName ?? "(none)"}`,
            `scenes (${names.length}): ${names.join(", ") || "(none)"}`,
            recLine,
            `recordings save to: ${recordDirectory}`,
            ...(latest ? [`most recent recording: ${latest}`] : []),
          ].join("\n"),
        );
      }

      case "switch_scene": {
        const wanted = str(args.scene, "scene");
        const sceneName = await resolveSceneName(o, wanted);
        await o.call("SetCurrentProgramScene", { sceneName });
        return ok(id, `switched live scene to "${sceneName}"`);
      }

      case "start_recording": {
        const { recordDirectory } = await o.call("GetRecordDirectory");
        await o.call("StartRecord");
        // StartRecord returns before the output is up, and OBS can fail to bring
        // it up at all — unwritable path, missing encoder — WITHOUT throwing.
        // Reporting success there leaves the agent believing it is recording and
        // the eventual stop_recording has nothing to hand back. Confirm instead.
        const live = await waitUntil(async () => (await o.call("GetRecordStatus")).outputActive, 5000);
        if (!live) {
          throw new Error(
            `OBS accepted the start but no recording became active within 5s. Check that "${recordDirectory}" exists and is writable, and that a recording encoder is configured in OBS → Settings → Output.`,
          );
        }
        return ok(id, `recording started — will save under ${recordDirectory}`);
      }

      case "stop_recording": {
        // Stopping something that isn't running is an OBS 501. Rather than
        // surface a bare error, hand back the most recent recording so the
        // workspace still gets a player.
        if (!(await o.call("GetRecordStatus")).outputActive) {
          const latest = await newestRecording(o);
          return ok(
            id,
            latest
              ? `no recording was running. Most recent recording: ${latest}`
              : "no recording was running, and no recordings were found in the record directory.",
          );
        }
        const { file, size } = await stopRecording(o);
        // Best-effort thumbnail: the video itself can't render in the workspace
        // panel (it only picks up image paths), so a frame is what makes the
        // recording visible at all. Never fail the stop over it.
        let thumb = "";
        try {
          const art = await captureFrame(o, undefined, "recording-thumb");
          thumb = `\nthumbnail: ${art.path}`;
        } catch (e) {
          console.error("[obs-mcp] thumbnail failed:", e?.message ?? e);
        }
        return ok(id, `recording stopped.\nvideo: ${file} (${size})${thumb}`);
      }

      case "capture_screenshot": {
        const source = args.source === undefined ? undefined : str(args.source, "source");
        const label = args.label === undefined ? "obs" : str(args.label, "label");
        // Let a partial scene name work here too, for consistency with switch_scene.
        const resolved = source ? await resolveSceneName(o, source).catch(() => source) : undefined;
        const art = await captureFrame(o, resolved, label);
        return ok(id, `captured "${art.source}" → ${art.path}`);
      }

      default:
        return errResult(id, `unknown tool: ${name}`);
    }
  } catch (e) {
    // A request rejected by OBS carries a numeric RequestStatus code; a call made
    // while disconnected throws a PLAIN Error with no code. Surface the code when
    // there is one so the agent can tell "wrong scene name" (600) from "OBS died".
    const code = typeof e?.code === "number" ? ` [obs ${e.code}]` : "";
    const why = (e?.message || "").trim() || OBS_STATUS[e?.code] || String(e);
    return errResult(id, `${name || "tool"} failed${code}: ${why}`);
  }
}

const INSTRUCTIONS = `Controls OBS Studio (screen recording / streaming software) over its WebSocket API.

Call observe_obs first — it lists the exact scene names, which one is live, and whether a
recording is rolling. Then switch_scene to change what is on screen, start_recording /
stop_recording to capture video, and capture_screenshot to actually look at the output.

OBS must be running with its WebSocket server enabled for any of these to work.`;

// ── JSON-RPC loop ───────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  lastActivity = Date.now(); // feeds the idle-exit watchdog below
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "obs-mcp", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      },
    });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    void callTool(id, params?.name, params?.arguments);
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} }); // answer anything else so the client never hangs
  }
});

process.on("uncaughtException", (e) => console.error("[obs-mcp] uncaught exception:", e?.stack ?? e));
process.on("unhandledRejection", (e) => console.error("[obs-mcp] unhandled rejection:", e?.stack ?? e));

let shuttingDown = false;
async function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[obs-mcp] shutting down (${why})`);
  // Cleanup must never be able to wedge the process. A websocket close that
  // doesn't resolve would otherwise leave an orphan alive forever, holding its
  // OBS connection — observed in practice, which is why this is a hard deadline
  // rather than a plain await.
  setTimeout(() => process.exit(0), 3000).unref();
  try {
    if (connected) await obs.disconnect();
  } catch {}
  process.exit(0);
}
rl.on("close", () => shutdown("stdin closed")); // parent (app-server) died → EOF
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// The Codex app-server spawns a FRESH set of adapters per turn and does not stop
// the previous set, so superseded instances accumulate for as long as it lives —
// each one holding its own connections and memory. A superseded instance never
// receives another tools/call, so idle time is the signal that we've been
// replaced. Belt-and-braces: also exit if we get reparented (ppid 1), which
// means our parent died without our stdin ever reaching EOF.
const IDLE_EXIT_MS = Number(process.env.MCP_IDLE_EXIT_MS ?? 15 * 60_000);
let lastActivity = Date.now();
if (IDLE_EXIT_MS > 0) {
  setInterval(() => {
    if (process.ppid === 1) return shutdown("orphaned (parent died)");
    if (Date.now() - lastActivity > IDLE_EXIT_MS) {
      shutdown(`idle ${Math.round(IDLE_EXIT_MS / 60_000)}m — superseded by a newer instance`);
    }
  }, 30_000).unref();
}

console.error("[obs-mcp] MCP server ready on stdio");
