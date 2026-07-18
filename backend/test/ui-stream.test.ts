import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, PartialEvent } from "../src/codex/contract";
import { codexEventToChunks, newStreamCtx } from "../src/codex/ui-stream";

function event(body: PartialEvent, seq: number): AgentEvent {
  return { v: 1, seq, ts: seq, ...body } as AgentEvent;
}

function reasoning(
  phase: "started" | "completed",
  summary: unknown[] = [],
  content: unknown[] = [],
  id = "reasoning-1",
): AgentEvent {
  return event(
    {
      kind: "item",
      phase,
      itemType: "reasoning",
      title: "Reasoning",
      item: { type: "reasoning", id, summary: summary as string[], content: content as string[] },
    },
    phase === "started" ? 1 : 3,
  );
}

test("uses completed reasoning summary and content when no deltas arrive", () => {
  const ctx = newStreamCtx();

  assert.deepEqual(codexEventToChunks(reasoning("started"), ctx), [
    { type: "reasoning-start", id: "reasoning-1" },
  ]);
  assert.deepEqual(codexEventToChunks(reasoning("completed", ["Summary one", "Summary two"], ["Detail"]), ctx), [
    { type: "reasoning-delta", id: "reasoning-1", delta: "Summary one\n\nSummary two\n\nDetail" },
    { type: "reasoning-end", id: "reasoning-1" },
  ]);
});

test("does not duplicate completed reasoning after streaming deltas", () => {
  const ctx = newStreamCtx();
  codexEventToChunks(reasoning("started"), ctx);

  const delta = event(
    {
      kind: "raw",
      method: "item/reasoning/summaryTextDelta",
      params: { itemId: "reasoning-1", delta: "Streamed summary" },
    },
    2,
  );
  assert.deepEqual(codexEventToChunks(delta, ctx), [
    { type: "reasoning-delta", id: "reasoning-1", delta: "Streamed summary" },
  ]);
  assert.deepEqual(codexEventToChunks(reasoning("completed", ["Streamed summary"], ["Completed detail"]), ctx), [
    { type: "reasoning-end", id: "reasoning-1" },
  ]);
});

test("starts a reasoning block when completion arrives without a started event", () => {
  const ctx = newStreamCtx();

  assert.deepEqual(codexEventToChunks(reasoning("completed", ["Visible", "", 42], [null, "Detail"]), ctx), [
    { type: "reasoning-start", id: "reasoning-1" },
    { type: "reasoning-delta", id: "reasoning-1", delta: "Visible\n\nDetail" },
    { type: "reasoning-end", id: "reasoning-1" },
  ]);
});

test("starts delta-only reasoning and tracks fallback state independently by id", () => {
  const ctx = newStreamCtx();
  const delta = event(
    {
      kind: "raw",
      method: "item/reasoning/textDelta",
      params: { itemId: "reasoning-streamed", delta: "Live detail" },
    },
    1,
  );

  assert.deepEqual(codexEventToChunks(delta, ctx), [
    { type: "reasoning-start", id: "reasoning-streamed" },
    { type: "reasoning-delta", id: "reasoning-streamed", delta: "Live detail" },
  ]);
  assert.deepEqual(codexEventToChunks(reasoning("completed", ["Other summary"], [], "reasoning-fallback"), ctx), [
    { type: "reasoning-start", id: "reasoning-fallback" },
    { type: "reasoning-delta", id: "reasoning-fallback", delta: "Other summary" },
    { type: "reasoning-end", id: "reasoning-fallback" },
  ]);
  assert.deepEqual(codexEventToChunks(reasoning("completed", ["Live detail"], [], "reasoning-streamed"), ctx), [
    { type: "reasoning-end", id: "reasoning-streamed" },
  ]);
});
