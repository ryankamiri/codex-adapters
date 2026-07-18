// Proxies an on-demand MCP config reload to the backend, which hot-reloads the
// codex app-server's MCP servers without restarting the app.
export const runtime = "nodejs";

const BACKEND = process.env.CODEX_BACKEND_URL ?? "http://127.0.0.1:4000";

export async function POST() {
  const upstream = await fetch(`${BACKEND}/api/mcp/reload`, { method: "POST" });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
