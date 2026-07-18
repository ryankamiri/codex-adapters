// House builder — a dedicated "make me a proper house" capability. The generic
// build_structure only stacks a wall+floor shell (no roof, no real door); this
// builds a COMPLETE, enclosed house: floor, walls, a real gabled/flat roof, an
// actual openable door, glass windows, and interior torches.
//
// It constructs via the bot's own /fill + /setblock commands (needs op — the
// creative build flow already requires op), so the result is reliable and never
// left with gaps or an open roof. Built layer-by-layer with small pauses so it
// visibly rises. Auto-levels into uneven ground by clearing the volume first.

import vec3Pkg from "vec3";
import pathfinderPkg from "mineflayer-pathfinder";
import { gotoSafely } from "./actions.js";

const Vec3 = vec3Pkg.Vec3;
const { goals } = pathfinderPkg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));

// Send a server command as the bot, with a small pause (watchable + avoids the
// server throttling a burst of chat commands).
async function cmd(bot, command) {
  bot.chat(command);
  await sleep(250);
}

/**
 * Gabled roof with ridge running along X, slopes falling toward z0/z1, plus
 * triangular gable-end infill so it's fully closed. Watertight: every z column
 * gets exactly one roof block at the right height. 1-block eaves overhang on X.
 */
async function peakedRoof(bot, x0, x1, z0, z1, baseY, roofMat, wallMat) {
  let zi = z0;
  let zj = z1;
  let y = baseY;
  while (zi <= zj) {
    // sloped roof planes (the two descending edges), with x-overhang
    await cmd(bot, `/fill ${x0 - 1} ${y} ${zi} ${x1 + 1} ${y} ${zi} ${roofMat}`);
    if (zi !== zj) await cmd(bot, `/fill ${x0 - 1} ${y} ${zj} ${x1 + 1} ${y} ${zj} ${roofMat}`);
    // triangular gable ends at x0 and x1 (wall material), filling the gap below the slope
    if (zj - zi >= 2) {
      await cmd(bot, `/fill ${x0} ${y} ${zi + 1} ${x0} ${y} ${zj - 1} ${wallMat}`);
      await cmd(bot, `/fill ${x1} ${y} ${zi + 1} ${x1} ${y} ${zj - 1} ${wallMat}`);
    }
    zi++;
    zj--;
    y++;
  }
}

/** Build a complete house at `origin` (its min-corner, floor level). */
export async function buildHouse(bot, origin, opts = {}) {
  const width = clamp(opts.width ?? 7, 5, 24); // along X
  const depth = clamp(opts.depth ?? 7, 5, 24); // along Z
  const wallHeight = clamp(opts.wallHeight ?? 4, 3, 10);
  const wall = opts.wall ?? "oak_planks";
  const roofMat = opts.roof ?? "spruce_planks";
  const floorMat = opts.floor ?? "oak_planks";
  const roofStyle = opts.roofStyle === "flat" ? "flat" : "peaked";
  const withWindows = opts.windows !== false;
  const withDoor = opts.door !== false;
  const withLight = opts.light !== false;

  const x0 = Math.round(origin.x);
  const y0 = Math.round(origin.y);
  const z0 = Math.round(origin.z);
  const x1 = x0 + width - 1;
  const z1 = z0 + depth - 1;
  const yTop = y0 + wallHeight; // top wall layer
  const roofBaseY = yTop + 1;
  const dx = x0 + Math.floor(width / 2); // door column (front wall, z0)

  // Stand near the site (chunks loaded + watchable). Non-fatal if pathing fails.
  await gotoSafely(bot, new goals.GoalNear(x0, y0, z0, 4), 30_000).catch(() => {});

  bot.chat("Building a house here!");
  await sleep(300);

  // 1. clear the build volume (auto-levels into hills; keeps ground below floor)
  await cmd(bot, `/fill ${x0} ${y0} ${z0} ${x1} ${roofBaseY + Math.ceil(depth / 2)} ${z1} air`);

  // 2. floor
  await cmd(bot, `/fill ${x0} ${y0} ${z0} ${x1} ${y0} ${z1} ${floorMat}`);

  // 3. walls, one layer at a time so it visibly rises
  for (let y = y0 + 1; y <= yTop; y++) {
    await cmd(bot, `/fill ${x0} ${y} ${z0} ${x1} ${y} ${z0} ${wall}`); // north (z0)
    await cmd(bot, `/fill ${x0} ${y} ${z1} ${x1} ${y} ${z1} ${wall}`); // south (z1)
    await cmd(bot, `/fill ${x0} ${y} ${z0} ${x0} ${y} ${z1} ${wall}`); // west (x0)
    await cmd(bot, `/fill ${x1} ${y} ${z0} ${x1} ${y} ${z1} ${wall}`); // east (x1)
  }

  // 4. roof
  if (roofStyle === "flat") {
    await cmd(bot, `/fill ${x0 - 1} ${roofBaseY} ${z0 - 1} ${x1 + 1} ${roofBaseY} ${z1 + 1} ${roofMat}`);
  } else {
    await peakedRoof(bot, x0, x1, z0, z1, roofBaseY, roofMat, wall);
  }

  // 5. a real door in the front wall (z0), centered
  let doorNote = "1x2 doorway";
  if (withDoor) {
    await cmd(bot, `/setblock ${dx} ${y0 + 1} ${z0} oak_door[facing=north,half=lower,hinge=left]`);
    await cmd(bot, `/setblock ${dx} ${y0 + 2} ${z0} oak_door[facing=north,half=upper,hinge=left]`);
    doorNote = "oak_door";
  }

  // 6. glass windows at eye level, centered on the walls (off-corner only)
  let windows = 0;
  if (withWindows) {
    const wy = y0 + 2;
    const mz = z0 + Math.floor(depth / 2);
    const cands = [
      [x0 + Math.floor(width / 2), wy, z1], // back wall center
      [x0, wy, mz], // west wall center
      [x1, wy, mz], // east wall center
    ];
    if (width >= 7) {
      cands.push([dx - 2, wy, z0]); // front, left of door
      cands.push([dx + 2, wy, z0]); // front, right of door
    }
    for (const [wx, wyy, wz] of cands) {
      if (wx < x0 || wx > x1 || wz < z0 || wz > z1) continue;
      await cmd(bot, `/setblock ${wx} ${wyy} ${wz} glass_pane`);
      windows++;
    }
  }

  // 7. interior torches so it isn't a dark mob-spawner
  let lights = 0;
  if (withLight && width >= 4 && depth >= 4) {
    const spots = [
      [x0 + 1, z0 + 1],
      [x1 - 1, z1 - 1],
      [x0 + 1, z1 - 1],
      [x1 - 1, z0 + 1],
    ];
    for (const [tx, tz] of spots) {
      await cmd(bot, `/setblock ${tx} ${y0 + 1} ${tz} torch`);
      lights++;
    }
  }

  // 8. finish: stand at the doorway
  await gotoSafely(bot, new goals.GoalNear(dx, y0, z0 - 1, 1), 20_000).catch(() => {});
  bot.chat("House complete!");

  // 9. verify the commands actually took effect (catches a non-opped bot)
  await sleep(600);
  const roofCheck = bot.blockAt(new Vec3(x0, roofBaseY, z0));
  if (!roofCheck || roofCheck.name === "air") {
    throw new Error(`the house didn't build — the bot must be opped to place blocks with commands (server console: op ${bot.username})`);
  }

  bot.recordEvent?.(`built a ${width}x${depth} house at ${x0},${y0},${z0}`);
  return `built a ${width}x${depth} house with ${wallHeight}-high walls, a ${roofStyle} ${roofMat} roof, ${doorNote}, ${windows} glass windows, and ${lights} torches — at ${x0},${y0},${z0}. Front door faces north (−z).`;
}
