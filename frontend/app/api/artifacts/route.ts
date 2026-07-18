// Proxies snapshot artifacts from the Fastify backend so the workspace panel can
// render them same-origin: <img src="/api/artifacts?path=<abs>"> -> backend
// /artifacts?path=<abs>. The path is the absolute file the agent wrote (e.g. a
// screencapture target); the backend validates it against a set of safe roots.

export const runtime = "nodejs";

const BACKEND = process.env.CODEX_BACKEND_URL ?? "http://127.0.0.1:4000";

export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path");
  if (!path) return new Response("missing path", { status: 400 });

  const upstream = await fetch(`${BACKEND}/artifacts?path=${encodeURIComponent(path)}`);
  if (!upstream.ok) return new Response("not found", { status: upstream.status });

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "public, max-age=60",
    },
  });
}
