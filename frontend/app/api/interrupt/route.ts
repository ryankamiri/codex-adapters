// Proxies a turn-interrupt (composer Stop button) to the backend.
export const runtime = "nodejs";

const BACKEND = process.env.CODEX_BACKEND_URL ?? "http://127.0.0.1:4000";

export async function POST(req: Request) {
  const body = await req.text();
  const upstream = await fetch(`${BACKEND}/api/interrupt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
