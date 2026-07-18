import assert from "node:assert/strict";
import test from "node:test";
import {
  boundReply,
  MessagesMcpClient,
  ReplyDelivery,
  type SendToChatClient,
} from "../../src/imessage-harness/reply-delivery";

test("dry-run prepares a bounded reply without invoking Messages", async () => {
  let called = false;
  const client: SendToChatClient = {
    async sendToChat() { called = true; },
  };
  const delivery = new ReplyDelivery({ mode: "dry-run", maxReplyCharacters: 30, client });
  const result = await delivery.deliver("iMessage;+;chat123", "x".repeat(100));
  assert.equal(result.state, "dry_run");
  assert.equal(result.message.length, 30);
  assert.match(result.message, /\[Reply truncated\]$/);
  assert.equal(called, false);
});

test("auto-send uses the exact original chat id and bounded text", async () => {
  const calls: unknown[][] = [];
  const client: SendToChatClient = {
    async sendToChat(...args) { calls.push(args); },
  };
  const delivery = new ReplyDelivery({ mode: "auto-send", maxReplyCharacters: 25, timeoutMs: 42, client });
  const result = await delivery.deliver("original-chat", "a".repeat(100));
  assert.equal(result.state, "sent");
  assert.deepEqual(calls, [["original-chat", boundReply("a".repeat(100), 25), 42]]);
});

test("delivery mode can be reloaded without restarting the listener", async () => {
  const calls: unknown[][] = [];
  const client: SendToChatClient = {
    async sendToChat(...args) { calls.push(args); },
  };
  const delivery = new ReplyDelivery({ mode: "dry-run", maxReplyCharacters: 100, client });

  assert.equal((await delivery.deliver("chat", "first")).state, "dry_run");
  delivery.setMode("auto-send");
  assert.equal((await delivery.deliver("chat", "second")).state, "sent");
  assert.deepEqual(calls, [["chat", "second", 30_000]]);
});

test("any ambiguous auto-send failure is uncertain and never retried", async () => {
  let attempts = 0;
  const client: SendToChatClient = {
    async sendToChat() {
      attempts += 1;
      throw new Error("timeout");
    },
  };
  const delivery = new ReplyDelivery({ mode: "auto-send", maxReplyCharacters: 100, client });
  assert.equal((await delivery.deliver("chat", "reply")).state, "send_uncertain");
  assert.equal(attempts, 1);
});

test("direct MCP client calls only send_to_chat with the supplied chat", async () => {
  const fakeMcp = String.raw`
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26" } }) + "\n");
      } else if (request.method === "tools/call") {
        const valid = request.params.name === "send_to_chat"
          && request.params.arguments.chat_id === "original-chat"
          && request.params.arguments.message === "exact reply";
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { isError: !valid, content: [{ type: "text", text: valid ? "ok" : "bad request" }] } }) + "\n");
      }
    });
  `;
  const client = new MessagesMcpClient({ command: process.execPath, args: ["-e", fakeMcp] });
  await client.sendToChat("original-chat", "exact reply", 2_000);
});

test("direct MCP stderr is sent only to the developer diagnostic callback", async () => {
  const fakeMcp = String.raw`
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const request = JSON.parse(line);
      process.stderr.write("debug: " + request.method + "\n");
      if (request.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\n");
      } else if (request.method === "tools/call") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { isError: false } }) + "\n");
      }
    });
  `;
  const diagnostics: string[] = [];
  const client = new MessagesMcpClient({
    command: process.execPath,
    args: ["-e", fakeMcp],
    onStderr: (chunk) => diagnostics.push(chunk),
  });

  await client.sendToChat("original-chat", "exact reply", 2_000);

  assert.match(diagnostics.join(""), /debug: initialize/);
  assert.match(diagnostics.join(""), /debug: tools\/call/);
});
