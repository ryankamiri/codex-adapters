export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND = process.env.CODEX_BACKEND_URL ?? "http://127.0.0.1:4000";

export async function GET() {
  try {
    const upstream = await fetch(`${BACKEND}/api/imessage/threads`, { cache: "no-store" });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch {
    return Response.json({ threads: [] }, { status: 503 });
  }
}
