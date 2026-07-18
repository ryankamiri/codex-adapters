// CodexClient: drives a `codex app-server` child over JSON-RPC and exposes a
// typed, streaming API. All raw-protocol handling lives here + translate.ts.

import { spawnAppServer, type Transport } from "./transport";
import { translate, DELTA_METHODS } from "./translate";
import { autoAcceptPolicy, type ApprovalPolicy } from "./approvals";
import type {
  AgentEvent,
  PartialEvent,
  CodexClient,
  ThreadOptions,
  TurnOptions,
  TurnHandle,
  TurnResult,
  InitializeResponse,
  McpServerStatus,
  Model,
  UserInput,
} from "./contract";

// Minimal single-consumer async stream: push()/end() feed `for await`.
class EventStream implements AsyncIterable<AgentEvent> {
  private queue: AgentEvent[] = [];
  private waiters: ((r: IteratorResult<AgentEvent>) => void)[] = [];
  private ended = false;

  push(e: AgentEvent) {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: e, done: false });
    else this.queue.push(e);
  }
  end() {
    this.ended = true;
    let w;
    while ((w = this.waiters.shift())) w({ value: undefined as any, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    while (true) {
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.ended) return;
      const r = await new Promise<IteratorResult<AgentEvent>>((res) => this.waiters.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

export interface ClientOptions {
  bin?: string;
  cwd?: string;
  includeDeltas?: boolean;
  defaultSandbox?: ThreadOptions["sandbox"];
  defaultApprovalPolicy?: ThreadOptions["approvalPolicy"];
  approvals?: ApprovalPolicy;
  journal?: (line: string, dir: "in" | "out") => void;
  forwardStderr?: boolean; // pipe app-server stderr to our stderr (default true)
}

const normInput = (input: string | UserInput[]): UserInput[] =>
  typeof input === "string" ? [{ type: "text", text: input, text_elements: [] }] : input;

export const buildTurnStartParams = (
  threadId: string,
  input: string | UserInput[],
  opts?: TurnOptions,
): Record<string, unknown> => {
  const params: Record<string, unknown> = {
    threadId,
    input: normInput(input),
    summary: opts?.summary ?? "auto",
  };
  if (opts?.model) params.model = opts.model;
  if (opts?.approvalPolicy) params.approvalPolicy = opts.approvalPolicy;
  if (opts?.writableRoots) {
    params.sandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: opts.writableRoots,
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return params;
};

export class AppServerClient implements CodexClient {
  private transport?: Transport;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private subscribers = new Set<(e: AgentEvent) => void>();
  private globalStreams = new Set<EventStream>();
  private seq = 0;
  private closed = false;
  private approvals: ApprovalPolicy;
  private includeDeltas: boolean;

  constructor(private opts: ClientOptions = {}) {
    this.approvals = opts.approvals ?? autoAcceptPolicy();
    this.includeDeltas = opts.includeDeltas ?? false;
  }

  // ── event fan-out ──
  private emit(p: PartialEvent) {
    const e = { v: 1 as const, seq: this.seq++, ts: Date.now(), ...p } as AgentEvent;
    for (const sub of [...this.subscribers]) sub(e);
  }
  get events(): AsyncIterable<AgentEvent> {
    const stream = new EventStream();
    this.subscribers.add((e) => stream.push(e));
    this.globalStreams.add(stream);
    return stream;
  }

  // Emit session:closed, reject in-flight requests, and end global streams — once.
  private doShutdown(code?: number | null) {
    if (this.closed) return;
    this.closed = true;
    this.emit({ kind: "session", phase: "closed" });
    for (const { reject } of this.pending.values()) reject(new Error(`app-server closed${code != null ? ` (${code})` : ""}`));
    this.pending.clear();
    for (const s of this.globalStreams) s.end();
  }

  // ── request/response correlation ──
  private request(method: string, params?: unknown): Promise<any> {
    if (!this.transport) throw new Error("client not started");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport!.send(params === undefined ? { method, id } : { method, id, params });
    });
  }

  async start(): Promise<InitializeResponse> {
    this.emit({ kind: "session", phase: "starting" });
    this.transport = spawnAppServer({
      bin: this.opts.bin,
      cwd: this.opts.cwd,
      journal: this.opts.journal,
      onStderr:
        this.opts.forwardStderr === false ? undefined : (s) => process.stderr.write(`\x1b[2m[app-server] ${s}\x1b[0m`),
    });

    this.transport.onMessage((msg: any) => this.route(msg));
    this.transport.onClose((code) => this.doShutdown(code));

    const capabilities: Record<string, unknown> = { experimentalApi: false, requestAttestation: false };
    if (!this.includeDeltas) capabilities.optOutNotificationMethods = DELTA_METHODS; // suppress deltas at the source
    const info: InitializeResponse = await this.request("initialize", {
      clientInfo: { name: "relay", title: "Relay", version: "0.1.0" },
      capabilities,
    });
    this.transport.send({ method: "initialized" });
    this.emit({ kind: "session", phase: "ready", info });
    return info;
  }

  private route(msg: any) {
    // response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result);
      }
      return;
    }
    // server-initiated request (approval/elicitation) — auto-answer, log as an event
    if (msg.id !== undefined && msg.method !== undefined) {
      const outcome = this.approvals(msg.method, msg.params);
      this.transport!.send({ id: msg.id, result: outcome.response });
      this.emit({
        kind: "approval",
        method: msg.method,
        auto: true,
        describe: outcome.describe,
        params: msg.params,
        response: outcome.response,
        threadId: msg.params?.threadId,
        turnId: msg.params?.turnId,
      });
      return;
    }
    // notification
    if (msg.method !== undefined) {
      for (const body of translate(msg, { includeDeltas: this.includeDeltas })) this.emit(body);
    }
  }

  async startThread(opts?: ThreadOptions): Promise<string> {
    const result = await this.request("thread/start", {
      cwd: opts?.cwd ?? this.opts.cwd ?? process.cwd(),
      approvalPolicy: opts?.approvalPolicy ?? this.opts.defaultApprovalPolicy ?? "on-request",
      sandbox: opts?.sandbox ?? this.opts.defaultSandbox ?? "workspace-write",
    });
    return result.thread.id; // id lives at result.thread.id (NOT result.threadId)
  }

  runTurn(threadId: string, input: string | UserInput[], opts?: TurnOptions): TurnHandle {
    const stream = new EventStream();
    let myTurnId: string | null = null;
    let resolveTurnId!: (id: string) => void;
    const turnIdP = new Promise<string>((r) => (resolveTurnId = r));
    let resolveDone!: (r: TurnResult) => void;
    const doneP = new Promise<TurnResult>((r) => (resolveDone = r));
    const preTurnBuffer: AgentEvent[] = [];
    let finished = false;

    const finish = (r: TurnResult) => {
      if (finished) return;
      finished = true;
      this.subscribers.delete(sub);
      resolveDone(r);
      stream.end();
    };
    const handle = (e: AgentEvent) => {
      if (e.turnId && e.turnId !== myTurnId) return; // belongs to a different turn
      stream.push(e);
      if (e.kind === "turn" && e.phase === "completed" && e.turnId === myTurnId) {
        finish({ status: e.status ?? ("failed" as TurnResult["status"]), error: e.error ?? null });
      }
    };
    // Subscribe BEFORE sending turn/start so no early notification is missed.
    // Until we learn our turnId, buffer; then flush + go live.
    const sub = (e: AgentEvent) => {
      if (myTurnId === null) preTurnBuffer.push(e);
      else handle(e);
    };
    this.subscribers.add(sub);

    void (async () => {
      try {
        const params = buildTurnStartParams(threadId, input, opts);
        const result = await this.request("turn/start", params);
        const tid: string = result.turn.id; // id at result.turn.id
        myTurnId = tid;
        resolveTurnId(tid);
        for (const e of preTurnBuffer.splice(0)) handle(e);
      } catch (err: any) {
        this.emit({ kind: "error", message: `turn/start failed: ${err?.message ?? JSON.stringify(err)}`, willRetry: false, detail: err, threadId });
        finish({ status: "failed" as TurnResult["status"] });
      }
    })();

    return {
      turnId: turnIdP,
      events: stream,
      done: doneP,
      interrupt: async () => {
        if (myTurnId) await this.interrupt(threadId, myTurnId);
      },
    };
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async listModels(includeHidden = false): Promise<Model[]> {
    const out: Model[] = [];
    let cursor: string | null | undefined;
    do {
      const res = await this.request("model/list", { includeHidden, ...(cursor ? { cursor } : {}) });
      out.push(...(res?.data ?? []));
      cursor = res?.nextCursor;
    } while (cursor);
    return out;
  }

  async listMcpServers(): Promise<McpServerStatus[]> {
    const out: McpServerStatus[] = [];
    let cursor: string | null | undefined;
    do {
      const res = await this.request("mcpServerStatus/list", cursor ? { cursor } : {});
      out.push(...(res?.data ?? []));
      cursor = res?.nextCursor;
    } while (cursor);
    return out;
  }

  async reloadMcpConfig(): Promise<void> {
    await this.request("config/mcpServer/reload", {});
  }

  async close(): Promise<void> {
    this.doShutdown();
    this.transport?.close();
  }
}
