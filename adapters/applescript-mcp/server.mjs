#!/usr/bin/env node
// applescript-mcp — Codex Bodies adapter for macOS AppleScript automation.
// stdout is reserved for newline-delimited JSON-RPC; diagnostics go to stderr.

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, text) =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
const errResult = (id, text) =>
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError: true },
  });

const ARTIFACTS_DIR = path.resolve(process.env.ARTIFACTS_DIR || process.cwd());
const artifactPath = (name) => {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  return path.join(ARTIFACTS_DIR, name);
};

const TOOLS = [
  {
    name: "observe_frontmost",
    description:
      "Read the name of the frontmost macOS application and its front-window title. Call this before acting to understand which app and window currently have focus; it is read-only and safe anytime.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_applescript",
    description:
      "Run arbitrary AppleScript against live macOS applications. Use this to control an app, activate it by name, display a notification, inspect app-specific state, or perform any other AppleScript-supported action.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "Complete AppleScript source to execute.",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "capture_screenshot",
    description:
      "Capture the current macOS screen as a PNG artifact and return its absolute path. Use this to visually verify the desktop state or hand the result to another adapter.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Optional artifact filename; defaults to screenshot.png. Only a simple filename is accepted.",
        },
      },
    },
  },
];

const errorText = (error) => {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error?.message || String(error);
};

const debug = (event, details = {}) =>
  process.stderr.write(`[applescript-mcp] ${JSON.stringify({ event, ...details })}\n`);
const toolLabel = (name) => TOOLS.some((tool) => tool.name === name) ? name : "<unknown>";
const errorDetails = (error) => ({
  errorType: error?.name || "Error",
  ...(typeof error?.code === "string" || typeof error?.code === "number" ? { errorCode: error.code } : {}),
});

async function callTool(id, name, args = {}) {
  const tool = toolLabel(name);
  const startedAt = Date.now();
  let status = "completed";
  debug("tool_call_started", { tool });
  try {
    switch (name) {
      case "observe_frontmost": {
        const script = `tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  set appName to name of frontProcess
  set windowTitle to ""
  try
    set windowTitle to name of front window of frontProcess
  end try
  return appName & tab & windowTitle
end tell`;
        const { stdout } = await run("osascript", ["-e", script]);
        const output = stdout.replace(/\r?\n$/, "");
        const separator = output.indexOf("\t");
        const app = separator === -1 ? output : output.slice(0, separator);
        const window = separator === -1 ? "" : output.slice(separator + 1);
        return ok(id, JSON.stringify({ app, window }));
      }

      case "run_applescript": {
        if (typeof args.script !== "string" || args.script.trim() === "") {
          return errResult(id, "run_applescript requires a non-empty string argument: script");
        }
        const { stdout } = await run("osascript", ["-e", args.script]);
        return ok(id, stdout.replace(/\r?\n$/, ""));
      }

      case "capture_screenshot": {
        if (args.name !== undefined && typeof args.name !== "string") {
          return errResult(id, "capture_screenshot name must be a string");
        }
        let filename = args.name || "screenshot.png";
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) || filename === "." || filename === "..") {
          return errResult(id, "capture_screenshot name must be a simple filename without directories");
        }
        if (!filename.toLowerCase().endsWith(".png")) filename += ".png";
        const file = artifactPath(filename);
        await run("screencapture", ["-x", file]);
        return ok(id, `wrote ${file}`);
      }

      default:
        return errResult(id, `unknown tool: ${name}`);
    }
  } catch (error) {
    status = "failed";
    debug("tool_call_failed", { tool, ...errorDetails(error) });
    return errResult(id, `${name || "tool"} failed: ${errorText(error)}`);
  } finally {
    debug("tool_call_finished", { tool, status, durationMs: Date.now() - startedAt });
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
        serverInfo: { name: "applescript-mcp", version: "0.1.0" },
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
debug("ready", { transport: "stdio" });
