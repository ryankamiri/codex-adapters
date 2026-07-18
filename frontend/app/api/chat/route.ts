// Thin proxy: useChat POSTs here (same-origin, no CORS), and we forward to the
// Fastify backend that holds the codex runtime, streaming its SSE response back
// unchanged. Keeping the codex client in the backend (per the architecture) means
// this route is a dumb pipe.

export const runtime = "nodejs";
export const maxDuration = 300;

const BACKEND = process.env.CODEX_BACKEND_URL ?? "http://127.0.0.1:4000";

const encoder = new TextEncoder();

function terminalSse(message: string): string {
  return (
    `data: ${JSON.stringify({ type: "error", errorText: message })}\n\n` +
    `data: ${JSON.stringify({ type: "finish" })}\n\n` +
    "data: [DONE]\n\n"
  );
}

/**
 * Convert an abruptly closed upstream body into a valid terminal UI-message
 * stream. Returning the undici body directly lets a socket reset escape into
 * Next's response pipe, which turns an otherwise recoverable turn failure into
 * a route-level 500.
 */
export function resilientSseBody(upstream: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          controller.close();
          return;
        }
        const text = decoder.decode(value, { stream: true });
        tail = (tail + text).slice(-64);
        controller.enqueue(value);
      } catch {
        closed = true;
        // A user pressing Stop aborts the browser request intentionally. For an
        // unexpected backend close, finish the protocol cleanly so useChat can
        // leave its streaming state and show a useful error instead of a 500.
        if (!signal.aborted && !tail.includes("data: [DONE]")) {
          controller.enqueue(encoder.encode(terminalSse("The Codex backend connection closed before the turn completed.")));
        }
        controller.close();
      }
    },
    async cancel(reason) {
      closed = true;
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export async function POST(req: Request) {
  const body = await req.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: req.signal,
    });
  } catch {
    return new Response(terminalSse("The Codex backend is unavailable."), {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-vercel-ai-ui-message-stream": "v1",
      },
    });
  }

  const responseBody = upstream.body ? resilientSseBody(upstream.body, req.signal) : null;

  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
