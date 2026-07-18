import assert from "node:assert/strict";
import test from "node:test";
import type { ImessageHarnessConfig } from "../../src/imessage-harness/config";
import { ImessageHarnessService, type HarnessServiceStore } from "../../src/imessage-harness/service";
import type { ClaimedTask, ListenerPollResult, OutboxRecord } from "../../src/imessage-harness/types";

const config: ImessageHarnessConfig = {
  enabled: true,
  allowedSender: "+15551234567",
  allowedSenders: ["+15551234567"],
  service: "iMessage",
  allowedMcpServers: [],
  allowShell: false,
  allowFileChanges: false,
  pollIntervalMs: 1_000,
  debounceMs: 1_500,
  maxTaskRuntimeMs: 60_000,
  maxReplyCharacters: 1_500,
  maxQueuedTasks: 20,
  sendAcknowledgement: false,
  mode: "dry-run",
};

const pollResult: ListenerPollResult = {
  initialized: false,
  watermark: 1,
  scanned: 1,
  queued: 1,
  filtered: 0,
  duplicates: 0,
};

function task(id: string, text: string): ClaimedTask {
  return {
    taskId: id,
    inbound: {
      guid: `guid-${id}`,
      cursor: 1,
      chatId: `chat-${id}`,
      sender: "+15551234567",
      service: "iMessage",
      text,
      receivedAt: new Date(0).toISOString(),
      isFromMe: false,
      isGroup: false,
    },
  };
}

function fakeStore(tasks: ClaimedTask[]) {
  const outbox: OutboxRecord[] = [];
  const terminal: Array<[string, string]> = [];
  let sequence = 0;
  const prepare = async (input: { taskId: string; inboundGuid: string; chatId: string; reply: string }) => {
    const row: OutboxRecord = {
      id: `out-${sequence++}`,
      taskId: input.taskId,
      inboundGuid: input.inboundGuid,
      chatId: input.chatId,
      replyKind: "final",
      reply: input.reply,
      state: "prepared",
      attempts: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    outbox.push(row);
    return row;
  };
  const store: HarnessServiceStore = {
    async claimNextQueued() { return tasks.shift() ?? null; },
    completeTaskAndPrepareReply: prepare,
    failTaskAndPrepareReply: prepare,
    async claimNextPreparedReply() { return outbox.shift() ?? null; },
    async markReplySent(id) { terminal.push([id, "sent"]); },
    async markReplyUncertain(id) { terminal.push([id, "uncertain"]); },
    async markReplyFailed(id) { terminal.push([id, "failed"]); },
    async markReplyDryRun(id) { terminal.push([id, "dry_run"]); },
  };
  return { store, terminal };
}

test("service passes each exact prompt unchanged, serializes, and replies to its original chat", async () => {
  const firstPrompt = "  Please use OBS.\nDo not rewrite this.  ";
  const { store, terminal } = fakeStore([task("1", firstPrompt), task("2", "second")]);
  const prompts: string[] = [];
  const chats: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const service = new ImessageHarnessService({
    config,
    store,
    listener: { initialize: () => false, pollOnce: async () => pollResult },
    worker: {
      async execute({ taskId, prompt }) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        prompts.push(prompt);
        await Promise.resolve();
        active -= 1;
        return { ok: true, reply: `done-${taskId}`, threadId: `thread-${taskId}` };
      },
    },
    delivery: {
      async deliver(chatId, reply) {
        chats.push(`${chatId}:${reply}`);
        return { state: "dry_run", message: reply };
      },
    },
  });

  await Promise.all([service.tick(), service.tick()]);
  assert.deepEqual(prompts, [firstPrompt, "second"]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(chats, ["chat-1:done-1", "chat-2:done-2"]);
  assert.deepEqual(terminal, [["out-0", "dry_run"], ["out-1", "dry_run"]]);
});

test("disabled service is a kill switch and does not poll or execute", async () => {
  let activity = 0;
  const { store } = fakeStore([task("1", "must not run")]);
  const service = new ImessageHarnessService({
    config: { ...config, enabled: false },
    store,
    listener: { initialize: () => false, async pollOnce() { activity += 1; return pollResult; } },
    worker: { async execute() { activity += 1; return { ok: true, reply: "no", threadId: "no" }; } },
    delivery: { async deliver(_chatId, reply) { activity += 1; return { state: "dry_run", message: reply }; } },
  });
  await service.tick();
  assert.equal(activity, 0);
});

test("untrusted conversations use the restricted contextual worker while trusted prompts stay exact", async () => {
  const trusted = task("trusted", "  exact command  ");
  const untrusted = task("unknown", "latest");
  untrusted.inbound.sender = "+15550000000";
  untrusted.inbound.kind = "conversation_reply";
  untrusted.inbound.context = [
    { text: "hello", sender: "+15550000000", isFromMe: false, receivedAt: "2026-01-01T00:00:00.000Z" },
    { text: "latest", sender: "+15550000000", isFromMe: false, receivedAt: "2026-01-01T00:01:00.000Z" },
  ];
  const { store } = fakeStore([trusted, untrusted]);
  const trustedPrompts: string[] = [];
  const conversationPrompts: string[] = [];
  const service = new ImessageHarnessService({
    config,
    store,
    listener: { initialize: () => false, pollOnce: async () => pollResult },
    worker: {
      async execute({ prompt }) {
        trustedPrompts.push(prompt);
        return { ok: true, reply: "trusted done", threadId: "trusted-thread" };
      },
    },
    conversationWorker: {
      async execute({ prompt }) {
        conversationPrompts.push(prompt);
        return { ok: true, reply: "contextual reply", threadId: "conversation-thread" };
      },
    },
    delivery: { async deliver(_chatId, reply) { return { state: "dry_run", message: reply }; } },
  });
  await service.tick();
  assert.deepEqual(trustedPrompts, ["  exact command  "]);
  assert.equal(conversationPrompts.length, 1);
  assert.match(conversationPrompts[0], /Respond to the iMessage conversation/);
  assert.match(conversationPrompts[0], /funny, casual, and expressive/);
  assert.match(conversationPrompts[0], /Gen Z/);
  assert.match(conversationPrompts[0], /distinct personality/);
  assert.match(conversationPrompts[0], /untrusted conversation content/);
  assert.match(conversationPrompts[0], /hello/);
  assert.match(conversationPrompts[0], /latest/);
});

test("ambiguous delivery is terminal send_uncertain", async () => {
  const { store, terminal } = fakeStore([task("1", "run")]);
  const service = new ImessageHarnessService({
    config,
    store,
    listener: { initialize: () => false, pollOnce: async () => pollResult },
    worker: { async execute() { return { ok: true, reply: "done", threadId: "thread" }; } },
    delivery: { async deliver(_chatId, reply) { return { state: "send_uncertain", message: reply, error: "timeout" }; } },
  });
  await service.tick();
  assert.deepEqual(terminal, [["out-0", "uncertain"]]);
});
