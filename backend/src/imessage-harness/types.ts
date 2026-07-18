export type TaskStatus =
  | "queued"
  | "running"
  | "generated"
  | "reply_prepared"
  | "sending"
  | "sent"
  | "failed"
  | "timed_out"
  | "interrupted"
  | "send_uncertain"
  | "dry_run";

export type ReplyState = "prepared" | "sending" | "sent" | "send_uncertain" | "failed" | "dry_run";

export interface InboundMessage {
  guid: string;
  cursor: number;
  chatId: string;
  sender: string;
  service: "iMessage";
  /** The exact Messages database text. Never trim or rewrite this value. */
  text: string;
  /** Trusted senders execute their text verbatim; other senders receive a contextual reply. */
  kind?: "trusted_prompt" | "conversation_reply";
  context?: ConversationContextMessage[];
  receivedAt: string;
  isFromMe: false;
  isGroup: false;
}

export interface ConversationContextMessage {
  text: string;
  sender: string | null;
  isFromMe: boolean;
  receivedAt: string;
}

/** A schema-independent view of a row in Apple's private Messages database. */
export interface MessageObservation {
  guid: string;
  cursor: number;
  chatId: string | null;
  sender: string | null;
  service: string | null;
  text: string | null;
  receivedAt: string;
  isFromMe: boolean;
  isGroup: boolean;
  participantHandles: string[];
  hasAttachments: boolean;
  associatedMessageType: number;
  itemType: number;
}

export type FilterReason =
  | "outbound"
  | "wrong_service"
  | "unauthorized_sender"
  | "group_chat"
  | "participant_mismatch"
  | "missing_chat"
  | "missing_guid"
  | "empty_text"
  | "attachment"
  | "non_plain_message"
  | "queue_full";

export interface ListenerPollResult {
  initialized: boolean;
  watermark: number;
  scanned: number;
  queued: number;
  filtered: number;
  duplicates: number;
}

export interface ClaimedTask {
  taskId: string;
  inbound: InboundMessage;
}

export interface OutboxRecord {
  id: string;
  taskId: string;
  inboundGuid: string;
  chatId: string;
  replyKind: string;
  reply: string;
  state: ReplyState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}
