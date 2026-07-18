// Human view: what a user should actually see while testing. The full-shape
// AgentEvent is always available (--json / --journal); this just projects it to
// a readable line. Returns null for events a user doesn't need to see.

import type { AgentEvent } from "./contract";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = wrap("2");
const bold = wrap("1");
const red = wrap("31");
const green = wrap("32");
const yellow = wrap("33");
const blue = wrap("34");
const magenta = wrap("35");
const cyan = wrap("36");

export function renderHuman(e: AgentEvent): string | null {
  switch (e.kind) {
    case "session":
      if (e.phase === "ready") return dim(`● codex app-server ready (${e.info?.platformOs ?? ""})`);
      if (e.phase === "closed") return dim("● app-server closed");
      return null; // "starting" is noise

    case "thread":
      return null; // thread status transitions are internal; hidden in human view

    case "turn":
      if (e.phase === "started") return bold("◆ turn started");
      return e.status === "completed"
        ? green(`✔ turn completed`)
        : red(`✖ turn ${e.status}${e.error ? `: ${e.error.message}` : ""}`);

    case "item": {
      // Only render completed items in the human view (started is redundant with completed,
      // which carries the full final content). tool calls also show while in-progress.
      if (e.phase !== "completed") return null;
      switch (e.itemType) {
        case "agentMessage":
          return `${bold("▸")} ${e.title}`;
        case "reasoning":
          return dim(`· ${e.title}`);
        case "plan":
          return magenta(`⧉ plan: ${e.title}`);
        case "commandExecution":
          return yellow(`  ${e.title}`);
        case "fileChange":
          return blue(`  ✎ ${e.title}`);
        case "mcpToolCall":
          return cyan(`  ⇄ ${e.title}`);
        default:
          return dim(`  ${e.itemType}: ${e.title}`);
      }
    }

    case "approval":
      return yellow(`  ⚠ auto-approved ${e.method.split("/").slice(-1)[0]} — ${e.describe}`);

    case "mcp":
      if (e.phase === "startup") return dim(`  ⚙ mcp ${e.server}: ${e.status}`);
      return null;

    case "error":
      return e.willRetry ? dim(`  … transient error (retrying): ${e.message}`) : red(`  ✖ ${e.message}`);

    case "notice":
      return e.level === "debug" ? null : dim(`  ${e.message}`);

    case "raw":
      return null; // hidden in human view; fully present in --json
  }
}
