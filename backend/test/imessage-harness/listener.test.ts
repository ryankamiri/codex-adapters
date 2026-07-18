import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteHarnessLedger } from "../../src/imessage-harness/ledger";
import { ImessageListener, normalizeE164 } from "../../src/imessage-harness/listener";
import { SqliteMessagesStore } from "../../src/imessage-harness/messages-store";
import { appendFixtureMessage, createMessagesFixture } from "./fixtures/messages-fixture";

test("normalizes formatting but requires an explicit E.164 country code", () => {
  assert.equal(normalizeE164(" +1 (555) 123-4567 "), "+15551234567");
  assert.equal(normalizeE164("5551234567"), null);
  assert.equal(normalizeE164("person@example.com"), null);
});

test("first poll establishes a watermark and never queues historical messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "listener-"));
  try {
    const messagesPath = join(dir, "chat.db");
    const writer = createMessagesFixture(messagesPath);
    appendFixtureMessage(writer, { guid: "historical", text: "do not run", sender: "+15551234567" });
    const store = new SqliteMessagesStore(messagesPath);
    const ledger = new SqliteHarnessLedger(join(dir, "ledger.db"));
    const listener = new ImessageListener({ store, ledger, allowedSender: "+15551234567" });

    assert.deepEqual(await listener.pollOnce(), {
      initialized: true, watermark: 1, scanned: 0, queued: 0, filtered: 0, duplicates: 0,
    });
    assert.equal(await ledger.claimNextQueued(), null);

    appendFixtureMessage(writer, { guid: "new", text: "  preserve me exactly  ", sender: "+1 (555) 123-4567" });
    const result = await listener.pollOnce();
    assert.equal(result.queued, 1);
    const task = await ledger.claimNextQueued();
    assert.equal(task?.inbound.text, "  preserve me exactly  ");
    assert.equal(task?.inbound.sender, "+15551234567");
    assert.equal(task?.inbound.chatId, "iMessage;-;+1 (555) 123-4567");

    ledger.close();
    store.close();
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routes unknown senders while filtering outbound, group, attachment and reaction rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "listener-"));
  try {
    const messagesPath = join(dir, "chat.db");
    const writer = createMessagesFixture(messagesPath);
    const store = new SqliteMessagesStore(messagesPath);
    const ledger = new SqliteHarnessLedger(join(dir, "ledger.db"));
    const listener = new ImessageListener({ store, ledger, allowedSender: "+15551234567", batchSize: 2 });
    await listener.pollOnce();

    appendFixtureMessage(writer, { guid: "wrong", text: "x", sender: "+15550000000" });
    appendFixtureMessage(writer, { guid: "out", text: "x", sender: "+15551234567", isFromMe: true });
    appendFixtureMessage(writer, { guid: "group", text: "x", sender: "+15551234567", chatGuid: "group", participants: ["+15551234567", "+15557654321"], style: 43 });
    appendFixtureMessage(writer, { guid: "attachment", text: "x", sender: "+15551234567", attachments: true });
    appendFixtureMessage(writer, { guid: "reaction", text: "x", sender: "+15551234567", associatedMessageType: 2000 });
    appendFixtureMessage(writer, { guid: "valid", text: "run", sender: "+15551234567" });

    const result = await listener.pollOnce();
    assert.deepEqual({ scanned: result.scanned, queued: result.queued, filtered: result.filtered }, { scanned: 6, queued: 2, filtered: 4 });
    assert.equal(ledger.getListenerCursor(), 6);
    const unknown = await ledger.claimNextQueued();
    assert.equal(unknown?.inbound.guid, "wrong");
    assert.equal(unknown?.inbound.kind, "conversation_reply");
    assert.deepEqual(unknown?.inbound.context?.map((message) => message.text), ["x"]);
    const trusted = await ledger.claimNextQueued();
    assert.equal(trusted?.inbound.guid, "valid");
    assert.equal(trusted?.inbound.kind, "trusted_prompt");
    assert.equal(await ledger.claimNextQueued(), null);

    ledger.close();
    store.close();
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown senders receive at most five messages from the preceding five-minute chat window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "listener-context-"));
  try {
    const messagesPath = join(dir, "chat.db");
    const writer = createMessagesFixture(messagesPath);
    const sender = "+15550000000";
    appendFixtureMessage(writer, { guid: "c1", text: "one", sender, date: 100 });
    appendFixtureMessage(writer, { guid: "c2", text: "two", sender, date: 160 });
    appendFixtureMessage(writer, { guid: "c3", text: "three", sender, date: 220, isFromMe: true });
    appendFixtureMessage(writer, { guid: "c4", text: "four", sender, date: 280 });
    appendFixtureMessage(writer, { guid: "c5", text: "five", sender, date: 340 });
    const store = new SqliteMessagesStore(messagesPath);
    const ledger = new SqliteHarnessLedger(join(dir, "ledger.db"));
    const listener = new ImessageListener({ store, ledger, allowedSenders: ["+15551234567"] });
    await listener.pollOnce();
    appendFixtureMessage(writer, { guid: "current", text: "six", sender, date: 400 });
    assert.equal((await listener.pollOnce()).queued, 1);
    const queued = await ledger.claimNextQueued();
    assert.equal(queued?.inbound.kind, "conversation_reply");
    assert.deepEqual(queued?.inbound.context?.map((message) => message.text), ["two", "three", "four", "five", "six"]);
    assert.equal(queued?.inbound.context?.[1].isFromMe, true);
    ledger.close();
    store.close();
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GUID uniqueness prevents duplicate tasks across a new database cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "listener-"));
  try {
    const messagesPath = join(dir, "chat.db");
    const writer = createMessagesFixture(messagesPath);
    const store = new SqliteMessagesStore(messagesPath);
    const ledger = new SqliteHarnessLedger(join(dir, "ledger.db"));
    const listener = new ImessageListener({ store, ledger, allowedSender: "+15551234567" });
    await listener.pollOnce();
    appendFixtureMessage(writer, { guid: "same-guid", text: "first", sender: "+15551234567" });
    appendFixtureMessage(writer, { guid: "same-guid", text: "second", sender: "+15551234567", chatGuid: "second-chat" });
    const result = await listener.pollOnce();
    assert.equal(result.queued, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(ledger.getListenerCursor(), 2);
    assert.equal((await ledger.claimNextQueued())?.inbound.text, "first");
    assert.equal(await ledger.claimNextQueued(), null);
    ledger.close();
    store.close();
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger outbox is idempotent and recovers ambiguous sends as uncertain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  try {
    const messagesPath = join(dir, "chat.db");
    const writer = createMessagesFixture(messagesPath);
    const store = new SqliteMessagesStore(messagesPath);
    const ledger = new SqliteHarnessLedger(join(dir, "ledger.db"));
    const listener = new ImessageListener({ store, ledger, allowedSender: "+15551234567" });
    await listener.pollOnce();
    appendFixtureMessage(writer, { guid: "outbox-guid", text: "run", sender: "+15551234567" });
    await listener.pollOnce();
    const task = await ledger.claimNextQueued();
    assert.ok(task);
    const prepared = await ledger.completeTaskAndPrepareReply({
      taskId: task.taskId,
      inboundGuid: task.inbound.guid,
      chatId: task.inbound.chatId,
      reply: "done",
    });
    const duplicate = await ledger.completeTaskAndPrepareReply({
      taskId: task.taskId,
      inboundGuid: task.inbound.guid,
      chatId: task.inbound.chatId,
      reply: "different response must not create a second send",
    });
    assert.equal(duplicate.id, prepared.id);
    const sending = await ledger.claimNextPreparedReply();
    assert.equal(sending?.attempts, 1);
    assert.equal(await ledger.recoverSendingReplies(), 1);
    assert.equal(await ledger.claimNextPreparedReply(), null);
    ledger.close();
    store.close();
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queue capacity fails closed and approval decisions are durably auditable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  try {
    const messagesPath = join(dir, "chat.db");
    const writer = createMessagesFixture(messagesPath);
    const store = new SqliteMessagesStore(messagesPath);
    const ledger = new SqliteHarnessLedger(join(dir, "ledger.db"));
    const listener = new ImessageListener({
      store,
      ledger,
      allowedSender: "+15551234567",
      maxQueuedTasks: 1,
    });
    await listener.pollOnce();
    appendFixtureMessage(writer, { guid: "first", text: "one", sender: "+15551234567" });
    appendFixtureMessage(writer, { guid: "second", text: "two", sender: "+15551234567" });
    const result = await listener.pollOnce();
    assert.equal(result.queued, 1);
    assert.equal(result.filtered, 1);
    assert.equal(ledger.getQueuedTaskCount(), 1);

    const claimed = await ledger.claimNextQueued();
    assert.ok(claimed);
    ledger.recordApprovalDecision({
      taskId: claimed.taskId,
      method: "mcpServer/elicitation/request",
      capability: "mcp",
      server: "obs-mcp",
      tool: "record",
      decision: "allow",
      reason: "MCP server is allowlisted",
    });
    assert.deepEqual(ledger.listApprovalDecisions(claimed.taskId), [{
      method: "mcpServer/elicitation/request",
      capability: "mcp",
      server: "obs-mcp",
      tool: "record",
      decision: "allow",
      reason: "MCP server is allowlisted",
    }]);
    ledger.close();
    store.close();
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
