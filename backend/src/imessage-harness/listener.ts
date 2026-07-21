import type { SqliteHarnessLedger } from "./ledger";
import type { MessagesStore } from "./messages-store";
import type { FilterReason, InboundMessage, ListenerPollResult, MessageObservation } from "./types";

export interface ImessageListenerOptions {
  store: MessagesStore;
  ledger: SqliteHarnessLedger;
  allowedSender?: string;
  allowedSenders?: string[];
  pollIntervalMs?: number;
  batchSize?: number;
  maxQueuedTasks?: number;
  /** Ignore messages older than this at scan time. Prevents replaying a backlog on start-up. */
  freshnessWindowMs?: number;
  onError?: (error: unknown) => void;
}

export function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("+")) return null;
  const normalized = `+${trimmed.slice(1).replaceAll(/[^0-9]/g, "")}`;
  return /^\+[1-9][0-9]{7,14}$/.test(normalized) ? normalized : null;
}

function authorize(
  observation: MessageObservation,
  allowedSenders: ReadonlySet<string>,
  store: MessagesStore,
  freshBefore: number,
):
  | { inbound: InboundMessage; reason: null }
  | { inbound: null; reason: FilterReason } {
  if (!observation.guid) return { inbound: null, reason: "missing_guid" };
  const receivedMs = Date.parse(observation.receivedAt);
  if (!Number.isFinite(receivedMs) || receivedMs < freshBefore) return { inbound: null, reason: "stale" };
  if (observation.isFromMe) return { inbound: null, reason: "outbound" };
  if (observation.service !== "iMessage") return { inbound: null, reason: "wrong_service" };
  if (!observation.chatId) return { inbound: null, reason: "missing_chat" };
  if (observation.isGroup) return { inbound: null, reason: "group_chat" };
  if (observation.hasAttachments) return { inbound: null, reason: "attachment" };
  if (observation.associatedMessageType !== 0 || observation.itemType !== 0) {
    return { inbound: null, reason: "non_plain_message" };
  }
  if (observation.text == null || observation.text.trim().length === 0) {
    return { inbound: null, reason: "empty_text" };
  }
  const sender = observation.sender ? normalizeE164(observation.sender) : null;
  if (!sender) return { inbound: null, reason: "unauthorized_sender" };
  const participants = observation.participantHandles.map(normalizeE164).filter((value): value is string => value != null);
  if (participants.length !== 1 || participants[0] !== sender) {
    return { inbound: null, reason: "participant_mismatch" };
  }
  const trusted = allowedSenders.has(sender);
  const context = trusted
    ? undefined
    : store.getRecentConversation(
        observation.chatId,
        observation.cursor,
        new Date(Date.parse(observation.receivedAt) - 5 * 60_000).toISOString(),
        5,
      );
  return {
    inbound: {
      guid: observation.guid,
      cursor: observation.cursor,
      chatId: observation.chatId,
      sender,
      service: "iMessage",
      text: observation.text,
      kind: trusted ? "trusted_prompt" : "conversation_reply",
      ...(context ? { context } : {}),
      receivedAt: observation.receivedAt,
      isFromMe: false,
      isGroup: false,
    },
    reason: null,
  };
}

export class ImessageListener {
  readonly #store: MessagesStore;
  readonly #ledger: SqliteHarnessLedger;
  readonly #allowedSenders: Set<string>;
  readonly #pollIntervalMs: number;
  readonly #batchSize: number;
  readonly #maxQueuedTasks: number;
  readonly #freshnessWindowMs: number;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;

  constructor(options: ImessageListenerOptions) {
    const configured = options.allowedSenders ?? (options.allowedSender ? [options.allowedSender] : []);
    const normalized = configured.map(normalizeE164);
    if (configured.length === 0 || normalized.some((sender, index) => !sender || sender !== configured[index])) {
      throw new Error("allowedSenders must contain normalized E.164 numbers (for example +15551234567)");
    }
    this.#store = options.store;
    this.#ledger = options.ledger;
    this.#allowedSenders = new Set(normalized as string[]);
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#batchSize = options.batchSize ?? 100;
    this.#maxQueuedTasks = options.maxQueuedTasks ?? 20;
    if (!Number.isSafeInteger(this.#maxQueuedTasks) || this.#maxQueuedTasks < 1) {
      throw new Error("maxQueuedTasks must be a positive safe integer");
    }
    this.#freshnessWindowMs = options.freshnessWindowMs ?? 60_000;
    if (!Number.isSafeInteger(this.#freshnessWindowMs) || this.#freshnessWindowMs < 1) {
      throw new Error("freshnessWindowMs must be a positive safe integer");
    }
    this.#onError = options.onError ?? ((error) => console.error("iMessage listener poll failed", error));
  }

  /** Establish a first-run watermark. Returns true only on first initialization. */
  initialize(): boolean {
    if (this.#ledger.getListenerCursor() != null) return false;
    return this.#ledger.initializeListenerCursor(this.#store.getCurrentCursor());
  }

  async pollOnce(): Promise<ListenerPollResult> {
    const initialized = this.initialize();
    const initialCursor = this.#ledger.getListenerCursor();
    if (initialCursor == null) throw new Error("Listener cursor initialization failed");
    if (initialized) {
      return { initialized: true, watermark: initialCursor, scanned: 0, queued: 0, filtered: 0, duplicates: 0 };
    }

    let cursor = initialCursor;
    const freshBefore = Date.now() - this.#freshnessWindowMs;
    let scanned = 0;
    let queued = 0;
    let filtered = 0;
    let duplicates = 0;
    while (true) {
      const batch = this.#store.scanAfter(cursor, this.#batchSize);
      if (batch.length === 0) break;
      for (const observation of batch) {
        const decision = authorize(observation, this.#allowedSenders, this.#store, freshBefore);
        const queueFull = decision.inbound != null && this.#ledger.getQueuedTaskCount() >= this.#maxQueuedTasks;
        const result = this.#ledger.recordObservation(
          observation,
          queueFull ? null : decision.inbound,
          queueFull ? "queue_full" : decision.reason,
        );
        scanned += 1;
        if (result === "queued") queued += 1;
        else if (result === "filtered") filtered += 1;
        else duplicates += 1;
        cursor = Math.max(cursor, observation.cursor);
      }
      if (batch.length < this.#batchSize) break;
    }
    return { initialized: false, watermark: initialCursor, scanned, queued, filtered, duplicates };
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const loop = async () => {
      if (this.#stopped) return;
      try {
        await this.pollOnce();
      } catch (error) {
        this.#onError(error);
      }
      if (!this.#stopped) this.#timer = setTimeout(loop, this.#pollIntervalMs);
    };
    void loop();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  setAllowedSenders(senders: string[]): void {
    const normalized = senders.map(normalizeE164);
    if (senders.length === 0 || normalized.some((sender, index) => !sender || sender !== senders[index])) {
      throw new Error("allowedSenders must contain normalized E.164 numbers");
    }
    this.#allowedSenders.clear();
    for (const sender of normalized) this.#allowedSenders.add(sender as string);
  }
}
