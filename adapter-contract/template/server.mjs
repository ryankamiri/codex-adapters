#!/usr/bin/env node
// <app>-mcp — adapter template (Codex Bodies).
//
// A stdio MCP server: newline-delimited JSON-RPC 2.0, one JSON object per line,
// no SDK. Copy this file to adapters/<app>-mcp/server.mjs and replace the TODO
// tools with real ones that drive your target app. Keep the observe_/action/capture_
// triad and the initialize / tools/list / tools/call handlers below.
//
// Contract: ../../adapter-contract/CONTRACT.md
//
// Rules that keep it compliant:
//   • stdout carries ONLY JSON-RPC. Send logs to stderr (console.error).
//   • Return errors as { isError:true } results — never throw/crash.
//   • capture_* tools write a file under ARTIFACTS_DIR and return its path.

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

// ── plumbing (leave as-is) ──────────────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, text) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
const errResult = (id, text) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || process.cwd();
const artifactPath = (name) => {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  return path.join(ARTIFACTS_DIR, name);
};

// ── tools ───────────────────────────────────────────────────────────────────
// TODO: replace these three stubs with the real toolkit for your app.
// Keep at least one observe_*, one action, and one capture_* (see the contract).
const TOOLS = [
  {
    name: "observe_state",
    description:
      "Read-only snapshot of the app's current state. Call this first to see what you're working with. Safe to call anytime; no side effects.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "perform_action",
    description:
      "TODO: an action that changes the app. Describe exactly what it does and when to use it — the agent picks tools from this text.",
    inputSchema: {
      type: "object",
      properties: { arg: { type: "string", description: "TODO: real parameters" } },
      required: ["arg"],
    },
  },
  {
    name: "capture_snapshot",
    description:
      "Capture the current state to a file in the artifacts directory and return its path. Use to persist a result or hand off to another app.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "artifact filename, e.g. snapshot.json" } },
      required: ["name"],
    },
  },
];

function callTool(id, name, args = {}) {
  switch (name) {
    case "observe_state":
      // TODO: query the live app and describe it.
      return ok(id, JSON.stringify({ status: "ok", note: "replace with real app state" }));

    case "perform_action":
      // TODO: drive the live app here.
      return ok(id, `did: ${args.arg ?? ""}`);

    case "capture_snapshot": {
      try {
        // TODO: capture real app state (blocks JSON, a PNG, etc.).
        const file = artifactPath(String(args.name || "snapshot.json"));
        fs.writeFileSync(file, JSON.stringify({ capturedAt: "TODO" }, null, 2));
        return ok(id, `wrote ${file}`);
      } catch (e) {
        return errResult(id, `capture failed: ${e?.message ?? e}`);
      }
    }

    default:
      return errResult(id, `unknown tool: ${name}`);
  }
}

// ── JSON-RPC loop (leave as-is) ─────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
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
        serverInfo: { name: "app-mcp", version: "0.1.0" }, // TODO: "<app>-mcp"
      },
    });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    callTool(id, params?.name, params?.arguments);
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} }); // answer anything else so the client never hangs
  }
});
