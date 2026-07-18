// Protocol spot-check for the generator's two-turn design. Run from repo root:
//   npx tsx backend/test/sandbox-check.ts
//
// Question: can a turn write when its THREAD is read-only but the TURN passes
// writableRoots (a per-turn workspaceWrite sandbox override)? That's exactly what
// generator turn B does (read-only thread from turn A, writableRoots on turn B).
// If this writes the file, the two-turn design holds. If not, start the thread
// workspace-write instead.

import fs from "node:fs";
import path from "node:path";
import { AppServerClient } from "../src/codex/client";
import { renderHuman } from "../src/codex/render";

const log = (s: string) => process.stderr.write(s + "\n");
const scratch = path.resolve("data/scratch");
const target = path.join(scratch, "sbxcheck.txt");

async function main() {
  fs.mkdirSync(scratch, { recursive: true });
  fs.rmSync(target, { force: true });

  const client = new AppServerClient({});
  const ev = client.events;
  const rendering = (async () => {
    for await (const e of ev) {
      const line = renderHuman(e);
      if (line !== null) log(line);
    }
  })();

  await client.start();
  const threadId = await client.startThread({ sandbox: "read-only" }); // <- read-only THREAD
  log(`thread ${threadId} started read-only`);

  const turn = client.runTurn(
    threadId,
    `Create a file at ${target} containing exactly the text "ok". Then stop.`,
    { writableRoots: [scratch] }, // <- per-turn workspaceWrite override
  );
  const res = await turn.done;
  log(`turn ${res.status}`);

  const wrote = fs.existsSync(target);
  log(wrote ? `✔ WROTE ${target} — per-turn override WORKS` : `✖ file NOT written — thread read-only blocked the turn`);

  await client.close();
  await rendering.catch(() => {});
  process.exit(wrote ? 0 : 2);
}

main().catch((e) => {
  log(`FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
