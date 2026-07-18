// Proxies snapshot artifacts from the Fastify backend so the workspace panel can
// render them same-origin: <img src="/api/artifacts?path=<abs>"> -> backend
// /artifacts?path=<abs>. The path is the absolute file the agent wrote (e.g. a
// screencapture target); the backend validates it against a set of safe roots.
//
// Also serves screen recordings for <video>. That means passing Range through in
// both directions: the browser sends one, and the 206 + Content-Range coming back
// must survive the proxy or the player can't seek (and Safari won't play at all).

export const runtime = "nodejs";

const BACKEND = process.env.CODEX_BACKEND_URL ?? "http://127.0.0.1:4000";

export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path");
  if (!path) return new Response("missing path", { status: 400 });

  const range = req.headers.get("range");
  const upstream = await fetch(`${BACKEND}/artifacts?path=${encodeURIComponent(path)}`, {
    headers: range ? { range } : undefined,
    // Range responses must never be cached as if they were the whole file.
    cache: "no-store",
  });
  // 206 is a success but not `ok`-only — check explicitly so partial content
  // isn't mistaken for a failure.
  if (!upstream.ok && upstream.status !== 206) {
    return new Response("not found", { status: upstream.status });
  }

  const headers = new Headers({
    "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
  });
  // Forward the range-related headers verbatim; without Content-Range a 206 is
  // meaningless to the browser.
  for (const h of ["accept-ranges", "content-range", "content-length"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("cache-control", upstream.status === 206 ? "no-store" : "public, max-age=60");

  return new Response(upstream.body, { status: upstream.status, headers });
}
