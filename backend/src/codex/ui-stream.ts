// ui-stream: project a codex AgentEvent into AI SDK "UI message stream" chunks.
//
// This is render.ts's sibling — same event union, but instead of ANSI terminal
// lines it emits the chunk shapes the Vercel AI SDK (useChat) + AI Elements render:
//   text-*        -> <MessageResponse>
//   reasoning-*   -> <Reasoning>
//   tool-*        -> <Tool> (dynamic tool, toolName = "server.tool")
//   data-*        -> custom parts (approvals, commands, file changes, mcp status)
//   error         -> error part
// Wire shapes per ai-sdk.dev "Stream Protocol". The route frames start/finish/[DONE].

import type { AgentEvent } from "./contract";

export type UiChunk =
  | { type: "start"; messageId?: string }
  | { type: "finish" }
  | { type: "start-step" }
  | { type: "finish-step" }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-output-available"; toolCallId: string; output: unknown }
  | { type: "tool-output-error"; toolCallId: string; errorText: string }
  | { type: "data-approval"; data: { method: string; describe: string } }
  | { type: "data-command"; data: { command: string; status: string; exitCode: number | null } }
  | { type: "data-file-change"; data: { status: string; paths: string[] } }
  | { type: "data-mcp"; data: { server: string; status: string } }
  | { type: "error"; errorText: string };

// Per-turn state: which tool calls have already emitted their input part, so a
// completed item that never had a "started" still produces input before output.
export interface StreamCtx {
  started: Set<string>;
}
export const newStreamCtx = (): StreamCtx => ({ started: new Set() });

export function codexEventToChunks(e: AgentEvent, ctx: StreamCtx): UiChunk[] {
  switch (e.kind) {
    case "item": {
      const it = e.item as any; // projection layer; item shapes known from translate.ts

      // Text + reasoning stream token-by-token via the "raw" delta events below.
      // Here we only open the block on start and close it on completion.
      if (e.itemType === "agentMessage") {
        const id = String(it.id ?? `t-${e.seq}`);
        if (e.phase === "started") return [{ type: "text-start", id }];
        if (e.phase === "completed") return [{ type: "text-end", id }];
        return [];
      }

      if (e.itemType === "reasoning") {
        const id = String(it.id ?? `r-${e.seq}`);
        if (e.phase === "started") return [{ type: "reasoning-start", id }];
        if (e.phase === "completed") return [{ type: "reasoning-end", id }];
        return [];
      }

      if (e.itemType === "mcpToolCall") {
        const toolCallId = String(it.id ?? `tool-${e.seq}`);
        const toolName = `${it.server ?? "mcp"}.${it.tool ?? "tool"}`;
        const out: UiChunk[] = [];
        const ensureInput = () => {
          if (!ctx.started.has(toolCallId)) {
            ctx.started.add(toolCallId);
            out.push({ type: "tool-input-available", toolCallId, toolName, input: it.arguments ?? {} });
          }
        };
        if (e.phase === "started") {
          ensureInput();
        } else if (e.phase === "completed") {
          ensureInput();
          if (it.error) out.push({ type: "tool-output-error", toolCallId, errorText: String(it.error?.message ?? it.error) });
          else out.push({ type: "tool-output-available", toolCallId, output: it.result ?? {} });
        }
        return out;
      }

      if (e.itemType === "commandExecution") {
        if (e.phase !== "completed") return [];
        return [{ type: "data-command", data: { command: String(it.command ?? ""), status: String(it.status ?? ""), exitCode: it.exitCode ?? null } }];
      }

      if (e.itemType === "fileChange") {
        if (e.phase !== "completed") return [];
        return [{ type: "data-file-change", data: { status: String(it.status ?? ""), paths: (it.changes ?? []).map((c: any) => c.path) } }];
      }

      return []; // plan/webSearch/etc. — not surfaced in chat yet
    }

    case "approval":
      return [{ type: "data-approval", data: { method: e.method, describe: e.describe } }];

    case "mcp":
      if (e.phase === "startup") return [{ type: "data-mcp", data: { server: e.server ?? "", status: e.status ?? "" } }];
      return [];

    case "error":
      return [{ type: "error", errorText: e.message }];

    case "raw": {
      // Token-level deltas (client.includeDeltas = true) arrive as raw
      // notifications: params { itemId, delta }. Map text + reasoning to
      // streaming chunks; ignore the rest (command/tool output deltas).
      const p = e.params as any;
      const id = String(p?.itemId ?? p?.id ?? "");
      const delta = String(p?.delta ?? p?.text ?? "");
      if (!id || !delta) return [];
      if (e.method === "item/agentMessage/delta") return [{ type: "text-delta", id, delta }];
      if (e.method === "item/reasoning/textDelta" || e.method === "item/reasoning/summaryTextDelta")
        return [{ type: "reasoning-delta", id, delta }];
      return [];
    }

    default:
      return []; // session/thread/turn/notice — framing handled by the route
  }
}
