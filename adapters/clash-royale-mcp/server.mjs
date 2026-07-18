#!/usr/bin/env node
// clash-royale-mcp — control Clash Royale through macOS iPhone Mirroring.
// stdout is reserved for newline-delimited JSON-RPC; diagnostics go to stderr.
//
// Performance: the mouse helper is COMPILED ONCE to a native binary (swiftc) and
// reused, instead of interpreting mouse.swift on every action (which costs seconds
// per tap). Window geometry is cached and app activation is throttled so a tap is
// one fast subprocess, not three slow ones.

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, text) =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
const errResult = (id, text) =>
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError: true },
  });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.resolve(process.env.ARTIFACTS_DIR || process.cwd());
const IPHONE_APP_NAME = process.env.IPHONE_MIRRORING_APP || "iPhone Mirroring";
const MOUSE_HELPER = path.join(__dirname, "mouse.swift");
const SWIFT_MODULE_CACHE = process.env.SWIFT_MODULE_CACHE ||
  path.join("/private/tmp", "clash-royale-mcp-swift-module-cache");
const MOUSE_BIN_DIR = process.env.MOUSE_BIN_DIR ||
  path.join("/private/tmp", "clash-royale-mcp-bin");
const MOUSE_BIN = path.join(MOUSE_BIN_DIR, "mouse.bin");
const WINDOW_TTL_MS = Number(process.env.PHONE_WINDOW_TTL_MS || 1500);
const ACTIVATE_TTL_MS = Number(process.env.PHONE_ACTIVATE_TTL_MS || 2500);
const INSETS = {
  left: Number(process.env.PHONE_INSET_LEFT || 0),
  top: Number(process.env.PHONE_INSET_TOP || 0),
  right: Number(process.env.PHONE_INSET_RIGHT || 0),
  bottom: Number(process.env.PHONE_INSET_BOTTOM || 0),
};

// Card slot x-positions (normalized), left→right. y≈0.82 is the hand row.
const CARD_SLOT_X = [0.22, 0.4, 0.58, 0.76];

const PRESETS = {
  ok: { x: 0.72, y: 0.88, note: "Post-match OK button." },
  play_again: { x: 0.38, y: 0.88, note: "Post-match Play Again button." },
  bottom_left_card: { x: 0.22, y: 0.82, note: "Card slot 1 (leftmost)." },
  bottom_mid_left_card: { x: 0.4, y: 0.82, note: "Card slot 2." },
  bottom_mid_right_card: { x: 0.58, y: 0.82, note: "Card slot 3." },
  bottom_right_card: { x: 0.76, y: 0.82, note: "Card slot 4 (rightmost)." },
  arena_center: { x: 0.5, y: 0.48, note: "Center of the arena." },
  own_left_lane: { x: 0.34, y: 0.62, note: "Own-side left lane deploy point." },
  own_right_lane: { x: 0.66, y: 0.62, note: "Own-side right lane deploy point." },
  defend_left: { x: 0.35, y: 0.66, note: "Defensive spot in front of your LEFT princess tower." },
  defend_right: { x: 0.65, y: 0.66, note: "Defensive spot in front of your RIGHT princess tower." },
  bridge_left: { x: 0.3, y: 0.45, note: "Left bridge — offensive push entry." },
  bridge_right: { x: 0.7, y: 0.45, note: "Right bridge — offensive push entry." },
  behind_king_left: { x: 0.4, y: 0.74, note: "Behind king tower (left) — start a big push." },
  behind_king_right: { x: 0.6, y: 0.74, note: "Behind king tower (right) — start a big push." },
};

// The strategy the agent should follow. Returned by the `strategy` tool and
// summarized in `observe_phone` so the agent plays deliberately instead of tapping
// blindly.
const PLAYBOOK = `CLASH ROYALE PLAYBOOK — DEFEND EVERYTHING, THEN ATTACK

HOW YOU WIN
You win by dealing the MOST tower damage / taking the most towers in ~3 min (+overtime).
So you must do BOTH: stop every enemy push AND constantly pressure their towers. Passive
play (hoarding elixir, waiting, doing nothing) LOSES. Be active every single turn.

PRIORITY #1 — DEFEND EVERY THREAT. Never let a troop reach your tower.
- Every turn, FIRST look for enemy troops on YOUR side of the river (y > 0.5) or crossing a
  bridge. If there is ANY threat, DEFEND IT IMMEDIATELY. Do not wait. Do not "save elixir".
- Place your defender IN THE PATH between the enemy troop and the threatened tower, slightly
  ahead of the tower, so your troop + the tower kill it BEFORE it lands a hit.
- Match the threat: ground troops for a ground push, splash/area for swarms, a tank or
  building to soak a big tank while your tower + support kill it. Add support behind.
- A tower hit costs FAR more than any elixir. Defending is ALWAYS worth it. Letting a troop
  touch your tower is the worst possible outcome — prevent it every time, no exceptions.

PRIORITY #2 — COUNTER-PUSH AND ATTACK. Deal damage, take towers.
- The instant a defense succeeds, push with your SURVIVING troops plus a support card behind
  them. Troops that lived on defense are your cheapest, strongest attackers.
- Whenever the board is clear and you have elixir, START a push at the enemy's WEAKER /
  lower-HP tower: tank in front (from a bridge, or behind your king tower to build up),
  support tucked behind it. Keep constant pressure — unspent elixir with no attack is wasted
  damage and a wasted turn.

ELIXIR — DO NOT HOARD
- Max 10, ~1 per 2.8s (2x after 2:00 on the clock, 3x in overtime). Spend it: defense first,
  then offense. The ONLY time to hold elixir is when your side is COMPLETELY clear AND you're
  briefly topping off for a bigger push. Never sit idle while any threat exists. If you find
  yourself waiting or "saving elixir" repeatedly, you are playing WRONG — attack or defend.

READING THE SCREEN (capture_phone_screen before every decision)
- Elixir: pink/purple bar at the bottom (0-10). But a low count NEVER excuses skipping a
  defense — defend with whatever you have.
- Hand: 4 cards (slots 1-4, left→right) with costs. Use deploy_card to place one in one action.
- Towers: yours bottom-left/right + king center; enemy mirrored on top. Watch HP numbers.
- Threats: any enemy unit past the river. Their half is y<0.5, YOUR half is y>0.5 — anything
  in your half must be answered NOW.

DECISION LOOP EACH TURN (bias hard toward ACTING)
capture_phone_screen ->
  1) Enemy troop on my side or crossing a bridge?  -> DEFEND it now: deploy_card in its path.
  2) Else, board clear and I have elixir?          -> ATTACK the weaker enemy tower.
  3) Only if my side is fully clear and I'm just topping off elixir -> a SHORT wait, re-check.
Repeat quickly. When in doubt, DEFEND or ATTACK — never idle.`;

const artifactPath = (name) => {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  return path.join(ARTIFACTS_DIR, name);
};

const cleanFilename = (name, fallback) => {
  let filename = typeof name === "string" && name.trim() ? name.trim() : fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) || filename === "." || filename === "..") {
    throw new Error("filename must be a simple basename without directories");
  }
  if (!filename.toLowerCase().endsWith(".png")) filename += ".png";
  return filename;
};

const errorText = (error) => {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error?.message || String(error);
};

const TOOLS = [
  {
    name: "strategy",
    description:
      "Return the Clash Royale playbook. Core rule: DEFEND EVERY THREAT (never let an enemy troop reach your tower), then counter-push and attack the weaker tower. Do NOT hoard elixir or idle — passive play loses. Call this once at match start and whenever unsure. No side effects.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "observe_phone",
    description:
      "Read-only snapshot of the iPhone Mirroring window: app/window presence, bounds, usable phone rectangle, insets, preset tap targets, and a short reading guide. Call before tapping to confirm the window is present. This does NOT show game state — use capture_phone_screen to actually see the board.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capture_phone_screen",
    description:
      "Capture the mirrored phone as a PNG artifact so you can SEE the board: read your elixir bar (bottom), the 4 cards in hand and their costs, tower HP, and enemy troops. Do this before every decision.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Optional artifact filename; defaults to clash-royale-screen.png.",
        },
        fullWindow: {
          type: "boolean",
          description: "If true, capture the whole iPhone Mirroring window instead of the inset phone rectangle.",
        },
      },
    },
  },
  {
    name: "deploy_card",
    description:
      "Deploy a card in ONE fast action: selects a hand slot then places it at normalized x/y. Prefer this over tap-then-tap. DEFENSE: place the defender IN THE PATH between an incoming enemy and your tower (your half is y>0.5, e.g. defend_left/right ≈ y0.66) so your troop + tower kill it before it hits. ATTACK: place at a bridge (y≈0.45) or behind your king tower (y≈0.74). Always defend a threat even at low elixir — do not skip a defense to save elixir.",
    inputSchema: {
      type: "object",
      properties: {
        slot: { type: "integer", description: "Card slot 1-4 (left to right in your hand)." },
        x: { type: "number", description: "Deploy x, normalized 0 (left) .. 1 (right)." },
        y: { type: "number", description: "Deploy y, normalized 0 (top/enemy) .. 1 (bottom/you). Your half is y>0.5." },
        note: { type: "string", description: "Optional reason (e.g. 'defend left push'); echoed for traceability." },
      },
      required: ["slot", "x", "y"],
    },
  },
  {
    name: "tap",
    description:
      "Tap inside the phone rectangle at normalized x/y (0..1). Use for menu buttons or a raw board tap when deploy_card doesn't fit. Read a screenshot first.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Normalized horizontal coordinate, 0 left to 1 right." },
        y: { type: "number", description: "Normalized vertical coordinate, 0 top to 1 bottom." },
        note: { type: "string", description: "Optional reason for the tap; echoed for traceability." },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "swipe",
    description:
      "Swipe/drag inside the phone rectangle using normalized coordinates. Useful for drag-deploying a card from its slot to a target, or scrolling UI.",
    inputSchema: {
      type: "object",
      properties: {
        fromX: { type: "number", description: "Start x, normalized 0..1." },
        fromY: { type: "number", description: "Start y, normalized 0..1." },
        toX: { type: "number", description: "End x, normalized 0..1." },
        toY: { type: "number", description: "End y, normalized 0..1." },
        durationMs: { type: "number", description: "Swipe duration in milliseconds; default 250." },
        steps: { type: "integer", description: "Number of drag steps; default 12." },
        note: { type: "string", description: "Optional reason for the swipe; echoed for traceability." },
      },
      required: ["fromX", "fromY", "toX", "toY"],
    },
  },
  {
    name: "tap_preset",
    description:
      "Tap a named preset target: menu buttons (ok, play_again), card slots (bottom_*_card), or deploy points (arena_center, own_left_lane, own_right_lane, defend_left, defend_right, bridge_left, bridge_right, behind_king_left, behind_king_right). Presets are approximate — verify with a screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: Object.keys(PRESETS), description: "Preset tap target." },
      },
      required: ["target"],
    },
  },
  {
    name: "wait",
    description:
      "Pause briefly (max 5000ms) ONLY when your side of the river is completely clear of enemy troops AND you are topping off elixir for a bigger push. NEVER wait while any enemy troop is on your side or crossing a bridge — defend instead. Overusing wait / hoarding elixir loses games; prefer defending or attacking.",
    inputSchema: {
      type: "object",
      properties: {
        ms: { type: "integer", description: "Milliseconds to wait, 0-5000." },
        note: { type: "string", description: "Optional reason (e.g. 'bank elixir to 10')." },
      },
      required: ["ms"],
    },
  },
  {
    name: "press_key",
    description:
      "Send a keyboard key to iPhone Mirroring through System Events. Use for Escape/back or simple keyboard navigation when supported.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Single character, return, escape, space, tab, left, right, up, or down." },
      },
      required: ["key"],
    },
  },
];

// ── mouse helper: compile once, reuse the binary ──────────────────────────────
let mouseBinP = null;
async function ensureMouseBinary() {
  try {
    fs.mkdirSync(MOUSE_BIN_DIR, { recursive: true });
    const [binStat, srcStat] = await Promise.all([
      fs.promises.stat(MOUSE_BIN).catch(() => null),
      fs.promises.stat(MOUSE_HELPER),
    ]);
    if (binStat && binStat.mtimeMs >= srcStat.mtimeMs) return MOUSE_BIN;
    fs.mkdirSync(SWIFT_MODULE_CACHE, { recursive: true });
    await run(
      "/usr/bin/swiftc",
      ["-O", "-module-cache-path", SWIFT_MODULE_CACHE, MOUSE_HELPER, "-o", MOUSE_BIN],
      { timeout: 120000 },
    );
    return MOUSE_BIN;
  } catch (error) {
    process.stderr.write(`mouse binary compile failed, will interpret instead: ${errorText(error)}\n`);
    return null;
  }
}
function mouseBinary() {
  if (!mouseBinP) mouseBinP = ensureMouseBinary();
  return mouseBinP;
}

async function mouse(mode, args) {
  const a = args.map((arg) => String(arg));
  const bin = await mouseBinary();
  if (bin) {
    await run(bin, [mode, ...a], { timeout: 15000 });
    return;
  }
  // Fallback: interpret the source (slow) only if compilation failed.
  fs.mkdirSync(SWIFT_MODULE_CACHE, { recursive: true });
  await run(
    "/usr/bin/swift",
    ["-module-cache-path", SWIFT_MODULE_CACHE, MOUSE_HELPER, mode, ...a],
    { timeout: 30000 },
  );
}

async function activatePhone() {
  await run("osascript", ["-e", `tell application ${JSON.stringify(IPHONE_APP_NAME)} to activate`]);
}

// Activate at most once per ACTIVATE_TTL_MS — the window stays frontmost during play,
// so re-activating on every tap just wastes an osascript spawn.
let lastActivateAt = 0;
async function maybeActivate(force = false) {
  const now = Date.now();
  if (!force && now - lastActivateAt < ACTIVATE_TTL_MS) return;
  await activatePhone();
  lastActivateAt = now;
}

async function windowInfo() {
  const script = `tell application "System Events"
  if not (exists application process ${JSON.stringify(IPHONE_APP_NAME)}) then
    return "missing"
  end if
  tell application process ${JSON.stringify(IPHONE_APP_NAME)}
    if count of windows is 0 then return "no-window"
    set w to front window
    set {x, y} to position of w
    set {ww, hh} to size of w
    return (name of w) & tab & x & tab & y & tab & ww & tab & hh
  end tell
end tell`;
  const { stdout } = await run("osascript", ["-e", script]);
  const text = stdout.replace(/\r?\n$/, "");
  if (text === "missing") return { present: false, error: `${IPHONE_APP_NAME} is not running` };
  if (text === "no-window") return { present: true, error: `${IPHONE_APP_NAME} has no windows` };

  const [title, x, y, width, height] = text.split("\t");
  const window = {
    title,
    x: Number(x),
    y: Number(y),
    width: Number(width),
    height: Number(height),
  };
  const phone = {
    x: window.x + INSETS.left,
    y: window.y + INSETS.top,
    width: window.width - INSETS.left - INSETS.right,
    height: window.height - INSETS.top - INSETS.bottom,
  };
  if (![window.x, window.y, window.width, window.height, phone.x, phone.y, phone.width, phone.height].every(Number.isFinite)) {
    throw new Error(`could not parse ${IPHONE_APP_NAME} window geometry: ${text}`);
  }
  if (phone.width <= 0 || phone.height <= 0) {
    throw new Error(`configured phone insets leave a non-positive usable rectangle: ${JSON.stringify({ window, insets: INSETS, phone })}`);
  }
  return { present: true, app: IPHONE_APP_NAME, window, phone, insets: INSETS, presets: PRESETS };
}

// Cache the window geometry briefly — it doesn't move during a match, so most taps
// can skip the System Events round-trip.
let windowCache = { at: 0, value: null };
async function getWindowInfo(force = false) {
  const now = Date.now();
  if (!force && windowCache.value && now - windowCache.at < WINDOW_TTL_MS) return windowCache.value;
  const info = await windowInfo();
  windowCache = { at: now, value: info };
  return info;
}

function normalized(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${name} must be a number from 0 to 1`);
  }
  return n;
}

function toScreen(rect, x, y) {
  return {
    x: rect.x + rect.width * normalized(x, "x"),
    y: rect.y + rect.height * normalized(y, "y"),
  };
}

async function keypress(key) {
  const keyCodes = {
    return: 36,
    escape: 53,
    space: 49,
    tab: 48,
    left: 123,
    right: 124,
    down: 125,
    up: 126,
  };
  const normalizedKey = String(key || "").toLowerCase();
  if (keyCodes[normalizedKey] !== undefined) {
    await run("osascript", ["-e", `tell application "System Events" to key code ${keyCodes[normalizedKey]}`]);
    return normalizedKey;
  }
  if (String(key).length !== 1) {
    throw new Error("key must be a single character or one of return, escape, space, tab, left, right, up, down");
  }
  await run("osascript", ["-e", `tell application "System Events" to keystroke ${JSON.stringify(String(key))}`]);
  return String(key);
}

const READING_GUIDE = {
  elixir: "Pink/purple bar along the bottom (0-10). A low count NEVER excuses skipping a defense.",
  hand: "Four cards at the bottom (slots 1-4, left→right) with elixir costs; next card queued to their left.",
  towers: "Your princess towers bottom-left/right, king bottom-center; opponent's mirrored at top. Damaged towers show HP.",
  lanes: "Troops cross at the left and right bridges (y≈0.45). Your half is y>0.5 — anything there must be answered NOW.",
  tip: "DEFEND EVERY THREAT before it reaches your tower (always worth the elixir), then counter-push and attack the weaker tower. Never hoard elixir or idle. Call the `strategy` tool for the full playbook.",
};

async function callTool(id, name, args = {}) {
  try {
    switch (name) {
      case "strategy": {
        return ok(id, PLAYBOOK);
      }

      case "observe_phone": {
        const info = await getWindowInfo(true);
        return ok(id, JSON.stringify({ ...info, readingGuide: READING_GUIDE }, null, 2));
      }

      case "capture_phone_screen": {
        const info = await getWindowInfo();
        if (!info.present || info.error) return errResult(id, info.error || "iPhone Mirroring unavailable");
        const rect = args.fullWindow ? info.window : info.phone;
        const file = artifactPath(cleanFilename(args.name, "clash-royale-screen.png"));
        await run("screencapture", ["-x", "-R", `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`, file]);
        return ok(id, `wrote ${file}`);
      }

      case "deploy_card": {
        const slot = Math.round(Number(args.slot));
        if (!(slot >= 1 && slot <= 4)) return errResult(id, "slot must be an integer 1-4");
        const info = await getWindowInfo();
        if (!info.present || info.error) return errResult(id, info.error || "iPhone Mirroring unavailable");
        await maybeActivate();
        const cardPoint = toScreen(info.phone, CARD_SLOT_X[slot - 1], 0.82);
        const dropPoint = toScreen(info.phone, args.x, args.y);
        await mouse("tap", [cardPoint.x, cardPoint.y]); // select the card
        await sleep(120);
        await mouse("tap", [dropPoint.x, dropPoint.y]); // place it
        return ok(id, JSON.stringify({
          deployed: { slot, at: { x: Number(args.x), y: Number(args.y) } },
          note: args.note || "",
        }));
      }

      case "tap": {
        const info = await getWindowInfo();
        if (!info.present || info.error) return errResult(id, info.error || "iPhone Mirroring unavailable");
        await maybeActivate();
        const point = toScreen(info.phone, args.x, args.y);
        await mouse("tap", [point.x, point.y]);
        return ok(id, JSON.stringify({ tapped: point, normalized: { x: Number(args.x), y: Number(args.y) }, note: args.note || "" }));
      }

      case "swipe": {
        const info = await getWindowInfo();
        if (!info.present || info.error) return errResult(id, info.error || "iPhone Mirroring unavailable");
        await maybeActivate();
        const from = toScreen(info.phone, args.fromX, args.fromY);
        const to = toScreen(info.phone, args.toX, args.toY);
        const durationMs = Number.isFinite(Number(args.durationMs)) ? Math.max(1, Number(args.durationMs)) : 250;
        const steps = Number.isFinite(Number(args.steps)) ? Math.max(2, Math.round(Number(args.steps))) : 12;
        await mouse("swipe", [from.x, from.y, to.x, to.y, durationMs, steps]);
        return ok(id, JSON.stringify({ swiped: { from, to, durationMs, steps }, note: args.note || "" }));
      }

      case "tap_preset": {
        const preset = PRESETS[String(args.target || "")];
        if (!preset) return errResult(id, `unknown preset: ${args.target}`);
        const info = await getWindowInfo();
        if (!info.present || info.error) return errResult(id, info.error || "iPhone Mirroring unavailable");
        await maybeActivate();
        const point = toScreen(info.phone, preset.x, preset.y);
        await mouse("tap", [point.x, point.y]);
        return ok(id, JSON.stringify({ target: args.target, preset, tapped: point }));
      }

      case "wait": {
        const ms = Math.max(0, Math.min(5000, Math.round(Number(args.ms) || 0)));
        await sleep(ms);
        return ok(id, JSON.stringify({ waited: ms, note: args.note || "" }));
      }

      case "press_key": {
        await maybeActivate(true);
        const sent = await keypress(args.key);
        return ok(id, JSON.stringify({ pressed: sent }));
      }

      default:
        return errResult(id, `unknown tool: ${name}`);
    }
  } catch (error) {
    return errResult(id, `${name || "tool"} failed: ${errorText(error)}`);
  }
}

// Warm the compiled mouse binary at startup so the first tap is already fast.
mouseBinary();

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
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "clash-royale-mcp", version: "0.3.0" },
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
