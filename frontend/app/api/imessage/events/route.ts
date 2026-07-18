export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND = process.env.CODEX_BACKEND_URL ?? "http://127.0.0.1:4000";

export async function GET(request: Request) {
  try {
    const upstream = await fetch(`${BACKEND}/api/imessage/events`, {
      cache: "no-store",
      signal: request.signal,
      headers: { accept: "text/event-stream" },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  } catch {
    // EventSource reconnects automatically. Keep backend-offline retries quiet
    // instead of falling back to its short browser-default retry interval.
    return new Response("retry: 30000\nevent: threads\ndata: {\"threads\":[]}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }
}
