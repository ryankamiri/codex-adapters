// Proxies the model list from the Fastify backend (which asks the codex app-server).
export const runtime = "nodejs";

const BACKEND = process.env.CODEX_BACKEND_URL ?? "http://127.0.0.1:4000";

export async function GET() {
  const upstream = await fetch(`${BACKEND}/api/models`);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
