#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import readline from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, value) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] } });
const fail = (id, error) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true } });

const REPO_ROOT = path.resolve(process.env.IMESSAGE_HARNESS_REPO || path.join(import.meta.dirname, "../.."));
const CONFIG_PATH = path.resolve(process.env.IMESSAGE_HARNESS_CONFIG || path.join(REPO_ROOT, "config/imessage-harness.json"));
const EXAMPLE_CONFIG_PATH = path.join(REPO_ROOT, "config/imessage-harness.example.json");
const STATE_DIR = path.resolve(process.env.IMESSAGE_HARNESS_CONTROL_DIR || path.join(REPO_ROOT, "data/imessage-harness/control"));
const PID_PATH = path.join(STATE_DIR, "listener.json");
const LOG_PATH = path.join(STATE_DIR, "listener.log");

const debug = (event, details = {}) =>
  process.stderr.write(`[imessage-listener-mcp] ${JSON.stringify({ event, ...details })}\n`);
const MAIN_PATH = path.join(REPO_ROOT, "backend/src/imessage-harness/main.ts");
const TSX_PATH = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const E164 = /^\+[1-9]\d{7,14}$/;

const TOOLS = [
  {
    name: "observe_listener",
    description: "Inspect whether the local iMessage listener is running and list its trusted E.164 senders. This is read-only and should be called before changing listener state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "start_listener",
    description: "Enable and start the local iMessage-to-Codex listener. Automatic replies are the default; pass dry_run=true only when the user explicitly requests a no-send test.",
    inputSchema: {
      type: "object",
      properties: { dry_run: { type: "boolean", description: "When true, execute tasks but do not send replies. When false, enable automatic replies." } },
    },
  },
  {
    name: "stop_listener",
    description: "Disable the iMessage listener kill switch and stop its managed process. Use when the user asks Codex to stop listening or stop automatic replies.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_allowed_senders",
    description: "Add one or more trusted phone numbers to the listener allowlist. Numbers must be strict E.164, such as +15551234567. A running listener reloads the change immediately.",
    inputSchema: {
      type: "object",
      properties: { numbers: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["numbers"],
    },
  },
  {
    name: "remove_allowed_senders",
    description: "Remove trusted phone numbers from the listener allowlist. At least one trusted number must remain. A running listener reloads the change immediately.",
    inputSchema: {
      type: "object",
      properties: { numbers: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["numbers"],
    },
  },
  {
    name: "set_allowed_senders",
    description: "Replace the complete trusted-number allowlist with the supplied strict E.164 numbers. A running listener reloads the change immediately.",
    inputSchema: {
      type: "object",
      properties: { numbers: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["numbers"],
    },
  },
  {
    name: "capture_listener_state",
    description: "Write a redacted JSON snapshot of listener status and trusted numbers under ARTIFACTS_DIR, returning the artifact path.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Optional JSON filename." } } },
  },
];

function ensureControlDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function strictNumbers(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((number) => typeof number !== "string" || !E164.test(number))) {
    throw new Error("numbers must be a non-empty array of strict E.164 phone numbers");
  }
  return [...new Set(value)];
}

function readConfig({ create = false } = {}) {
  if (!existsSync(CONFIG_PATH)) {
    if (!create) return null;
    if (!existsSync(EXAMPLE_CONFIG_PATH)) throw new Error(`missing example config: ${EXAMPLE_CONFIG_PATH}`);
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
    const initial = JSON.parse(readFileSync(EXAMPLE_CONFIG_PATH, "utf8"));
    atomicWriteConfig(initial);
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const numbers = config.allowedSenders ?? (config.allowedSender ? [config.allowedSender] : []);
  return { ...config, allowedSenders: strictNumbers(numbers) };
}

function atomicWriteConfig(config) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const normalized = { ...config };
  delete normalized.allowedSender;
  normalized.allowedSenders = strictNumbers(normalized.allowedSenders);
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, CONFIG_PATH);
  chmodSync(CONFIG_PATH, 0o600);
}

function readManagedProcess() {
  if (!existsSync(PID_PATH)) return null;
  try {
    const record = JSON.parse(readFileSync(PID_PATH, "utf8"));
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return null;
    process.kill(record.pid, 0);
    const command = execFileSync("/bin/ps", ["-p", String(record.pid), "-o", "command="], { encoding: "utf8" }).trim();
    if (!command.includes(MAIN_PATH)) return null;
    return { ...record, command };
  } catch {
    rmSync(PID_PATH, { force: true });
    return null;
  }
}

function listenerStatus() {
  const config = readConfig();
  const managed = readManagedProcess();
  return {
    running: Boolean(managed),
    pid: managed?.pid ?? null,
    startedAt: managed?.startedAt ?? null,
    enabled: Boolean(config?.enabled),
    mode: managed?.mode ?? config?.mode ?? null,
    allowedSenders: config?.allowedSenders ?? [],
    configExists: Boolean(config),
    configPath: CONFIG_PATH,
    logPath: LOG_PATH,
  };
}

async function startListener({ dryRun } = {}) {
  const mode = dryRun === true ? "dry-run" : "auto-send";
  const existing = readManagedProcess();
  if (existing) {
    const config = readConfig({ create: true });
    atomicWriteConfig({ ...config, enabled: true, mode });
    writeFileSync(PID_PATH, `${JSON.stringify({
      pid: existing.pid,
      startedAt: existing.startedAt,
      mode,
      mainPath: MAIN_PATH,
    }, null, 2)}\n`, { mode: 0o600 });
    process.kill(existing.pid, "SIGHUP");
    return listenerStatus();
  }
  if (!existsSync(MAIN_PATH) || !existsSync(TSX_PATH)) throw new Error("listener runtime is not installed in the configured repository");
  const config = readConfig({ create: true });
  const next = { ...config, enabled: true, mode };
  atomicWriteConfig(next);
  ensureControlDir();
  const logFd = openSync(LOG_PATH, "a", 0o600);
  const child = spawn(process.execPath, [TSX_PATH, MAIN_PATH, "--mode", mode], {
    cwd: REPO_ROOT,
    env: { ...process.env, IMESSAGE_HARNESS_CONFIG: CONFIG_PATH },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  if (!child.pid) throw new Error("listener process failed to start");
  child.unref();
  writeFileSync(PID_PATH, `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), mode, mainPath: MAIN_PATH }, null, 2)}\n`, { mode: 0o600 });
  // Let the harness finish startup and install its SIGHUP/SIGTERM handlers before
  // another management tool can immediately reload or stop it.
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (!readManagedProcess()) throw new Error(`listener exited during startup; inspect ${LOG_PATH}`);
  return listenerStatus();
}

function stopListener() {
  const config = readConfig();
  if (config) atomicWriteConfig({ ...config, enabled: false });
  const managed = readManagedProcess();
  if (managed) {
    try {
      process.kill(managed.pid, "SIGTERM");
    } catch {}
  }
  rmSync(PID_PATH, { force: true });
  return { ...listenerStatus(), stopRequested: Boolean(managed) };
}

function updateAllowedSenders(operation, supplied) {
  const numbers = strictNumbers(supplied);
  const managed = readManagedProcess();
  const config = readConfig({ create: true });
  const current = config.allowedSenders;
  let next;
  if (operation === "add") next = [...new Set([...current, ...numbers])];
  else if (operation === "remove") next = current.filter((number) => !numbers.includes(number));
  else next = numbers;
  if (next.length === 0) throw new Error("at least one allowed sender must remain");
  atomicWriteConfig({ ...config, allowedSenders: next });
  if (managed) process.kill(managed.pid, "SIGHUP");
  return listenerStatus();
}

function captureState(name) {
  const artifactsDir = path.resolve(process.env.ARTIFACTS_DIR || path.join(REPO_ROOT, "data/artifacts"));
  mkdirSync(artifactsDir, { recursive: true });
  const safeName = typeof name === "string" && /^[A-Za-z0-9._-]+\.json$/.test(name) ? name : "imessage-listener-state.json";
  const output = path.join(artifactsDir, safeName);
  writeFileSync(output, `${JSON.stringify({ capturedAt: new Date().toISOString(), ...listenerStatus() }, null, 2)}\n`);
  return output;
}

async function callTool(id, name, args = {}) {
  const tool = TOOLS.some((candidate) => candidate.name === name) ? name : "<unknown>";
  const startedAt = Date.now();
  let status = "completed";
  debug("tool_call_started", { tool });
  try {
    switch (name) {
      case "observe_listener": return ok(id, listenerStatus());
      case "start_listener": return ok(id, await startListener({ dryRun: args.dry_run }));
      case "stop_listener": return ok(id, stopListener());
      case "add_allowed_senders": return ok(id, updateAllowedSenders("add", args.numbers));
      case "remove_allowed_senders": return ok(id, updateAllowedSenders("remove", args.numbers));
      case "set_allowed_senders": return ok(id, updateAllowedSenders("set", args.numbers));
      case "capture_listener_state": return ok(id, `wrote ${captureState(args.name)}`);
      default: return fail(id, `unknown tool: ${name}`);
    }
  } catch (error) {
    status = "failed";
    debug("tool_call_failed", {
      tool,
      errorType: error?.name || "Error",
      ...(typeof error?.code === "string" || typeof error?.code === "number" ? { errorCode: error.code } : {}),
    });
    return fail(id, error);
  } finally {
    debug("tool_call_finished", { tool, status, durationMs: Date.now() - startedAt });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (method === "initialize") {
    debug("client_initialized");
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "imessage-listener-mcp", version: "0.1.0" } } });
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
debug("ready", { transport: "stdio", workerLog: LOG_PATH });
