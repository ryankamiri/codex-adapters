// Standalone smoke test — proves the stack works WITHOUT Codex:
//   bot connects → build a box (via /fill, needs opped bot) → screencapture → schematic capture.
//
// Prereqs: a local offline Minecraft 1.21.1 server running with the bot opped,
// and the game visible on your screen (the snapshot grabs your macOS main
// display). Run from the repo root so artifacts land in ./data/artifacts:
//   node adapters/minecraft-mcp/test/smoke.mjs

import { config } from "../src/config.js";
import { createMinecraftBot } from "../src/bot.js";
import { takeSnapshot } from "../src/snapshot.js";
import { captureStructure } from "../src/structure.js";

const log = (...a) => console.log("[smoke]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log(`connecting to ${config.host}:${config.port} as ${config.username} (mc ${config.version})…`);
const { ready } = createMinecraftBot(config);
let bot;
try {
  bot = await ready;
} catch (e) {
  console.error(`\n[smoke] ✖ could not connect to Minecraft at ${config.host}:${config.port} — ${e?.message ?? e}\n`);
  console.error(`[smoke] checklist:`);
  console.error(`[smoke]   • Is a Minecraft server actually running and listening?`);
  console.error(`[smoke]   • "Open to LAN" from the game uses a RANDOM port (shown in chat: "Local game hosted on port NNNNN"),`);
  console.error(`[smoke]     NOT 25565. Point the test at it:   MC_PORT=NNNNN node adapters/minecraft-mcp/test/smoke.mjs`);
  console.error(`[smoke]   • Dedicated server: set online-mode=false in server.properties, then restart.`);
  console.error(`[smoke]   • Override target with env vars: MC_HOST / MC_PORT / MC_VERSION.`);
  process.exit(1);
}
log("spawned at", bot.entity.position);

// Build a 5x5x4 oak shell a few blocks away (bot must be opped).
const p = bot.entity.position;
const ox = Math.round(p.x) + 3;
const oy = Math.round(p.y);
const oz = Math.round(p.z) + 3;
const cx = ox + 4;
const cy = oy + 3;
const cz = oz + 4;
log(`building 5x5x4 oak_planks shell at ${ox},${oy},${oz}  (needs opped bot)…`);
bot.chat(`/fill ${ox} ${oy} ${oz} ${cx} ${cy} ${cz} oak_planks hollow`);
await sleep(2500); // let block changes stream to your client

log("taking screenshot (macOS screencapture of your main display)…");
const snap = await takeSnapshot(config.artifactsDir, "smoke");
log("📸 snapshot →", snap.path);

log("capturing structure JSON…");
const struct = await captureStructure(bot, { x: ox, y: oy, z: oz }, { x: cx, y: cy, z: cz }, config.artifactsDir, "smoke");
log("🧱 structure →", struct.path);

log("done. cleaning up…");
bot.quit();
process.exit(0);
