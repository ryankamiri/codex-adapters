import assert from "node:assert/strict";
import test from "node:test";
import { applyCliOverrides, formatMcpDiagnostic, parseHarnessCli } from "../../src/imessage-harness/main";
import { parseHarnessConfig } from "../../src/imessage-harness/config";

test("CLI mode override is explicit and narrowly parsed", () => {
  assert.deepEqual(parseHarnessCli([]), {});
  assert.deepEqual(parseHarnessCli(["--mode", "dry-run"]), { mode: "dry-run" });
  assert.deepEqual(parseHarnessCli(["--mode=auto-send"]), { mode: "auto-send" });
  assert.throws(() => parseHarnessCli(["--mode", "send"]), /exactly/);
  assert.throws(() => parseHarnessCli(["--sender", "+15551234567"]), /unknown/);
});

test("CLI mode is the only runtime override", () => {
  const base = parseHarnessConfig({ allowedSender: "+15551234567" });
  const overridden = applyCliOverrides(base, { mode: "auto-send" });
  assert.equal(overridden.mode, "auto-send");
  assert.equal(overridden.enabled, false);
  assert.equal(overridden.allowedSender, base.allowedSender);
});

test("MCP diagnostics expose lifecycle metadata without arguments, results, or message bodies", () => {
  const diagnostic = formatMcpDiagnostic("trusted", {
    v: 1,
    seq: 1,
    ts: 1,
    kind: "item",
    phase: "completed",
    itemType: "mcpToolCall",
    title: "messages-mcp.send_to_chat(...)",
    item: {
      type: "mcpToolCall",
      id: "call-1",
      server: "messages-mcp",
      tool: "send_to_chat",
      status: "completed",
      arguments: { chat_id: "private-chat", message: "private message body" },
      result: { content: [{ type: "text", text: "private result" }] },
    },
  } as any);

  assert.match(diagnostic ?? "", /messages-mcp/);
  assert.match(diagnostic ?? "", /send_to_chat/);
  assert.doesNotMatch(diagnostic ?? "", /private-chat|private message body|private result|arguments|result/);
});
