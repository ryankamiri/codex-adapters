// Fastify backend for the chat UI. Holds the codex runtime and exposes a single
// streaming endpoint that the Next frontend proxies to:
//
//   POST /api/chat  { messages: UIMessage[] }  ->  SSE UI message stream
//
// It takes the latest user text, runs a codex turn on the shared thread, and maps
// each AgentEvent to AI SDK UI-message-stream chunks (see codex/ui-stream.ts).

import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { getChatRuntime, getThreadForClient, runExclusive } from "./codex-runtime";
import { codexEventToChunks, newStreamCtx, type UiChunk } from "./codex/ui-stream";
import type { TurnHandle } from "./codex/contract";
import { listImessageUiThreads } from "./imessage-harness/thread-feed";

// Fastify's default bodyLimit is 1 MiB, which a single chat request can exceed
// (a pasted blob or an image attachment) — the client then sees an opaque HTTP
// 413. The frontend already sends only the latest user message rather than the
// whole transcript, so this is just headroom for one large message. Safe to be
// generous: the server binds to 127.0.0.1 only.
const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });

// The in-flight turn per UI thread, so POST /api/interrupt (or a client disconnect)
// can stop it mid-stream via turn/interrupt.
const activeTurns = new Map<string, TurnHandle>();

app.get("/health", async () => ({ status: "ok" }));

// Trusted inbound texts run in the detached listener process, so expose their
// durable task records to the browser. The frontend turns each record into a
// normal visible sidebar thread and updates it as the task completes.
app.get("/api/imessage/threads", async (_req, reply) => {
  return reply.send({ threads: listImessageUiThreads() });
});

// Keep one quiet connection open for live sidebar updates. A snapshot is sent
// only when the durable ledger changes; this replaces browser polling that
// generated a pair of HTTP log lines every 1.5 seconds.
app.get("/api/imessage/events", async (req, reply) => {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  raw.write("retry: 10000\n\n");

  let previous = "";
  const publish = () => {
    if (raw.destroyed || raw.writableEnded) return;
    try {
      const payload = JSON.stringify({ threads: listImessageUiThreads() });
      if (payload === previous) return;
      previous = payload;
      raw.write(`event: threads\ndata: ${payload}\n\n`);
    } catch (error) {
      req.log.error({ error }, "failed to read iMessage thread feed");
    }
  };

  publish();
  const feedTimer = setInterval(publish, 1_500);
  const heartbeatTimer = setInterval(() => {
    if (!raw.destroyed && !raw.writableEnded) raw.write(": keep-alive\n\n");
  }, 15_000);
  raw.on("close", () => {
    clearInterval(feedTimer);
    clearInterval(heartbeatTimer);
  });
});

// Serve snapshot artifacts so the workspace panel can render them as
// <img src="/artifacts?path=<abs>">. Agents write screenshots wherever they like
// (adapters use ARTIFACTS_DIR, but a raw `screencapture` may target /private/tmp),
// so we serve any image file whose real path sits under a small set of safe roots.
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? join(process.cwd(), "data", "artifacts");
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const ALLOWED_ROOTS = [
  ARTIFACTS_DIR,
  join(process.cwd(), "data"),
  tmpdir(),
  "/tmp",
  "/private/tmp",
  "/private/var/folders",
  "/var/folders",
];

app.get("/artifacts", async (req, reply) => {
  const requested = (req.query as { path?: string }).path ?? "";
  if (!requested) return reply.code(400).send({ error: "missing path" });

  const mime = IMAGE_MIME[extname(requested).toLowerCase()];
  if (!mime) return reply.code(415).send({ error: "unsupported type" });

  const abs = isAbsolute(requested) ? requested : join(ARTIFACTS_DIR, requested);
  try {
    const real = await realpath(abs); // resolves symlinks (/tmp -> /private/tmp on macOS)
    const allowed = ALLOWED_ROOTS.some((root) => real === root || real.startsWith(root + "/"));
    if (!allowed) return reply.code(403).send({ error: "forbidden" });
    return reply.type(mime).send(await readFile(real));
  } catch {
    return reply.code(404).send({ error: "not found" });
  }
});

interface ChatBody {
  threadId?: string;
  model?: string;
  messages?: Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>;
}

function latestUserText(body: ChatBody): string {
  const messages = body?.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return (lastUser?.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

app.post("/api/chat", async (req, reply) => {
  const body = req.body as ChatBody;
  const text = latestUserText(body);
  const uiThreadId = body?.threadId;
  const model = body?.model;

  // Take over the raw socket and stream Server-Sent Events ourselves.
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "x-vercel-ai-ui-message-stream": "v1",
  });
  const write = (chunk: UiChunk) => raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
  const done = () => {
    raw.write("data: [DONE]\n\n");
    raw.end();
  };

  if (!text) {
    write({ type: "start" });
    write({ type: "error", errorText: "empty message" });
    write({ type: "finish" });
    return done();
  }

  try {
    const { client, threadId } = await getThreadForClient(uiThreadId);
    await runExclusive(async () => {
      write({ type: "start" });
      write({ type: "start-step" });
      const ctx = newStreamCtx();
      const turn = client.runTurn(threadId, text, model ? { model } : undefined);

      // Register for interrupt, and stop the turn if the client disconnects before
      // it finishes (covers the composer's Stop button aborting the fetch).
      const key = uiThreadId ?? threadId;
      activeTurns.set(key, turn);
      let finished = false;
      raw.on("close", () => {
        if (!finished) turn.interrupt().catch(() => {});
      });

      try {
        for await (const e of turn.events) {
          for (const chunk of codexEventToChunks(e, ctx)) write(chunk);
        }
        await turn.done;
      } finally {
        finished = true;
        if (activeTurns.get(key) === turn) activeTurns.delete(key);
      }
      write({ type: "finish-step" });
      write({ type: "finish" });
    });
  } catch (err: any) {
    write({ type: "error", errorText: err?.message ?? String(err) });
    write({ type: "finish" });
  } finally {
    done();
  }
});

// Stop the in-flight turn for a thread (composer Stop button).
app.post("/api/interrupt", async (req, reply) => {
  const { threadId } = (req.body as { threadId?: string }) ?? {};
  const turn = threadId ? activeTurns.get(threadId) : undefined;
  if (turn) await turn.interrupt().catch(() => {});
  return reply.send({ ok: true, interrupted: Boolean(turn) });
});

// Available Codex models for the picker. Includes models the catalog marks
// "hidden" (hidden from the default list) so choices like gpt-5.4-mini still show;
// pass ?includeHidden=false to hide them.
app.get("/api/models", async (req, reply) => {
  const includeHidden = (req.query as { includeHidden?: string })?.includeHidden !== "false";
  const { client } = await getChatRuntime();
  const models = await client.listModels(true);
  return reply.send({
    models: models
      // include hidden chat models (e.g. gpt-5.4-mini) but drop internal/system
      // models like codex-auto-review that aren't user-selectable chat models.
      .filter((m) => (includeHidden || !m.hidden) && !/review/i.test(m.id))
      .map((m) => ({
        id: m.id,
        model: m.model,
        displayName: m.displayName,
        description: m.description,
        isDefault: m.isDefault,
        defaultReasoningEffort: m.defaultReasoningEffort,
      })),
  });
});

// Hot-reload MCP config so newly-added servers appear without restarting the app.
app.post("/api/mcp/reload", async (_req, reply) => {
  const { client } = await getChatRuntime();
  await client.reloadMcpConfig();
  const servers = await client.listMcpServers();
  return reply.send({
    ok: true,
    servers: servers.map((s: any) => ({
      name: s.name ?? s.server ?? "",
      status: s.status ?? "",
      tools: Array.isArray(s.tools) ? s.tools.length : undefined,
    })),
  });
});

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "127.0.0.1" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
