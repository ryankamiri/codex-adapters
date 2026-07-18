import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteMessagesStore } from "../../src/imessage-harness/messages-store";
import { appendFixtureMessage, createMessagesFixture } from "./fixtures/messages-fixture";

test("MessagesStore reads a schema-independent normalized observation", () => {
  const dir = mkdtempSync(join(tmpdir(), "messages-store-"));
  try {
    const path = join(dir, "chat.db");
    const writer = createMessagesFixture(path);
    appendFixtureMessage(writer, {
      guid: "p:0/one",
      text: "  exact prompt  ",
      sender: "+1 (555) 123-4567",
      date: 1_000_000_000,
    });
    const store = new SqliteMessagesStore(path);
    assert.equal(store.getCurrentCursor(), 1);
    assert.deepEqual(store.scanAfter(0), [{
      guid: "p:0/one",
      cursor: 1,
      chatId: "iMessage;-;+1 (555) 123-4567",
      sender: "+1 (555) 123-4567",
      service: "iMessage",
      text: "  exact prompt  ",
      receivedAt: "2032-09-09T01:46:40.000Z",
      isFromMe: false,
      isGroup: false,
      participantHandles: ["+1 (555) 123-4567"],
      hasAttachments: false,
      associatedMessageType: 0,
      itemType: 0,
    }]);
    store.close();
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MessagesStore exposes group and non-plain flags and advances by ROWID", () => {
  const dir = mkdtempSync(join(tmpdir(), "messages-store-"));
  try {
    const path = join(dir, "chat.db");
    const writer = createMessagesFixture(path);
    appendFixtureMessage(writer, { guid: "old", text: "old", sender: "+15551234567" });
    appendFixtureMessage(writer, {
      guid: "reaction",
      text: "Liked a message",
      sender: "+15551234567",
      chatGuid: "group-chat",
      participants: ["+15551234567", "+15557654321"],
      style: 43,
      attachments: true,
      associatedMessageType: 2000,
    });
    const store = new SqliteMessagesStore(path);
    const rows = store.scanAfter(1, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.cursor, 2);
    assert.equal(rows[0]?.isGroup, true);
    assert.equal(rows[0]?.hasAttachments, true);
    assert.equal(rows[0]?.associatedMessageType, 2000);
    store.close();
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
