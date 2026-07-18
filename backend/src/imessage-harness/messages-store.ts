import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ConversationContextMessage, MessageObservation } from "./types";

export interface MessagesStore {
  getCurrentCursor(): number;
  scanAfter(cursor: number, limit?: number): MessageObservation[];
  getRecentConversation(chatId: string, throughCursor: number, since: string, limit?: number): ConversationContextMessage[];
  close(): void;
}

function appleDateToIso(raw: unknown): string {
  if (raw == null) return new Date(0).toISOString();
  const value = Number(raw);
  if (!Number.isFinite(value)) return new Date(0).toISOString();

  // Messages dates are seconds (old schemas) or nanoseconds (modern schemas)
  // since 2001-01-01. Keeping this conversion here isolates that private detail.
  const seconds = Math.abs(value) > 10_000_000_000 ? value / 1_000_000_000 : value;
  return new Date(Date.UTC(2001, 0, 1) + seconds * 1_000).toISOString();
}

function numberValue(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function stringValue(value: unknown): string | null {
  return value == null ? null : String(value);
}

function splitParticipants(value: unknown): string[] {
  if (value == null || value === "") return [];
  return String(value).split("\u001f").filter(Boolean);
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Read-only adapter around the version-dependent macOS Messages schema. */
export class SqliteMessagesStore implements MessagesStore {
  readonly #db: DatabaseSync;
  readonly #scan: StatementSync;
  readonly #maxCursor: StatementSync;
  readonly #recentConversation: StatementSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path, { readOnly: true });
    this.#db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000");

    const tables = this.#tableNames();
    for (const required of ["message", "chat", "chat_message_join", "handle"]) {
      if (!tables.has(required)) throw new Error(`Unsupported Messages schema: missing ${required} table`);
    }

    const messageColumns = this.#columns("message");
    const chatColumns = this.#columns("chat");
    const hasChatHandleJoin = tables.has("chat_handle_join");
    const expr = (column: string, fallback: string) =>
      messageColumns.has(column) ? `m.${column}` : fallback;
    const chatExpr = (column: string, fallback: string) =>
      chatColumns.has(column) ? `c.${column}` : fallback;

    const participantCount = hasChatHandleJoin
      ? "(SELECT COUNT(DISTINCT chj.handle_id) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID)"
      : "CASE WHEN h.id IS NULL THEN 0 ELSE 1 END";
    const participants = hasChatHandleJoin
      ? "(SELECT group_concat(x.id, char(31)) FROM (SELECT DISTINCT ph.id AS id FROM chat_handle_join chj JOIN handle ph ON ph.ROWID = chj.handle_id WHERE chj.chat_id = c.ROWID ORDER BY ph.id) x)"
      : "h.id";

    // Only identifiers detected above are interpolated. All runtime values remain bound.
    this.#scan = this.#db.prepare(`
      SELECT
        m.ROWID AS cursor,
        ${expr("guid", "''")} AS guid,
        ${expr("text", "NULL")} AS text,
        ${expr("is_from_me", "0")} AS is_from_me,
        CAST(${expr("date", "0")} AS TEXT) AS message_date,
        ${expr("service", "h.service")} AS message_service,
        h.id AS sender,
        ${chatExpr("guid", chatExpr("chat_identifier", "CAST(c.ROWID AS TEXT)"))} AS chat_id,
        ${chatExpr("style", "0")} AS chat_style,
        ${participantCount} AS participant_count,
        ${participants} AS participants,
        ${expr("cache_has_attachments", "0")} AS has_attachments,
        ${expr("associated_message_type", "0")} AS associated_message_type,
        ${expr("item_type", "0")} AS item_type
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.ROWID > ?
      ORDER BY m.ROWID ASC
      LIMIT ?
    `);
    this.#maxCursor = this.#db.prepare("SELECT COALESCE(MAX(ROWID), 0) AS cursor FROM message");
    this.#recentConversation = this.#db.prepare(`
      SELECT
        ${expr("text", "NULL")} AS text,
        h.id AS sender,
        ${expr("is_from_me", "0")} AS is_from_me,
        CAST(${expr("date", "0")} AS TEXT) AS message_date,
        ${expr("service", "h.service")} AS message_service,
        ${expr("cache_has_attachments", "0")} AS has_attachments,
        ${expr("associated_message_type", "0")} AS associated_message_type,
        ${expr("item_type", "0")} AS item_type
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE ${chatExpr("guid", chatExpr("chat_identifier", "CAST(c.ROWID AS TEXT)"))} = ?
        AND m.ROWID <= ?
      ORDER BY m.ROWID DESC
      LIMIT 100
    `);
  }

  #tableNames(): Set<string> {
    const rows = this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    return new Set(rows.map((row) => String(row.name)));
  }

  #columns(table: string): Set<string> {
    const rows = this.#db.prepare(`PRAGMA table_info(${quoteSqlString(table)})`).all();
    return new Set(rows.map((row) => String(row.name)));
  }

  getCurrentCursor(): number {
    const row = this.#maxCursor.get() as Record<string, unknown>;
    return numberValue(row.cursor);
  }

  scanAfter(cursor: number, limit = 100): MessageObservation[] {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("limit must be between 1 and 10000");
    const rows = this.#scan.all(cursor, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const participantHandles = splitParticipants(row.participants);
      const participantCount = numberValue(row.participant_count);
      const style = numberValue(row.chat_style);
      return {
        guid: stringValue(row.guid) ?? "",
        cursor: numberValue(row.cursor),
        chatId: stringValue(row.chat_id),
        sender: stringValue(row.sender),
        service: stringValue(row.message_service),
        text: stringValue(row.text),
        receivedAt: appleDateToIso(row.message_date),
        isFromMe: numberValue(row.is_from_me) !== 0,
        // style=43 is common for group chats; participant count is the stable guard.
        isGroup: participantCount !== 1 || style === 43,
        participantHandles,
        hasAttachments: numberValue(row.has_attachments) !== 0,
        associatedMessageType: numberValue(row.associated_message_type),
        itemType: numberValue(row.item_type),
      };
    });
  }

  getRecentConversation(chatId: string, throughCursor: number, since: string, limit = 5): ConversationContextMessage[] {
    if (!Number.isSafeInteger(throughCursor) || throughCursor < 0) throw new Error("throughCursor must be non-negative");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be between 1 and 20");
    const sinceMs = Date.parse(since);
    if (!Number.isFinite(sinceMs)) throw new Error("since must be an ISO timestamp");
    const rows = this.#recentConversation.all(chatId, throughCursor) as Array<Record<string, unknown>>;
    return rows
      .filter((row) => {
        const text = stringValue(row.text);
        return text != null && text.trim().length > 0 &&
          stringValue(row.message_service) === "iMessage" &&
          numberValue(row.has_attachments) === 0 &&
          numberValue(row.associated_message_type) === 0 &&
          numberValue(row.item_type) === 0 &&
          Date.parse(appleDateToIso(row.message_date)) >= sinceMs;
      })
      .slice(0, limit)
      .reverse()
      .map((row) => ({
        text: String(row.text),
        sender: stringValue(row.sender),
        isFromMe: numberValue(row.is_from_me) !== 0,
        receivedAt: appleDateToIso(row.message_date),
      }));
  }

  close(): void {
    this.#db.close();
  }
}
