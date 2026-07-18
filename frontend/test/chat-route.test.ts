import assert from "node:assert/strict";
import test from "node:test";

import { resilientSseBody } from "../app/api/chat/route";

const encoder = new TextEncoder();

test("turns an unexpected upstream socket failure into a complete SSE response", async () => {
  let pullCount = 0;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pullCount++ === 0) controller.enqueue(encoder.encode('data: {"type":"start"}\n\n'));
      else controller.error(new Error("socket closed"));
    },
  }, { highWaterMark: 0 });

  const text = await new Response(resilientSseBody(upstream, new AbortController().signal)).text();
  assert.match(text, /"type":"start"/);
  assert.match(text, /"type":"error"/);
  assert.match(text, /"type":"finish"/);
  assert.match(text, /data: \[DONE\]/);
});

test("does not synthesize an error when the downstream request was intentionally aborted", async () => {
  const abort = new AbortController();
  abort.abort();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("aborted socket"));
    },
  });

  const text = await new Response(resilientSseBody(upstream, abort.signal)).text();
  assert.equal(text, "");
});
