import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnStartParams } from "../../src/codex/client";

test("turn/start requests automatic reasoning summaries by default", () => {
  assert.deepEqual(buildTurnStartParams("thread-1", "hello"), {
    threadId: "thread-1",
    input: [{ type: "text", text: "hello", text_elements: [] }],
    summary: "auto",
  });
});

test("turn/start preserves an explicit reasoning summary override", () => {
  const params = buildTurnStartParams("thread-1", "hello", {
    model: "example-model",
    summary: "none",
  });

  assert.equal(params.summary, "none");
  assert.equal(params.model, "example-model");
});
