// The contract: the stable, versioned surface every consumer reads.
//
// Design principle — no lost information or "shape":
//   Each event is a small stable *envelope* (easy to route/render) wrapping the
//   *untouched raw payload* (`item: ThreadItem`, or `params` on a `raw` event).
//   translate.ts is ADDITIVE — it spreads the original payload through and only
//   *adds* a human `title`. Nothing from the app-server is ever summarized away.
//
// Types come straight from the generated bindings in ./protocol, so `item: ThreadItem`
// is provably the exact app-server shape, checked by the compiler.

import type { ThreadItem } from "./protocol/v2/ThreadItem";
import type { TurnStatus } from "./protocol/v2/TurnStatus";
import type { TurnError } from "./protocol/v2/TurnError";
import type { ThreadStatus } from "./protocol/v2/ThreadStatus";
import type { McpServerStatus } from "./protocol/v2/McpServerStatus";
import type { SandboxMode } from "./protocol/v2/SandboxMode";
import type { AskForApproval } from "./protocol/v2/AskForApproval";
import type { UserInput } from "./protocol/v2/UserInput";
import type { Model } from "./protocol/v2/Model";
import type { InitializeResponse } from "./protocol/InitializeResponse";

export type { ThreadItem, TurnStatus, TurnError, McpServerStatus, Model, InitializeResponse, UserInput };

// ── The event ────────────────────────────────────────────────────────────────
export interface Envelope {
  v: 1; // schema version — bump on a breaking change to the contract
  seq: number; // monotonic per process; ordering + loss detection
  ts: number; // our clock (ms epoch)
  threadId?: string;
  turnId?: string;
}

export type ItemPhase = "started" | "delta" | "completed";

export type AgentEventBody =
  | { kind: "session"; phase: "starting" | "ready" | "closed"; info?: InitializeResponse }
  | { kind: "thread"; status: ThreadStatus }
  | { kind: "turn"; phase: "started" | "completed"; status?: TurnStatus; error?: TurnError | null }
  // item: `title` is the only interpretation we add; `item` is the raw, full-shape payload.
  | { kind: "item"; phase: ItemPhase; itemType: ThreadItem["type"]; title: string; item: ThreadItem }
  | { kind: "approval"; method: string; auto: boolean; describe: string; params: unknown; response: unknown }
  | { kind: "mcp"; phase: "startup" | "list"; server?: string; status?: string; data?: unknown }
  | { kind: "error"; message: string; willRetry: boolean; detail?: unknown }
  | { kind: "notice"; level: "info" | "warn" | "debug"; message: string }
  // Lossless catch-all: any notification we don't specifically model still passes
  // through in full (visible in --json), so nothing is ever silently dropped.
  | { kind: "raw"; method: string; params: unknown };

export type AgentEvent = Envelope & AgentEventBody;

// Body plus the correlation ids, before the client stamps v/seq/ts.
export type PartialEvent = AgentEventBody & { threadId?: string; turnId?: string };

// ── How you drive the agent ────────────────────────────────────────────────
export interface ThreadOptions {
  cwd?: string;
  sandbox?: SandboxMode; // "read-only" | "workspace-write" | "danger-full-access"
  approvalPolicy?: AskForApproval; // "untrusted" | "on-request" | "never" | { granular }
}

export interface TurnOptions {
  writableRoots?: string[]; // when set, sent as a workspace-write sandboxPolicy for this turn
  approvalPolicy?: AskForApproval;
  model?: string;
}

export interface TurnResult {
  status: TurnStatus;
  error?: TurnError | null;
}

export interface TurnHandle {
  turnId: Promise<string>;
  events: AsyncIterable<AgentEvent>; // scoped to THIS turn
  done: Promise<TurnResult>; // resolves on turn/completed
  interrupt(): Promise<void>;
}

export interface CodexClient {
  start(): Promise<InitializeResponse>; // spawn + initialize -> initialized
  startThread(opts?: ThreadOptions): Promise<string>; // -> threadId
  runTurn(threadId: string, input: string | UserInput[], opts?: TurnOptions): TurnHandle;
  interrupt(threadId: string, turnId: string): Promise<void>; // turn/interrupt needs BOTH ids
  listModels(includeHidden?: boolean): Promise<Model[]>; // model/list
  listMcpServers(): Promise<McpServerStatus[]>;
  reloadMcpConfig(): Promise<void>;
  close(): Promise<void>;
  readonly events: AsyncIterable<AgentEvent>; // global stream (all turns)
}
