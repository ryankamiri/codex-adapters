import { AppServerClient } from "../codex/client";
import type { AgentEvent, CodexClient, TurnResult } from "../codex/contract";
import {
  createScopedApprovalPolicy,
  type ApprovalAuditEvent,
  type ScopedApprovalOptions,
} from "./approval-policy";

export type CodexTaskFailureCode = "busy" | "startup" | "failed" | "interrupted" | "timeout" | "no-final-message";

export interface CodexTaskInput {
  taskId: string;
  /** Passed to Codex exactly as received. */
  prompt: string;
}

export type CodexTaskResult =
  | { ok: true; reply: string; threadId: string }
  | { ok: false; reply: string; failureCode: CodexTaskFailureCode; threadId?: string };

export interface CodexTaskWorkerOptions
  extends Pick<ScopedApprovalOptions, "allowedMcpServers" | "allowMessagesMcp" | "allowShellCommands" | "allowFileChanges"> {
  cwd?: string;
  model?: string;
  timeoutMs?: number;
  onApprovalDecision?: (event: ApprovalAuditEvent) => void;
  /** Developer diagnostics only. Events are never included in the task reply. */
  onEvent?: (event: AgentEvent) => void;
  /** Injection seam for tests. A provided client is never started outside start(). */
  client?: CodexClient;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

const safeTaskId = (taskId: string): string => {
  const cleaned = taskId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 100);
  return cleaned || "unknown";
};

const failureReply = (taskId: string, code: CodexTaskFailureCode): string => {
  const reason: Record<CodexTaskFailureCode, string> = {
    busy: "Another task is already running.",
    startup: "The Codex worker could not start.",
    failed: "Codex reported a failure.",
    interrupted: "The task was interrupted before completion.",
    timeout: "It timed out before completion.",
    "no-final-message": "Codex completed without a final response.",
  };
  return `I couldn't complete that task. ${reason[code]} Task ID: ${safeTaskId(taskId)}`;
};

const finalAgentText = async (events: AsyncIterable<AgentEvent>): Promise<string[]> => {
  const messages: string[] = [];
  for await (const event of events) {
    if (event.kind !== "item" || event.phase !== "completed" || event.itemType !== "agentMessage") continue;
    const text = (event.item as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) messages.push(text);
  }
  return messages;
};

export class CodexTaskWorker {
  private readonly client: CodexClient;
  private readonly timeoutMs: number;
  private activeTaskId: string | undefined;
  private started = false;
  private starting?: Promise<void>;
  private busy = false;

  constructor(private readonly options: CodexTaskWorkerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("timeoutMs must be positive");

    const approvals = createScopedApprovalPolicy({
      allowedMcpServers: options.allowedMcpServers,
      allowMessagesMcp: options.allowMessagesMcp,
      allowShellCommands: options.allowShellCommands,
      allowFileChanges: options.allowFileChanges,
      getTaskId: () => this.activeTaskId,
      onDecision: options.onApprovalDecision,
    });
    this.client =
      options.client ??
      new AppServerClient({
        cwd: options.cwd,
        // Max permission, by explicit operator request: the agent drives live
        // apps (Minecraft, Chrome, OBS) whose adapters need to act outside the
        // repo. "on-request" rather than "never" so escalations are routed to
        // the scoped policy above — which both decides AND writes an audit row
        // to the ledger. "never" would let codex refuse without a record.
        defaultSandbox: "danger-full-access",
        defaultApprovalPolicy: "on-request",
        approvals,
      });
    if (options.onEvent) void this.forwardEvents(this.client.events, options.onEvent);
  }

  private async forwardEvents(events: AsyncIterable<AgentEvent>, onEvent: (event: AgentEvent) => void): Promise<void> {
    try {
      for await (const event of events) {
        try {
          onEvent(event);
        } catch {
          // Diagnostics must never affect task execution or user-visible replies.
        }
      }
    } catch {
      // Closing or failing the app-server also ends this best-effort debug stream.
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.starting) {
      this.starting = this.client.start().then(() => {
        this.started = true;
      });
    }
    try {
      await this.starting;
    } finally {
      if (!this.started) this.starting = undefined;
    }
  }

  async execute(input: CodexTaskInput): Promise<CodexTaskResult> {
    if (this.busy) return { ok: false, failureCode: "busy", reply: failureReply(input.taskId, "busy") };
    this.busy = true;
    this.activeTaskId = input.taskId;
    let threadId: string | undefined;

    try {
      try {
        await this.start();
        threadId = await this.client.startThread({
          cwd: this.options.cwd,
          sandbox: "danger-full-access",
          approvalPolicy: "on-request",
        });
      } catch {
        return { ok: false, failureCode: "startup", reply: failureReply(input.taskId, "startup") };
      }

      // Do not normalize, trim, prefix, suffix, or otherwise transform input.prompt.
      const turn = this.client.runTurn(threadId, input.prompt, {
        approvalPolicy: "on-request",
        ...(this.options.model ? { model: this.options.model } : {}),
      });
      const messagesPromise = finalAgentText(turn.events).catch(() => []);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
      });

      const outcome = await Promise.race([
        turn.done.then(
          (result) => ({ type: "done" as const, result }),
          () => ({ type: "error" as const }),
        ),
        timeout.then(() => ({ type: "timeout" as const })),
      ]);
      if (timer) clearTimeout(timer);

      if (outcome.type === "timeout") {
        // Interrupt is best-effort. Do not let an unresponsive app-server turn
        // the worker's bounded task timeout into an unbounded wait.
        void turn.interrupt().catch(() => undefined);
        return { ok: false, failureCode: "timeout", reply: failureReply(input.taskId, "timeout"), threadId };
      }

      if (outcome.type === "error") {
        return { ok: false, failureCode: "failed", reply: failureReply(input.taskId, "failed"), threadId };
      }

      const code = this.failureCode(outcome.result);
      if (code) return { ok: false, failureCode: code, reply: failureReply(input.taskId, code), threadId };

      const messages = await messagesPromise;
      const reply = messages.at(-1);
      if (!reply) {
        return {
          ok: false,
          failureCode: "no-final-message",
          reply: failureReply(input.taskId, "no-final-message"),
          threadId,
        };
      }
      return { ok: true, reply, threadId };
    } catch {
      return { ok: false, failureCode: "failed", reply: failureReply(input.taskId, "failed"), ...(threadId ? { threadId } : {}) };
    } finally {
      this.activeTaskId = undefined;
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
    this.started = false;
  }

  private failureCode(result: TurnResult): CodexTaskFailureCode | undefined {
    if (result.status === "completed") return undefined;
    if (String(result.status).toLowerCase().includes("interrupt")) return "interrupted";
    return "failed";
  }
}
