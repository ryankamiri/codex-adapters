import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

const serverPath = path.resolve("adapters/imessage-listener-mcp/server.mjs");

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "imessage-listener-mcp-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  mkdirSync(path.join(root, "backend/src/imessage-harness"), { recursive: true });
  mkdirSync(path.join(root, "node_modules/tsx/dist"), { recursive: true });
  writeFileSync(path.join(root, "config/imessage-harness.example.json"), JSON.stringify({
    enabled: false,
    allowedSenders: ["+15551234567"],
    service: "iMessage",
    allowedMcpServers: [],
    allowShell: false,
    allowFileChanges: false,
    pollIntervalMs: 1000,
    debounceMs: 1500,
    maxTaskRuntimeMs: 60000,
    maxReplyCharacters: 1500,
    maxQueuedTasks: 20,
    sendAcknowledgement: false,
    mode: "dry-run",
  }));
  writeFileSync(path.join(root, "backend/src/imessage-harness/main.ts"), "// fake entrypoint\n");
  writeFileSync(path.join(root, "node_modules/tsx/dist/cli.mjs"), "process.on('SIGHUP', () => {}); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);\n");
  return root;
}

function startServer(root) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      IMESSAGE_HARNESS_REPO: root,
      IMESSAGE_HARNESS_CONTROL_DIR: path.join(root, "control"),
      ARTIFACTS_DIR: path.join(root, "artifacts"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let id = 0;
  return {
    child,
    async rpc(method, params) {
      const requestId = id++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, ...(params ? { params } : {}) })}\n`);
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error("adapter exited before replying");
        const response = JSON.parse(next.value);
        if (response.id === requestId) return response;
      }
    },
  };
}

function resultJson(response) {
  assert.equal(response.result.isError, undefined);
  return JSON.parse(response.result.content[0].text);
}

test("manages trusted senders and listener lifecycle through constrained tools", async () => {
  const root = fixture();
  const server = startServer(root);
  try {
    const initialized = await server.rpc("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(initialized.result.serverInfo.name, "imessage-listener-mcp");
    const listed = await server.rpc("tools/list");
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
      "observe_listener", "start_listener", "stop_listener", "add_allowed_senders",
      "remove_allowed_senders", "set_allowed_senders", "capture_listener_state",
    ]);

    let status = resultJson(await server.rpc("tools/call", { name: "add_allowed_senders", arguments: { numbers: ["+15557654321"] } }));
    assert.deepEqual(status.allowedSenders, ["+15551234567", "+15557654321"]);
    status = resultJson(await server.rpc("tools/call", { name: "start_listener", arguments: {} }));
    assert.equal(status.running, true);
    assert.equal(status.mode, "auto-send");
    const runningPid = status.pid;

    status = resultJson(await server.rpc("tools/call", { name: "start_listener", arguments: { dry_run: true } }));
    assert.equal(status.running, true);
    assert.equal(status.mode, "dry-run");
    assert.equal(status.pid, runningPid);

    status = resultJson(await server.rpc("tools/call", { name: "start_listener", arguments: {} }));
    assert.equal(status.running, true);
    assert.equal(status.mode, "auto-send");
    assert.equal(status.pid, runningPid);

    status = resultJson(await server.rpc("tools/call", { name: "set_allowed_senders", arguments: { numbers: ["+15550001111"] } }));
    assert.equal(status.running, true);
    assert.deepEqual(status.allowedSenders, ["+15550001111"]);
    const invalid = await server.rpc("tools/call", { name: "remove_allowed_senders", arguments: { numbers: ["+15550001111"] } });
    assert.equal(invalid.result.isError, true);

    const capture = await server.rpc("tools/call", { name: "capture_listener_state", arguments: {} });
    const output = capture.result.content[0].text.replace(/^wrote /, "");
    assert.equal(JSON.parse(readFileSync(output, "utf8")).running, true);

    status = resultJson(await server.rpc("tools/call", { name: "stop_listener", arguments: {} }));
    assert.equal(status.enabled, false);
    assert.equal(status.stopRequested, true);
    const saved = JSON.parse(readFileSync(path.join(root, "config/imessage-harness.json"), "utf8"));
    assert.deepEqual(saved.allowedSenders, ["+15550001111"]);
    assert.equal(saved.enabled, false);
    assert.equal(saved.allowedSender, undefined);
  } finally {
    server.child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
