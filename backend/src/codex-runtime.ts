// codex-runtime: one long-lived AppServerClient + thread, shared across chat
// requests. The client spawns a `codex app-server` child and holds thread state,
// so we start it once and reuse it — a per-request client would be slow and lose
// conversation context.

import { AppServerClient } from "./codex/client";

let runtimeP: Promise<{ client: AppServerClient; threadId: string }> | null = null;

export function getChatRuntime(): Promise<{ client: AppServerClient; threadId: string }> {
  if (!runtimeP) {
    runtimeP = (async () => {
      const client = new AppServerClient({
        includeDeltas: true, // stream token-level text/reasoning deltas to the UI
        defaultSandbox: "workspace-write",
        defaultApprovalPolicy: "on-request",
      });
      await client.start();
      const threadId = await client.startThread();
      return { client, threadId };
    })().catch((err) => {
      runtimeP = null; // allow a later retry if startup failed
      throw err;
    });
  }
  return runtimeP;
}

// Naive multi-thread routing: map each UI thread id (from the chat request body)
// to its own Codex thread on the shared client, creating one lazily on first use.
// The map is in-memory only — good enough "for now": the visible transcript is
// persisted client-side, and a backend restart just starts each thread fresh.
const threadMap = new Map<string, Promise<string>>();

export async function getThreadForClient(
  uiThreadId?: string,
): Promise<{ client: AppServerClient; threadId: string }> {
  const { client, threadId: defaultThread } = await getChatRuntime();
  if (!uiThreadId) return { client, threadId: defaultThread };

  let pending = threadMap.get(uiThreadId);
  if (!pending) {
    pending = client.startThread().catch((err) => {
      threadMap.delete(uiThreadId); // allow retry on next request
      throw err;
    });
    threadMap.set(uiThreadId, pending);
  }
  return { client, threadId: await pending };
}

// Serialize turns on the shared client — the app-server runs one turn at a time,
// so overlapping requests queue instead of colliding.
let chain: Promise<unknown> = Promise.resolve();
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
