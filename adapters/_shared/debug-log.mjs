// Shared verbose debug logging for MCP adapters.
//
// HARD RULE: never write to stdout. stdout carries newline-delimited JSON-RPC, and
// a single stray byte there desynchronizes the transport and kills the server. All
// output goes to stderr (which the host forwards to its own stderr) and to a log
// file so a session can be inspected after the fact.
//
// Logging must also never break the adapter: every function here swallows its own
// errors. A broken log line is a nuisance; a thrown exception mid-tool-call is a
// transport failure.
//
// Env:
//   ADAPTER_DEBUG=0        disable entirely (default: enabled)
//   ADAPTER_DEBUG_STDERR=0 keep the file log but stop mirroring to stderr
//   ADAPTER_LOG_DIR=<dir>  where to write (default: <tmp>/codex-adapter-logs)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ENABLED = process.env.ADAPTER_DEBUG !== "0";
const TO_STDERR = process.env.ADAPTER_DEBUG_STDERR !== "0";
const LOG_DIR = process.env.ADAPTER_LOG_DIR || path.join(os.tmpdir(), "codex-adapter-logs");

const MAX_FIELD = 2000; // cap any single stringified value
const MAX_LINE = 16000; // cap the whole line

// Keys whose values are secrets rather than debugging signal. Message bodies are
// deliberately NOT redacted — they are usually the thing being debugged — so treat
// these logs as sensitive and keep them out of shared artifact directories.
const SECRET_KEY = /^(authorization|password|passwd|secret|token|api[_-]?key|cookie)$/i;

function truncate(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return String(value);
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…[+${s.length - MAX_FIELD} chars]` : s;
}

function sanitize(data) {
  if (data === null || data === undefined) return data;
  if (typeof data !== "object") return truncate(data);
  if (Array.isArray(data)) return data.slice(0, 50).map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_KEY.test(k)) {
      out[k] = "[redacted]";
    } else if (v && typeof v === "object") {
      out[k] = sanitize(v);
    } else {
      out[k] = truncate(v);
    }
  }
  return out;
}

export function createLogger(serverName) {
  let stream = null;
  let logPath = null;

  if (ENABLED) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      logPath = path.join(LOG_DIR, `${serverName}.log`);
      stream = fs.createWriteStream(logPath, { flags: "a", mode: 0o600 });
      stream.on("error", () => {
        stream = null; // disk problem: degrade to stderr instead of throwing
      });
    } catch {
      stream = null;
    }
  }

  const emit = (level, event, data) => {
    if (!ENABLED) return;
    try {
      const record = {
        ts: new Date().toISOString(),
        pid: process.pid,
        server: serverName,
        level,
        event,
        ...(data === undefined ? {} : { data: sanitize(data) }),
      };
      let line = JSON.stringify(record);
      if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}…"}`;
      if (stream) stream.write(`${line}\n`);
      if (TO_STDERR) process.stderr.write(`${line}\n`);
    } catch {
      // logging must never take down the adapter
    }
  };

  const log = {
    path: logPath,
    debug: (event, data) => emit("debug", event, data),
    info: (event, data) => emit("info", event, data),
    warn: (event, data) => emit("warn", event, data),
    error: (event, data) => {
      // Errors carry stacks; unwrap them into something serializable.
      if (data instanceof Error) {
        emit("error", event, { message: data.message, stack: data.stack, stderr: data.stderr });
      } else {
        emit("error", event, data);
      }
    },

    // Time a span: const done = log.time('tool.call', {...}); ... done({ok:true})
    time: (event, data) => {
      const startedAt = Date.now();
      emit("debug", `${event}.start`, data);
      return (extra) => {
        emit("debug", `${event}.end`, { ...(extra || {}), durationMs: Date.now() - startedAt });
        return Date.now() - startedAt;
      };
    },
  };

  log.info("server.boot", {
    argv: process.argv.slice(1),
    node: process.version,
    cwd: process.cwd(),
    logPath,
  });

  // Surface the failures that would otherwise vanish and look like "transport closed".
  process.on("uncaughtException", (err) => {
    log.error("process.uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("process.unhandledRejection", reason instanceof Error ? reason : { reason });
  });
  process.on("exit", (code) => log.info("process.exit", { code }));

  return log;
}
