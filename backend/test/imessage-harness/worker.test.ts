import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, CodexClient, ThreadOptions, TurnHandle, TurnOptions } from "../../src/codex/contract";
import { CodexTaskWorker } from "../../src/imessage-harness/codex-worker";

async function* events(...values: AgentEvent[]): AsyncIterable<AgentEvent> {
  yield* values;
}

const agentMessage = (text: string, seq: number): AgentEvent =>
  ({
    v: 1,
    seq,
    ts: seq,
    kind: "item",
    phase: "completed",
    itemType: "agentMessage",
    title: text,
    item: { type: "agentMessage", id: `item-${seq}`, text },
  }) as AgentEvent;

class FakeClient {
  started = 0;
  closed = 0;
  interrupted = 0;
  threadOptions?: ThreadOptions;
  turnInput?: string | unknown[];
  turnOptions?: TurnOptions;
  handle: TurnHandle;
  globalEvents: AsyncIterable<AgentEvent> = events();

  constructor(handle?: TurnHandle) {
    this.handle =
      handle ??
      ({
        turnId: Promise.resolve("turn-1"),
        events: events(agentMessage("first", 1), agentMessage("final reply", 2)),
        done: Promise.resolve({ status: "completed", error: null }),
        interrupt: async () => {
          this.interrupted++;
        },
      } as TurnHandle);
  }

  async start() {
    this.started++;
    return {} as any;
  }
  async startThread(options?: ThreadOptions) {
    this.threadOptions = options;
    return "thread-1";
  }
  runTurn(_threadId: string, input: string | unknown[], options?: TurnOptions) {
    this.turnInput = input;
    this.turnOptions = options;
    return this.handle;
  }
  async close() {
    this.closed++;
  }
  async interrupt() {}
  async listModels() { return []; }
  async listMcpServers() { return []; }
  async reloadMcpConfig() {}
  get events(): AsyncIterable<AgentEvent> { return this.globalEvents; }
}

test("passes inbound text unchanged, uses locked-down defaults, and returns the final completed message", async () => {
  const client = new FakeClient();
  const worker = new CodexTaskWorker({ allowedMcpServers: ["obs-mcp"], client: client as CodexClient });
  const prompt = "  Please record this.\nDo not rewrite me.  ";

  const result = await worker.execute({ taskId: "msg_1", prompt });

  assert.deepEqual(result, { ok: true, reply: "final reply", threadId: "thread-1" });
  assert.equal(client.turnInput, prompt);
  assert.deepEqual(client.threadOptions, { cwd: undefined, sandbox: "read-only", approvalPolicy: "never" });
  assert.deepEqual(client.turnOptions, { approvalPolicy: "never" });
  assert.equal(client.started, 1);

  await worker.execute({ taskId: "msg_2", prompt: "again" });
  assert.equal(client.started, 1, "the long-lived client should initialize once");
});

test("interrupts on timeout and returns a deterministic response", async () => {
  let interrupted = 0;
  const handle = {
    turnId: Promise.resolve("turn-slow"),
    events: (async function* () { await new Promise(() => undefined); })(),
    done: new Promise(() => undefined),
    interrupt: async () => { interrupted++; },
  } as TurnHandle;
  const client = new FakeClient(handle);
  const worker = new CodexTaskWorker({ allowedMcpServers: [], client: client as CodexClient, timeoutMs: 5 });

  const result = await worker.execute({ taskId: "msg timeout!", prompt: "slow task" });

  assert.deepEqual(result, {
    ok: false,
    failureCode: "timeout",
    reply: "I couldn't complete that task. It timed out before completion. Task ID: msg_timeout_",
    threadId: "thread-1",
  });
  assert.equal(interrupted, 1);
});

test("does not leak app-server errors and distinguishes a missing final message", async () => {
  const failedClient = new FakeClient({
    turnId: Promise.resolve("turn-failed"),
    events: events(),
    done: Promise.resolve({ status: "failed", error: { message: "SECRET internal path" } as any }),
    interrupt: async () => {},
  });
  const failed = await new CodexTaskWorker({ allowedMcpServers: [], client: failedClient as CodexClient }).execute({
    taskId: "msg_3",
    prompt: "task",
  });
  assert.equal(failed.ok, false);
  assert.equal((failed as any).failureCode, "failed");
  assert.doesNotMatch(failed.reply, /SECRET|internal path/);

  const emptyClient = new FakeClient({
    turnId: Promise.resolve("turn-empty"),
    events: events(agentMessage("   ", 1)),
    done: Promise.resolve({ status: "completed", error: null }),
    interrupt: async () => {},
  });
  const empty = await new CodexTaskWorker({ allowedMcpServers: [], client: emptyClient as CodexClient }).execute({ taskId: "msg_4", prompt: "task" });
  assert.equal(empty.ok, false);
  assert.equal((empty as any).failureCode, "no-final-message");
});

test("developer event callbacks are best-effort and never alter the user-visible reply", async () => {
  const client = new FakeClient();
  const debugEvent = {
    v: 1,
    seq: 9,
    ts: 9,
    kind: "mcp",
    phase: "startup",
    server: "messages-mcp",
    status: "ready",
  } as AgentEvent;
  client.globalEvents = events(debugEvent);
  const seen: AgentEvent[] = [];
  const worker = new CodexTaskWorker({
    allowedMcpServers: [],
    client: client as CodexClient,
    onEvent(event) {
      seen.push(event);
      throw new Error("debug sink failed");
    },
  });

  const result = await worker.execute({ taskId: "msg-debug", prompt: "hello" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { ok: true, reply: "final reply", threadId: "thread-1" });
  assert.deepEqual(seen, [debugEvent]);
});
