import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ClaimedTask,
  FilterReason,
  InboundMessage,
  MessageObservation,
  OutboxRecord,
  ReplyState,
  TaskStatus,
} from "./types";

export type RecordObservationResult = "queued" | "filtered" | "duplicate";

function nowIso(): string {
  return new Date().toISOString();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lastFour(sender: string | null): string | null {
  if (!sender) return null;
  const digits = sender.replaceAll(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function taskIdFor(guid: string): string {
  return `msg_${hash(guid).slice(0, 20)}`;
}

function outboxFromRow(row: Record<string, unknown>): OutboxRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    inboundGuid: String(row.inbound_guid),
    chatId: String(row.chat_id),
    replyKind: String(row.reply_kind),
    reply: String(row.reply),
    state: String(row.state) as ReplyState,
    attempts: Number(row.attempts),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Durable cursor, task queue, and reply outbox for the local harness. */
export class SqliteHarnessLedger {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS listener_state (
        source TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL,
        initialized_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbound_messages (
        guid TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL,
        chat_id TEXT,
        sender TEXT,
        sender_hash TEXT,
        sender_last_four TEXT,
        service TEXT,
        text TEXT,
        route TEXT NOT NULL DEFAULT 'trusted_prompt',
        context_json TEXT,
        received_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'filtered')),
        filter_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS inbound_cursor_idx ON inbound_messages(cursor);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        inbound_guid TEXT NOT NULL UNIQUE REFERENCES inbound_messages(guid),
        status TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        error_category TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_status_created_idx ON tasks(status, created_at);
      CREATE TABLE IF NOT EXISTS reply_outbox (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        inbound_guid TEXT NOT NULL REFERENCES inbound_messages(guid),
        chat_id TEXT NOT NULL,
        reply_kind TEXT NOT NULL,
        reply TEXT NOT NULL,
        reply_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(inbound_guid, reply_kind)
      );
      CREATE INDEX IF NOT EXISTS outbox_state_created_idx ON reply_outbox(state, created_at);
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        method TEXT NOT NULL,
        capability TEXT NOT NULL,
        server TEXT,
        tool TEXT,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tool_calls_task_created_idx ON tool_calls(task_id, created_at);
    `);
    const inboundColumns = new Set(
      (this.#db.prepare("PRAGMA table_info(inbound_messages)").all() as Array<Record<string, unknown>>)
        .map((row) => String(row.name)),
    );
    if (!inboundColumns.has("route")) {
      this.#db.exec("ALTER TABLE inbound_messages ADD COLUMN route TEXT NOT NULL DEFAULT 'trusted_prompt'");
    }
    if (!inboundColumns.has("context_json")) {
      this.#db.exec("ALTER TABLE inbound_messages ADD COLUMN context_json TEXT");
    }
  }

  getListenerCursor(source = "messages"): number | null {
    const row = this.#db.prepare("SELECT cursor FROM listener_state WHERE source = ?").get(source) as
      | Record<string, unknown>
      | undefined;
    return row ? Number(row.cursor) : null;
  }

  initializeListenerCursor(cursor: number, source = "messages"): boolean {
    const now = nowIso();
    const result = this.#db
      .prepare("INSERT OR IGNORE INTO listener_state(source, cursor, initialized_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(source, cursor, now, now);
    return Number(result.changes) === 1;
  }

  recordObservation(
    observation: MessageObservation,
    inbound: InboundMessage | null,
    filterReason: FilterReason | null,
    source = "messages",
  ): RecordObservationResult {
    const observedAt = nowIso();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db.prepare("SELECT status FROM inbound_messages WHERE guid = ?").get(observation.guid);
      if (existing) {
        this.#advanceCursor(observation.cursor, source, observedAt);
        this.#db.exec("COMMIT");
        return "duplicate";
      }

      const status = inbound ? "queued" : "filtered";
      const sender = inbound?.sender ?? observation.sender;
      this.#db.prepare(`
        INSERT INTO inbound_messages(
          guid, cursor, chat_id, sender, sender_hash, sender_last_four, service, text, route, context_json,
          received_at, observed_at, status, filter_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.guid,
        observation.cursor,
        inbound?.chatId ?? observation.chatId,
        sender,
        sender ? hash(sender) : null,
        lastFour(sender),
        inbound?.service ?? observation.service,
        inbound?.text ?? observation.text,
        inbound?.kind ?? "trusted_prompt",
        inbound?.context ? JSON.stringify(inbound.context) : null,
        observation.receivedAt,
        observedAt,
        status,
        filterReason,
      );
      if (inbound) {
        const taskId = taskIdFor(inbound.guid);
        this.#db.prepare(`
          INSERT INTO tasks(id, inbound_guid, status, created_at, updated_at)
          VALUES (?, ?, 'queued', ?, ?)
        `).run(taskId, inbound.guid, observedAt, observedAt);
      }
      this.#advanceCursor(observation.cursor, source, observedAt);
      this.#db.exec("COMMIT");
      return inbound ? "queued" : "filtered";
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #advanceCursor(cursor: number, source: string, updatedAt: string): void {
    const result = this.#db
      .prepare("UPDATE listener_state SET cursor = MAX(cursor, ?), updated_at = ? WHERE source = ?")
      .run(cursor, updatedAt, source);
    if (Number(result.changes) !== 1) throw new Error(`Listener state '${source}' is not initialized`);
  }

  async claimNextQueued(): Promise<ClaimedTask | null> {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare(`
        SELECT t.id AS task_id, i.*
        FROM tasks t JOIN inbound_messages i ON i.guid = t.inbound_guid
        WHERE t.status = 'queued'
        ORDER BY i.cursor ASC LIMIT 1
      `).get() as Record<string, unknown> | undefined;
      if (!row) {
        this.#db.exec("COMMIT");
        return null;
      }
      const now = nowIso();
      this.#db.prepare("UPDATE tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(now, now, String(row.task_id));
      this.#db.exec("COMMIT");
      return {
        taskId: String(row.task_id),
        inbound: {
          guid: String(row.guid),
          cursor: Number(row.cursor),
          chatId: String(row.chat_id),
          sender: String(row.sender),
          service: "iMessage",
          text: String(row.text),
          kind: String(row.route) === "conversation_reply" ? "conversation_reply" : "trusted_prompt",
          ...(row.context_json == null ? {} : { context: JSON.parse(String(row.context_json)) }),
          receivedAt: String(row.received_at),
          isFromMe: false,
          isGroup: false,
        },
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getQueuedTaskCount(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'queued'").get() as Record<string, unknown>;
    return Number(row.count);
  }

  recordApprovalDecision(event: {
    taskId: string;
    method: string;
    capability: string;
    server?: string;
    tool?: string;
    decision: string;
    reason: string;
  }): void {
    this.#db.prepare(`
      INSERT INTO tool_calls(id, task_id, method, capability, server, tool, decision, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      event.taskId,
      event.method,
      event.capability,
      event.server ?? null,
      event.tool ?? null,
      event.decision,
      event.reason,
      nowIso(),
    );
  }

  listApprovalDecisions(taskId: string): Array<{
    method: string;
    capability: string;
    server: string | null;
    tool: string | null;
    decision: string;
    reason: string;
  }> {
    return this.#db.prepare(`
      SELECT method, capability, server, tool, decision, reason
      FROM tool_calls WHERE task_id = ? ORDER BY created_at ASC, ROWID ASC
    `).all(taskId).map((row) => ({
      method: String(row.method),
      capability: String(row.capability),
      server: row.server == null ? null : String(row.server),
      tool: row.tool == null ? null : String(row.tool),
      decision: String(row.decision),
      reason: String(row.reason),
    }));
  }

  async completeTaskAndPrepareReply(input: {
    taskId: string;
    inboundGuid: string;
    chatId: string;
    reply: string;
    replyKind?: string;
    threadId?: string;
    turnId?: string;
  }): Promise<OutboxRecord> {
    return this.#prepareReply({ ...input, taskStatus: "reply_prepared" });
  }

  async failTaskAndPrepareReply(input: {
    taskId: string;
    inboundGuid: string;
    chatId: string;
    reply: string;
    errorCategory: string;
    replyKind?: string;
    taskStatus?: Extract<TaskStatus, "failed" | "timed_out" | "interrupted">;
  }): Promise<OutboxRecord> {
    return this.#prepareReply({
      ...input,
      taskStatus: input.taskStatus ?? "failed",
      errorCategory: input.errorCategory,
    });
  }

  #prepareReply(input: {
    taskId: string;
    inboundGuid: string;
    chatId: string;
    reply: string;
    replyKind?: string;
    taskStatus: TaskStatus;
    errorCategory?: string;
    threadId?: string;
    turnId?: string;
  }): OutboxRecord {
    const replyKind = input.replyKind ?? "final";
    const timestamp = nowIso();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        UPDATE tasks SET status = ?, error_category = ?, thread_id = COALESCE(?, thread_id),
          turn_id = COALESCE(?, turn_id), completed_at = ?, updated_at = ? WHERE id = ?
      `).run(input.taskStatus, input.errorCategory ?? null, input.threadId ?? null, input.turnId ?? null, timestamp, timestamp, input.taskId);
      this.#db.prepare(`
        INSERT OR IGNORE INTO reply_outbox(
          id, task_id, inbound_guid, chat_id, reply_kind, reply, reply_hash, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
      `).run(randomUUID(), input.taskId, input.inboundGuid, input.chatId, replyKind, input.reply, hash(input.reply), timestamp, timestamp);
      const row = this.#db.prepare("SELECT * FROM reply_outbox WHERE inbound_guid = ? AND reply_kind = ?")
        .get(input.inboundGuid, replyKind) as Record<string, unknown>;
      this.#db.exec("COMMIT");
      return outboxFromRow(row);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async claimNextPreparedReply(): Promise<OutboxRecord | null> {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT * FROM reply_outbox WHERE state = 'prepared' ORDER BY created_at ASC LIMIT 1")
        .get() as Record<string, unknown> | undefined;
      if (!row) {
        this.#db.exec("COMMIT");
        return null;
      }
      const timestamp = nowIso();
      this.#db.prepare("UPDATE reply_outbox SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(timestamp, String(row.id));
      this.#db.prepare("UPDATE tasks SET status = 'sending', updated_at = ? WHERE id = ?").run(timestamp, String(row.task_id));
      const updated = this.#db.prepare("SELECT * FROM reply_outbox WHERE id = ?").get(String(row.id)) as Record<string, unknown>;
      this.#db.exec("COMMIT");
      return outboxFromRow(updated);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async markReplySent(id: string): Promise<void> {
    this.#markReply(id, "sent", "sent");
  }

  async markReplyUncertain(id: string): Promise<void> {
    this.#markReply(id, "send_uncertain", "send_uncertain");
  }

  async markReplyFailed(id: string): Promise<void> {
    this.#markReply(id, "failed", "failed");
  }

  async markReplyDryRun(id: string): Promise<void> {
    this.#markReply(id, "dry_run", "dry_run");
  }

  /** A process crash during an AppleScript send is ambiguous and must never retry. */
  async recoverSendingReplies(): Promise<number> {
    const timestamp = nowIso();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const tasks = this.#db.prepare(`
        UPDATE tasks SET status = 'send_uncertain', updated_at = ?
        WHERE id IN (SELECT task_id FROM reply_outbox WHERE state = 'sending')
      `).run(timestamp);
      this.#db.prepare("UPDATE reply_outbox SET state = 'send_uncertain', updated_at = ? WHERE state = 'sending'")
        .run(timestamp);
      this.#db.exec("COMMIT");
      return Number(tasks.changes);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #markReply(id: string, replyState: ReplyState, taskStatus: TaskStatus): void {
    const timestamp = nowIso();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT task_id FROM reply_outbox WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new Error(`Unknown outbox record: ${id}`);
      this.#db.prepare("UPDATE reply_outbox SET state = ?, updated_at = ? WHERE id = ?").run(replyState, timestamp, id);
      this.#db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(taskStatus, timestamp, String(row.task_id));
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }
}
