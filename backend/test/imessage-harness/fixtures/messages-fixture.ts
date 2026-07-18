import { DatabaseSync } from "node:sqlite";

export interface FixtureMessage {
  guid: string;
  text: string | null;
  sender: string;
  service?: string;
  isFromMe?: boolean;
  chatGuid?: string;
  participants?: string[];
  style?: number;
  attachments?: boolean;
  associatedMessageType?: number;
  itemType?: number;
  date?: number;
}

export function createMessagesFixture(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      handle_id INTEGER,
      service TEXT,
      is_from_me INTEGER,
      date INTEGER,
      cache_has_attachments INTEGER,
      associated_message_type INTEGER,
      item_type INTEGER
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
  `);
  return db;
}

function getOrCreateHandle(db: DatabaseSync, id: string, service: string): number {
  const existing = db.prepare("SELECT ROWID FROM handle WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (existing) return Number(existing.ROWID);
  return Number(db.prepare("INSERT INTO handle(id, service) VALUES (?, ?)").run(id, service).lastInsertRowid);
}

export function appendFixtureMessage(db: DatabaseSync, input: FixtureMessage): number {
  const service = input.service ?? "iMessage";
  const senderHandle = getOrCreateHandle(db, input.sender, service);
  const chatGuid = input.chatGuid ?? `iMessage;-;${input.sender}`;
  let chat = db.prepare("SELECT ROWID FROM chat WHERE guid = ?").get(chatGuid) as Record<string, unknown> | undefined;
  const chatId = chat
    ? Number(chat.ROWID)
    : Number(db.prepare("INSERT INTO chat(guid, chat_identifier, style) VALUES (?, ?, ?)")
      .run(chatGuid, input.sender, input.style ?? 45).lastInsertRowid);

  for (const participant of input.participants ?? [input.sender]) {
    const handleId = getOrCreateHandle(db, participant, service);
    db.prepare("INSERT INTO chat_handle_join(chat_id, handle_id) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM chat_handle_join WHERE chat_id = ? AND handle_id = ?)")
      .run(chatId, handleId, chatId, handleId);
  }
  const row = db.prepare(`
    INSERT INTO message(guid, text, handle_id, service, is_from_me, date, cache_has_attachments, associated_message_type, item_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.guid,
    input.text,
    senderHandle,
    service,
    input.isFromMe ? 1 : 0,
    input.date ?? 10,
    input.attachments ? 1 : 0,
    input.associatedMessageType ?? 0,
    input.itemType ?? 0,
  );
  const messageId = Number(row.lastInsertRowid);
  db.prepare("INSERT INTO chat_message_join(chat_id, message_id) VALUES (?, ?)").run(chatId, messageId);
  return messageId;
}
