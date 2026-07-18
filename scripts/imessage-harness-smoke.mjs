#!/usr/bin/env node
// Read-only preflight. This never starts Codex and never calls a sending tool.

import { spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cwd = process.cwd();
const configPath = path.resolve(cwd, process.env.IMESSAGE_HARNESS_CONFIG || "config/imessage-harness.json");
const messagesPath = path.resolve(
  process.env.IMESSAGE_HARNESS_MESSAGES_DB || path.join(os.homedir(), "Library/Messages/chat.db"),
);

const info = await stat(configPath);
if ((info.mode & 0o077) !== 0) throw new Error(`config is not private; run chmod 600 ${configPath}`);
const config = JSON.parse(await readFile(configPath, "utf8"));
const allowedSenders = config.allowedSenders ?? (config.allowedSender ? [config.allowedSender] : []);
if (!Array.isArray(allowedSenders) || allowedSenders.length === 0 || allowedSenders.some((sender) => !/^\+[1-9]\d{7,14}$/.test(sender))) {
  throw new Error("allowedSenders must contain strict E.164 numbers");
}
if (config.mode !== "dry-run" && config.mode !== "auto-send") throw new Error("invalid harness mode");
await access(messagesPath);

const adapterPath = path.join(cwd, "adapters/messages-mcp/server.mjs");
const child = spawn(process.execPath, [adapterPath], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});

const rpc = (id, method, params = undefined) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${method} timed out`));
  }, 2_000);
  pending.set(id, (response) => {
    clearTimeout(timer);
    if (response.error) reject(new Error(response.error.message || `${method} failed`));
    else resolve(response.result);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
});

try {
  await rpc(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "imessage-harness-smoke", version: "0.1.0" },
  });
  const listed = await rpc(2, "tools/list");
  if (!listed.tools?.some((tool) => tool.name === "send_to_chat")) {
    throw new Error("messages-mcp does not expose send_to_chat");
  }
  process.stdout.write(
    `iMessage harness preflight passed (enabled=${Boolean(config.enabled)}, mode=${config.mode}, trusted_senders=${allowedSenders.length})\n`,
  );
} finally {
  child.kill();
}
