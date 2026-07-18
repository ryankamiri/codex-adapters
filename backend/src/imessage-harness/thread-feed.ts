import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildConversationReplyPrompt } from "./service";
import type { ClaimedTask, ConversationContextMessage } from "./types";

export interface ImessageUiThread {
  id: string;
  title: string;
  prompt: string;
  reply: string | null;
  status: string;
  codexThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

const titleFor = (prompt: string, lastFour: string, conversationReply: boolean): string => {
  const compact = prompt.replace(/\s+/g, " ").trim();
  const preview = compact.length > 42 ? `${compact.slice(0, 42)}…` : compact;
  const kind = conversationReply ? "reply " : "";
  return `iMessage ${kind}${lastFour ? `••${lastFour} · ` : "· "}${preview || "New request"}`;
};

const contextFrom = (value: unknown): ConversationContextMessage[] => {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as ConversationContextMessage[] : [];
  } catch {
    return [];
  }
};

export function listImessageUiThreads(
  databasePath = path.resolve(process.env.IMESSAGE_HARNESS_STATE_DB ?? "data/imessage-harness/state.sqlite"),
): ImessageUiThread[] {
  if (!existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT t.id, t.status, t.thread_id, t.created_at, t.updated_at,
        i.guid, i.cursor, i.chat_id, i.sender, i.text, i.route, i.context_json,
        i.received_at, i.sender_last_four, o.reply
      FROM tasks t
      JOIN inbound_messages i ON i.guid = t.inbound_guid
      LEFT JOIN reply_outbox o
        ON o.task_id = t.id AND o.reply_kind = 'final'
      ORDER BY t.created_at DESC
      LIMIT 100
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const inboundText = String(row.text ?? "");
      const lastFour = String(row.sender_last_four ?? "");
      const conversationReply = String(row.route) === "conversation_reply";
      let prompt = inboundText;
      if (conversationReply) {
        const task: ClaimedTask = {
          taskId: String(row.id),
          inbound: {
            guid: String(row.guid),
            cursor: Number(row.cursor),
            chatId: String(row.chat_id ?? ""),
            sender: String(row.sender ?? ""),
            service: "iMessage",
            text: inboundText,
            kind: "conversation_reply",
            context: contextFrom(row.context_json),
            receivedAt: String(row.received_at),
            isFromMe: false,
            isGroup: false,
          },
        };
        prompt = buildConversationReplyPrompt(task);
      }
      return {
        id: String(row.id),
        title: titleFor(inboundText, lastFour, conversationReply),
        prompt,
        reply: row.reply == null ? null : String(row.reply),
        status: String(row.status),
        codexThreadId: row.thread_id == null ? null : String(row.thread_id),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  } catch (error) {
    // A listener may be creating the database at the same moment the backend
    // starts. Treat a not-yet-migrated ledger as an empty feed.
    if (error instanceof Error && /no such table/.test(error.message)) return [];
    throw error;
  } finally {
    database.close();
  }
}
