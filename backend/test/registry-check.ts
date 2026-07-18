// Dev check for backend/src/registry.ts. Run from repo root:
//   npx tsx backend/test/registry-check.ts
//
// Exercises smokeTest + registerAdapter + verifyRegistered against the existing
// generic-mcp.mjs, under a throwaway name ("regtest-mcp") so your real `generic`
// registration is untouched. Cleans up after itself.

import path from "node:path";
import { AppServerClient } from "../src/codex/client";
import { smokeTest, registerAdapter, verifyRegistered, unregisterAdapter } from "../src/registry";

const log = (s: string) => process.stderr.write(s + "\n");
const NAME = "regtest-mcp";
const serverPath = path.resolve("backend/test/generic-mcp.mjs");
const artifactsDir = path.resolve("data/artifacts");

async function main() {
  // 1. smoke (no app-server / auth needed)
  log("→ smokeTest(generic-mcp.mjs)");
  const smoke = await smokeTest({ serverPath, env: { ARTIFACTS_DIR: artifactsDir } });
  log(`  ${smoke.ok ? "✔" : "✖"} ok=${smoke.ok} tools=[${smoke.tools.join(", ")}] serverInfo=${JSON.stringify(smoke.serverInfo)}${smoke.error ? ` error=${smoke.error}` : ""}`);
  if (!smoke.ok) throw new Error("smoke failed");

  // 2. register + reload + verify (needs the app-server)
  const client = new AppServerClient({});
  log("→ client.start()");
  await client.start();
  try {
    log(`→ registerAdapter("${NAME}" → generic-mcp.mjs)`);
    await registerAdapter({ name: NAME, serverPath, artifactsDir, client });
    log("→ verifyRegistered (polling)");
    const status = await verifyRegistered(client, NAME);
    log(`  ✔ live: ${status.name} — tools=[${Object.keys(status.tools ?? {}).join(", ")}]`);
  } finally {
    log(`→ cleanup: unregister ${NAME}`);
    await unregisterAdapter(NAME, client).catch((e) => log(`  (cleanup warn: ${e?.message ?? e})`));
    await client.close();
  }
  log("ALL GOOD");
}

main().catch((e) => {
  log(`FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
