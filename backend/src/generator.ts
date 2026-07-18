// generator.ts — Codex *authors* a new adapter from prose + local docs.
//
// Two turns on ONE persistent thread (context carries between them):
//   turn A (read-only): given the contract + template + local docs + intent, propose
//                       a toolkit as a fenced ```json {tools:[…]} block.
//   [optional review]:  write the proposal to data/generated/<name>/toolkit.json,
//                       pause for the user to edit, re-read it.
//   turn B (writable):  implement the approved toolkit under adapters/<name>-mcp/.
//
// Registration + smoke are done by the caller (registry.ts) — this module only drives
// codegen and returns where the code landed. Builds only on the CodexClient seam.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { CodexClient, ThreadItem } from "./codex/contract";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  notes?: string;
}
export interface Toolkit {
  tools: ToolDescriptor[];
}

export interface GenerateOptions {
  name: string; // app name, e.g. "applescript" (adapter becomes "<name>-mcp")
  intent: string;
  client: CodexClient;
  sourcesDir?: string; // default <repoRoot>/data/sources/<name>
  review?: boolean; // pause after the proposal so the user can edit the toolkit
  repoRoot?: string; // default process.cwd()
}

export interface GenerateResult {
  toolkit: Toolkit;
  appName: string; // "applescript"
  adapterName: string; // "applescript-mcp"
  adapterDir: string; // abs adapters/<name>-mcp
  serverPath: string; // abs adapters/<name>-mcp/server.mjs
  toolkitPath: string; // abs data/generated/<name>/toolkit.json
}

const log = (s: string) => process.stderr.write(s + "\n");
const MAX_PER_FILE = 12_000;

// Pull the toolkit out of turn A's message. Tries fenced ```json blocks last-first,
// then the whole text — robust to extra prose around the block.
export function extractToolkit(text: string): Toolkit {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = (fences.length ? fences : [text]).reverse();
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.trim());
      if (obj && Array.isArray(obj.tools) && obj.tools.length > 0) return obj as Toolkit;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`turn A produced no valid \`\`\`json {tools:[…]} block. Raw output:\n${text.slice(0, 2000)}`);
}

function readSources(dir: string): string {
  if (!fs.existsSync(dir)) return "(no local docs provided)";
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith("."))
    .map((d) => d.name);
  if (files.length === 0) return "(no local docs provided)";
  return files
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const body = raw.length > MAX_PER_FILE ? raw.slice(0, MAX_PER_FILE) + "\n…(truncated)…" : raw;
      return `### ${f}\n\`\`\`\n${body}\n\`\`\``;
    })
    .join("\n\n");
}

function waitForEnter(msg: string): Promise<void> {
  process.stderr.write(msg);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.once("line", () => {
      rl.close();
      resolve();
    });
  });
}

// Capture turn A's final agentMessage(s) full text (NOT the truncated title).
async function collectProposal(turn: { events: AsyncIterable<any>; done: Promise<{ status: string }> }): Promise<string> {
  const messages: string[] = [];
  for await (const e of turn.events) {
    if (e.kind === "item" && e.phase === "completed" && e.itemType === "agentMessage") {
      messages.push((e.item as Extract<ThreadItem, { type: "agentMessage" }>).text);
    }
  }
  const res = await turn.done;
  if (res.status !== "completed") throw new Error(`proposal turn ${res.status}`);
  if (messages.length === 0) throw new Error("proposal turn produced no agent message");
  return messages.join("\n\n");
}

export async function generateAdapter(opts: GenerateOptions): Promise<GenerateResult> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const appName = opts.name.replace(/-mcp$/, ""); // tolerate "applescript" or "applescript-mcp"
  const adapterName = `${appName}-mcp`;
  const adaptersRoot = path.join(repoRoot, "adapters");
  const adapterDir = path.join(adaptersRoot, adapterName);
  const serverPath = path.join(adapterDir, "server.mjs");
  const sourcesDir = opts.sourcesDir ?? path.join(repoRoot, "data", "sources", appName);
  const generatedDir = path.join(repoRoot, "data", "generated", appName);
  const toolkitPath = path.join(generatedDir, "toolkit.json");

  const contract = fs.readFileSync(path.join(repoRoot, "adapter-contract", "CONTRACT.md"), "utf8");
  const template = fs.readFileSync(path.join(repoRoot, "adapter-contract", "template", "server.mjs"), "utf8");
  const sources = readSources(sourcesDir);

  const threadId = await opts.client.startThread({ sandbox: "read-only", cwd: repoRoot });
  log(`\n● generator thread ${threadId} (${adapterName})`);

  // ── turn A: propose ──
  const promptA = [
    `You are generating a **Relay adapter** — a stdio MCP server that lets an agent drive a live application (${appName}).`,
    ``,
    `## The contract you MUST follow`,
    contract,
    ``,
    `## Skeleton to imitate (adapter-contract/template/server.mjs)`,
    "```js\n" + template + "\n```",
    ``,
    `## Local documentation for the target app`,
    sources,
    ``,
    `## Intent`,
    opts.intent,
    ``,
    `## Your task (THIS TURN IS READ-ONLY — do not create or edit any files)`,
    `Design the toolkit for \`${adapterName}\`. Propose the SMALLEST set of tools that satisfies the intent and the contract's required triad (≥1 \`observe_*\`, ≥1 action tool, ≥1 \`capture_*\`).`,
    `Think briefly, then end your message with EXACTLY ONE fenced json block and NOTHING after it:`,
    "```json",
    `{"tools":[{"name":"observe_...","description":"what it does and WHEN to use it","inputSchema":{"type":"object","properties":{}},"notes":"how to implement it against ${appName}"}]}`,
    "```",
    `Every tool needs: name, a description that tells the agent when to use it, a JSON-Schema inputSchema, and notes on implementation.`,
  ].join("\n");

  const turnA = opts.client.runTurn(threadId, promptA);
  const proposalText = await collectProposal(turnA);
  const toolkit = extractToolkit(proposalText);

  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(toolkitPath, JSON.stringify(toolkit, null, 2));
  log(`\n◆ proposed toolkit (${toolkit.tools.length} tools) → ${path.relative(repoRoot, toolkitPath)}`);
  for (const t of toolkit.tools) log(`   • ${t.name} — ${t.description}`);

  // ── optional review ──
  let finalToolkit = toolkit;
  if (opts.review) {
    await waitForEnter(`\n✎ edit ${path.relative(repoRoot, toolkitPath)} if you like, then press Enter to generate… `);
    finalToolkit = JSON.parse(fs.readFileSync(toolkitPath, "utf8"));
    log(`  using ${finalToolkit.tools.length} tools`);
  }

  // ── turn B: implement ──
  fs.mkdirSync(adapterDir, { recursive: true });
  const promptB = [
    `Implement the approved toolkit for \`${adapterName}\` now. Write real, working code — no TODO stubs.`,
    ``,
    `Create these files under \`adapters/${adapterName}/\`:`,
    `- \`server.mjs\` — a stdio MCP server following the contract and the template style (hand-rolled newline-delimited JSON-RPC; handle initialize, tools/list, tools/call, and a fallback that answers any other id'd request). Report \`serverInfo.name = "${adapterName}"\`. Read \`ARTIFACTS_DIR\`. Return failures as \`{isError:true}\` results — never throw.`,
    `- \`package.json\` — name "${adapterName}", "type":"module"; add dependencies ONLY if a tool genuinely needs a library.`,
    `- \`README.md\` — capabilities, how to run the target app, and env vars.`,
    ``,
    `The tools must ACTUALLY drive ${appName} (e.g. shell out via node:child_process for CLI-driven apps). Implement EXACTLY these tools:`,
    "```json",
    JSON.stringify(finalToolkit, null, 2),
    "```",
  ].join("\n");

  const turnB = opts.client.runTurn(threadId, promptB, { writableRoots: [adaptersRoot] });
  const resB = await turnB.done;
  if (resB.status !== "completed") throw new Error(`implementation turn ${resB.status}`);
  if (!fs.existsSync(serverPath)) throw new Error(`turn B finished but ${path.relative(repoRoot, serverPath)} was not created`);

  return { toolkit: finalToolkit, appName, adapterName, adapterDir, serverPath, toolkitPath };
}
