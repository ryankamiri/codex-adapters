// translate: raw app-server ServerNotification -> our AgentEvent bodies.
//
// ADDITIVE + PASSTHROUGH. We never reconstruct an item field-by-field (that would
// drop fields we don't model, including future ones). We attach the whole `item`
// object and add exactly one interpretation: a human `title`. Anything we don't
// explicitly model still surfaces as a lossless `raw` event.

import type { PartialEvent, ThreadItem } from "./contract";

export interface TranslateOptions {
  includeDeltas: boolean;
}

// High-volume streaming notifications. When deltas are off we also opt out of
// these at the source (initialize capabilities), so this is a belt-and-suspenders.
export const DELTA_METHODS = [
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "item/mcpToolCall/progress",
  "turn/diff/updated",
];

const trunc = (s: string, n = 100): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export function titleForItem(item: ThreadItem): string {
  switch (item.type) {
    case "agentMessage":
      return trunc(item.text);
    case "plan":
      return trunc(item.text);
    case "reasoning":
      return trunc([...(item.summary ?? []), ...(item.content ?? [])].join(" • ")) || "(reasoning)";
    case "commandExecution": {
      const code = item.exitCode == null ? item.status : `exit ${item.exitCode}`;
      return `$ ${trunc(item.command, 80)}  (${code})`;
    }
    case "fileChange": {
      const paths = item.changes.map((c) => c.path).join(", ");
      return `${item.changes.length} file(s) [${item.status}]: ${trunc(paths, 80)}`;
    }
    case "mcpToolCall": {
      const args = trunc(JSON.stringify(item.arguments ?? {}), 60);
      const out = item.error ? "ERROR" : item.result ? "ok" : item.status;
      return `${item.server}.${item.tool}(${args}) → ${out}`;
    }
    case "webSearch":
      return "web search";
    case "imageView":
      return `image: ${(item as any).path ?? ""}`;
    case "sleep":
      return `sleep ${(item as any).durationMs}ms`;
    case "userMessage":
      return "(user message)";
    default:
      return item.type;
  }
}

export function translate(msg: any, opts: TranslateOptions): PartialEvent[] {
  const method: string = msg?.method;
  const p = msg?.params ?? {};

  switch (method) {
    case "item/started":
      return [{ kind: "item", phase: "started", itemType: p.item.type, title: titleForItem(p.item), item: p.item, threadId: p.threadId, turnId: p.turnId }];
    case "item/completed":
      return [{ kind: "item", phase: "completed", itemType: p.item.type, title: titleForItem(p.item), item: p.item, threadId: p.threadId, turnId: p.turnId }];

    case "turn/started":
      return [{ kind: "turn", phase: "started", status: p.turn?.status, threadId: p.threadId, turnId: p.turn?.id }];
    case "turn/completed":
      return [{ kind: "turn", phase: "completed", status: p.turn?.status, error: p.turn?.error ?? null, threadId: p.threadId, turnId: p.turn?.id }];

    case "thread/status/changed":
      return [{ kind: "thread", status: p.status, threadId: p.threadId }];

    case "mcpServer/startupStatus/updated":
      return [{ kind: "mcp", phase: "startup", server: p.name, status: p.status, data: p, threadId: p.threadId ?? undefined }];

    case "error":
      return [{ kind: "error", message: p.error?.message ?? "unknown error", willRetry: !!p.willRetry, detail: p, threadId: p.threadId, turnId: p.turnId }];

    default:
      if (DELTA_METHODS.includes(method)) {
        if (!opts.includeDeltas) return [];
        return [{ kind: "raw", method, params: p, threadId: p.threadId, turnId: p.turnId }];
      }
      // Lossless catch-all for every unmodeled notification.
      return [{ kind: "raw", method, params: p, threadId: p.threadId, turnId: p.turnId }];
  }
}
