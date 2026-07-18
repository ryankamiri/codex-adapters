// Lists the registered MCP servers and the tools each one exposes, for the
// workspace "Servers" tab. Read-only counterpart to /api/mcp/reload.
export const runtime = "nodejs";

const BACKEND = process.env.CODEX_BACKEND_URL ?? "http://127.0.0.1:4000";

export async function GET() {
  const upstream = await fetch(`${BACKEND}/api/mcp/servers`, { cache: "no-store" });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
