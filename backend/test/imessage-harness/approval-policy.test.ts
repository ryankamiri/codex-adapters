import assert from "node:assert/strict";
import test from "node:test";
import { createScopedApprovalPolicy, type ApprovalAuditEvent } from "../../src/imessage-harness/approval-policy";

test("allows only explicitly configured MCP servers and audits the task/tool", () => {
  const audit: ApprovalAuditEvent[] = [];
  const policy = createScopedApprovalPolicy({
    allowedMcpServers: ["obs-mcp"],
    getTaskId: () => "msg_123",
    onDecision: (event) => audit.push(event),
  });

  assert.deepEqual(policy("mcpServer/elicitation/request", { serverName: "obs-mcp", toolName: "record" }).response, {
    action: "accept",
    content: {},
  });
  assert.deepEqual(audit[0], {
    taskId: "msg_123",
    method: "mcpServer/elicitation/request",
    capability: "mcp",
    server: "obs-mcp",
    tool: "record",
    decision: "allow",
    reason: "MCP server is allowlisted",
  });

  assert.deepEqual(policy("mcpServer/elicitation/request", { serverName: "unknown-mcp" }).response, {
    action: "decline",
  });
  assert.equal(audit[1]?.decision, "deny");

  policy("mcpServer/elicitation/request", {
    serverName: "obs-mcp",
    message: 'Allow the OBS MCP server to run tool "stop_recording"?',
  });
  assert.equal(audit[2]?.tool, "stop_recording");
});

test("messages-mcp requires both a trusted-worker capability and explicit allowlisting", () => {
  const policy = createScopedApprovalPolicy({ allowedMcpServers: ["messages-mcp"] });
  const denied = policy("mcpServer/elicitation/request", { serverName: "messages-mcp", toolName: "send_to_chat" });
  assert.deepEqual(denied.response, { action: "decline" });
  assert.match(denied.describe, /disabled for this worker/);

  const trustedPolicy = createScopedApprovalPolicy({
    allowedMcpServers: ["messages-mcp"],
    allowMessagesMcp: true,
  });
  const allowed = trustedPolicy("mcpServer/elicitation/request", {
    serverName: "messages-mcp",
    toolName: "send_to_chat",
  });
  assert.deepEqual(allowed.response, { action: "accept", content: {} });
  assert.match(allowed.describe, /allowlisted for a trusted-sender task/);

  const notAllowlisted = createScopedApprovalPolicy({ allowedMcpServers: [], allowMessagesMcp: true });
  assert.deepEqual(
    notAllowlisted("mcpServer/elicitation/request", { serverName: "messages-mcp" }).response,
    { action: "decline" },
  );
});

test("shell, file, permissions, user-input, and unknown requests fail closed by default", () => {
  const policy = createScopedApprovalPolicy({ allowedMcpServers: [] });
  assert.deepEqual(policy("item/commandExecution/requestApproval", { command: "rm anything" }).response, { decision: "decline" });
  assert.deepEqual(policy("item/fileChange/requestApproval", {}).response, { decision: "decline" });
  assert.deepEqual(policy("execCommandApproval", {}).response, { decision: "denied" });
  assert.deepEqual(policy("applyPatchApproval", {}).response, { decision: "denied" });
  assert.deepEqual(policy("item/permissions/requestApproval", {}).response, { permissions: {}, scope: "turn" });
  assert.deepEqual(policy("item/tool/requestUserInput", {}).response, { answers: {} });
  assert.deepEqual(policy("future/approval", {}).response, {});
});

test("shell and file changes require their independent explicit flags", () => {
  const shellOnly = createScopedApprovalPolicy({ allowedMcpServers: [], allowShellCommands: true });
  assert.deepEqual(shellOnly("item/commandExecution/requestApproval", {}).response, { decision: "accept" });
  assert.deepEqual(shellOnly("item/fileChange/requestApproval", {}).response, { decision: "decline" });

  const fileOnly = createScopedApprovalPolicy({ allowedMcpServers: [], allowFileChanges: true });
  assert.deepEqual(fileOnly("item/commandExecution/requestApproval", {}).response, { decision: "decline" });
  assert.deepEqual(fileOnly("item/fileChange/requestApproval", {}).response, { decision: "accept" });
});
