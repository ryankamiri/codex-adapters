// generator-cli.ts — author a new adapter from the terminal.
//
//   npx tsx backend/src/generator-cli.ts new <name> --intent "…" [--sources <dir>] [--review] [--json]
//
// Flow: propose (turn A) → [review] → generate (turn B) → smoke → register → verify.
// Agent events stream to stdout (human lines, or NDJSON with --json); generator
// milestones + status go to stderr, so a piped stdout stays a clean event stream.

import path from "node:path";
import { AppServerClient } from "./codex/client";
import { renderHuman } from "./codex/render";
import { generateAdapter } from "./generator";
import { smokeTest, registerAdapter, verifyRegistered } from "./registry";
import type { AgentEvent } from "./codex/contract";

function parseArgs(argv: string[]) {
  const o = { json: false, review: false, intent: "", sources: undefined as string | undefined, name: "" };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--review") o.review = true;
    else if (a === "--intent") o.intent = argv[++i] ?? "";
    else if (a === "--sources") o.sources = argv[++i];
    else rest.push(a);
  }
  if (rest[0] === "new") rest.shift(); // optional subcommand
  o.name = rest[0] ?? "";
  return o;
}

const err = (s: string) => process.stderr.write(s + "\n");

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (!opt.name || !opt.intent) {
    err(`usage: generator-cli.ts new <name> --intent "…" [--sources <dir>] [--review] [--json]`);
    process.exit(1);
  }

  const repoRoot = process.cwd();
  const artifactsDir = path.join(repoRoot, "data", "artifacts");

  const client = new AppServerClient({});
  const out = (e: AgentEvent) => {
    if (opt.json) return void process.stdout.write(JSON.stringify(e) + "\n");
    const line = renderHuman(e);
    if (line !== null) console.log(line);
  };
  const ev = client.events;
  const rendering = (async () => {
    for await (const e of ev) out(e);
  })();

  await client.start();

  try {
    // propose → [review] → generate
    const gen = await generateAdapter({
      name: opt.name,
      intent: opt.intent,
      sourcesDir: opt.sources ? path.resolve(opt.sources) : undefined,
      review: opt.review,
      client,
      repoRoot,
    });

    // smoke BEFORE registering — never register a broken adapter
    err(`\n→ smoke test ${path.relative(repoRoot, gen.serverPath)}`);
    const smoke = await smokeTest({ serverPath: gen.serverPath, env: { ARTIFACTS_DIR: artifactsDir } });
    if (!smoke.ok) throw new Error(`smoke failed: ${smoke.error} (tools=[${smoke.tools.join(", ")}])`);
    err(`  ✔ ${smoke.tools.length} tools: ${smoke.tools.join(", ")}`);

    // register + hot-reload + verify Codex sees it
    err(`→ register "${gen.adapterName}" and hot-reload`);
    await registerAdapter({ name: gen.adapterName, serverPath: gen.serverPath, artifactsDir, client });
    const status = await verifyRegistered(client, gen.adapterName);

    err(`\n✔ ${gen.adapterName} live — ${Object.keys(status.tools ?? {}).length} tools`);
    err(`  code:    ${path.relative(repoRoot, gen.adapterDir)}/`);
    err(`  toolkit: ${path.relative(repoRoot, gen.toolkitPath)}`);
    err(`  try it:  npx tsx backend/src/cli.ts "Use ${gen.adapterName} to …"`);
  } finally {
    await client.close();
    await rendering.catch(() => {});
  }
}

main().catch((e) => {
  err(`\nFAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
