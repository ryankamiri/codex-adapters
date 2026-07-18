// Terminal harness: talk to the agent over stdin/stdout.
//
//   human mode (default): readable lines on stdout — "what a user should see".
//   --json             : full-shape AgentEvent as NDJSON on stdout (nothing lost).
//   --journal <file>   : byte-level raw JSON-RPC tap for lossless replay/debug.
//   --deltas           : include token-level streaming deltas.
//   --sandbox <mode>   : read-only | workspace-write | danger-full-access (default workspace-write).
//   --approval <p>     : untrusted | on-request | never (default on-request).
//   --list             : print connected MCP servers/tools and exit.
//   [prompt...]        : run this prompt first, then drop into the REPL.
//
// Interactive prompts + status go to STDERR, so a piped stdout stays a clean event stream.

import readline from "node:readline";
import fs from "node:fs";
import { AppServerClient } from "./codex/client";
import { renderHuman } from "./codex/render";
import type { AgentEvent, TurnHandle } from "./codex/contract";

function parseArgs(argv: string[]) {
  const o = { json: false, deltas: false, list: false, journal: undefined as string | undefined, sandbox: "workspace-write", approval: "on-request", prompt: "" };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--deltas") o.deltas = true;
    else if (a === "--list") o.list = true;
    else if (a === "--journal") o.journal = argv[++i];
    else if (a === "--sandbox") o.sandbox = argv[++i];
    else if (a === "--approval") o.approval = argv[++i];
    else rest.push(a);
  }
  o.prompt = rest.join(" ");
  return o;
}

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const err = (s: string) => process.stderr.write(s + "\n");

async function main() {
  const opt = parseArgs(process.argv.slice(2));

  const journalStream = opt.journal ? fs.createWriteStream(opt.journal, { flags: "a" }) : null;
  const journal = journalStream
    ? (line: string, dir: "in" | "out") => void journalStream.write(`${dir === "in" ? "<<" : ">>"} ${line}\n`)
    : undefined;

  const client = new AppServerClient({
    includeDeltas: opt.deltas,
    defaultSandbox: opt.sandbox as any,
    defaultApprovalPolicy: opt.approval as any,
    journal,
  });

  const out = (e: AgentEvent) => {
    if (opt.json) return void process.stdout.write(JSON.stringify(e) + "\n");
    const line = renderHuman(e);
    if (line !== null) console.log(line);
  };

  // Subscribe to the global stream BEFORE start() so session/startup events render too.
  const ev = client.events;
  const rendering = (async () => {
    for await (const e of ev) out(e);
  })();

  await client.start();
  const threadId = await client.startThread();

  // Show what's connected so the user knows which tools are testable.
  const servers = await client.listMcpServers();
  err(dim(`\nconnected MCP servers (${servers.length}):`));
  for (const s of servers) {
    const tools = Object.keys(s.tools ?? {});
    err(dim(`  • ${s.name} [${s.authStatus}] — ${tools.length ? tools.join(", ") : "(no tools)"}`));
  }
  err("");

  if (opt.list) {
    await client.close();
    await rendering.catch(() => {});
    return;
  }

  let activeTurn: TurnHandle | null = null;
  const runTurn = async (prompt: string) => {
    activeTurn = client.runTurn(threadId, prompt);
    try {
      await activeTurn.done;
    } finally {
      activeTurn = null;
    }
  };

  if (opt.prompt) await runTurn(opt.prompt);

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: dim("» ") });
  rl.on("SIGINT", () => {
    if (activeTurn) {
      err(dim("  (interrupting turn…)"));
      void activeTurn.interrupt();
    } else {
      rl.close();
    }
  });

  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    if (text === "/quit" || text === "/exit") break;
    await runTurn(text);
    rl.prompt();
  }

  await client.close();
  await rendering.catch(() => {});
  journalStream?.end();
}

main().catch((e) => {
  err(`fatal: ${e?.stack ?? e}`);
  process.exit(1);
});
