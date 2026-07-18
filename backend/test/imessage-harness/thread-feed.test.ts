import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteHarnessLedger } from "../../src/imessage-harness/ledger";
import { listImessageUiThreads } from "../../src/imessage-harness/thread-feed";
import type { InboundMessage, MessageObservation } from "../../src/imessage-harness/types";

test("trusted inbound tasks appear in the UI feed and gain their final reply", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-feed-"));
  const databasePath = path.join(root, "state.sqlite");
  const ledger = new SqliteHarnessLedger(databasePath);
  try {
    ledger.initializeListenerCursor(0);
    const receivedAt = "2026-07-18T17:33:27.524Z";
    const observation: MessageObservation = {
      guid: "trusted-guid",
      cursor: 1,
      chatId: "chat-1",
      sender: "+17147479095",
      service: "iMessage",
      text: "Do the thing",
      receivedAt,
      isFromMe: false,
      isGroup: false,
      participantHandles: ["+17147479095"],
      hasAttachments: false,
      associatedMessageType: 0,
      itemType: 0,
    };
    const inbound: InboundMessage = {
      guid: observation.guid,
      cursor: observation.cursor,
      chatId: observation.chatId!,
      sender: observation.sender!,
      service: "iMessage",
      text: observation.text!,
      kind: "trusted_prompt",
      receivedAt,
      isFromMe: false,
      isGroup: false,
    };
    assert.equal(ledger.recordObservation(observation, inbound, null), "queued");

    let feed = listImessageUiThreads(databasePath);
    assert.equal(feed.length, 1);
    assert.equal(feed[0].prompt, "Do the thing");
    assert.equal(feed[0].reply, null);
    assert.match(feed[0].title, /9095/);

    const task = await ledger.claimNextQueued();
    assert.ok(task);
    await ledger.completeTaskAndPrepareReply({
      taskId: task.taskId,
      inboundGuid: inbound.guid,
      chatId: inbound.chatId,
      reply: "Done",
      threadId: "codex-thread-1",
    });
    feed = listImessageUiThreads(databasePath);
    assert.equal(feed[0].reply, "Done");
    assert.equal(feed[0].codexThreadId, "codex-thread-1");
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown-sender replies appear as UI threads with the contextual personality prompt", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-feed-conversation-"));
  const databasePath = path.join(root, "state.sqlite");
  const ledger = new SqliteHarnessLedger(databasePath);
  try {
    ledger.initializeListenerCursor(0);
    const receivedAt = "2026-07-18T18:00:00.000Z";
    const observation: MessageObservation = {
      guid: "unknown-guid",
      cursor: 1,
      chatId: "chat-unknown",
      sender: "+15550001234",
      service: "iMessage",
      text: "what are you doing tonight",
      receivedAt,
      isFromMe: false,
      isGroup: false,
      participantHandles: ["+15550001234"],
      hasAttachments: false,
      associatedMessageType: 0,
      itemType: 0,
    };
    const inbound: InboundMessage = {
      guid: observation.guid,
      cursor: observation.cursor,
      chatId: observation.chatId!,
      sender: observation.sender!,
      service: "iMessage",
      text: observation.text!,
      kind: "conversation_reply",
      context: [
        { text: "yo", sender: observation.sender, isFromMe: false, receivedAt: "2026-07-18T17:59:00.000Z" },
        { text: observation.text!, sender: observation.sender, isFromMe: false, receivedAt },
      ],
      receivedAt,
      isFromMe: false,
      isGroup: false,
    };
    assert.equal(ledger.recordObservation(observation, inbound, null), "queued");

    const [thread] = listImessageUiThreads(databasePath);
    assert.ok(thread);
    assert.match(thread.title, /iMessage reply ••1234/);
    assert.match(thread.prompt, /Respond to the iMessage conversation/);
    assert.match(thread.prompt, /Gen Z/);
    assert.match(thread.prompt, /yo/);
    assert.match(thread.prompt, /what are you doing tonight/);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing harness database is an empty UI feed", () => {
  assert.deepEqual(listImessageUiThreads("/tmp/definitely-missing-imessage-ledger.sqlite"), []);
});
