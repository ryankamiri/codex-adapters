// Thin proxy: useChat POSTs here (same-origin, no CORS), and we forward to the
// Fastify backend that holds the codex runtime, streaming its SSE response back
// unchanged. Keeping the codex client in the backend (per the architecture) means
// this route is a dumb pipe.

export const runtime = "nodejs";
export const maxDuration = 300;

const BACKEND = process.env.CODEX_BACKEND_URL ?? "http://127.0.0.1:4000";

export async function POST(req: Request) {
  const body = await req.text();
  const upstream = await fetch(`${BACKEND}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
