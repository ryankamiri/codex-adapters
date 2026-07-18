// Physical actions — the bot actually PLAYS: walks to a spot, looks at a block
// face, and mines/places by hand (mineflayer physics), instead of teleporting
// blocks in with /setblock. Slower and flakier than commands (that's the point —
// it's real, watchable gameplay), so callers wrap each block in try/catch.

import vec3Pkg from "vec3";
import pathfinderPkg from "mineflayer-pathfinder";
import PrismarineItemLoader from "prismarine-item";

const Vec3 = vec3Pkg.Vec3;
const { goals } = pathfinderPkg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Switch game mode via /gamemode (needs op). Waits for the server to confirm. */
export async function setGameMode(bot, mode) {
  const valid = ["survival", "creative", "adventure", "spectator"];
  if (!valid.includes(mode)) throw new Error(`invalid mode "${mode}" — use one of: ${valid.join(", ")}`);
  if (bot.game.gameMode === mode) return `already in ${mode} mode`;
  bot.chat(`/gamemode ${mode} @s`);
  const deadline = Date.now() + 3000;
  while (bot.game.gameMode !== mode && Date.now() < deadline) await sleep(150);
  if (bot.game.gameMode !== mode) {
    throw new Error(`couldn't switch to ${mode} — the bot must be opped (server console: op ${bot.username}). Still in ${bot.game.gameMode}.`);
  }
  bot.recordEvent?.(`game mode → ${mode}`);
  return `game mode is now ${mode}`;
}

/** In creative, materialize a full stack of `name` into an empty hotbar slot. */
async function giveCreative(bot, name, count = 64) {
  const def = bot.registry.itemsByName[name];
  if (!def) throw new Error(`unknown item: ${name}`);
  const Item = PrismarineItemLoader(bot.version);
  let slot = 36;
  for (let s = 36; s <= 44; s++) {
    if (!bot.inventory.slots[s]) {
      slot = s;
      break;
    }
  }
  await bot.creative.setInventorySlot(slot, new Item(def.id, count));
  return bot.inventory.slots[slot];
}

/** Race a promise against a deadline without ever leaking an unhandled rejection. */
async function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(label)), ms);
  });
  promise.catch(() => {}); // if we lose the race, its late rejection is already handled
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * pathfinder.goto with a stuck-watchdog: aborts when there's no movement (and no
 * digging/bridging) for 20s or the overall deadline passes, clears the goal, and
 * throws an actionable error instead of hanging the turn forever.
 */
export async function gotoSafely(bot, goal, timeoutMs = 90_000, hint = "") {
  let done = false;
  let lastPos = bot.entity.position.clone();
  let stillSince = Date.now();
  const start = Date.now();

  const watchdog = (async () => {
    while (!done) {
      await sleep(2000);
      if (done) return;
      const p = bot.entity.position;
      if (p.distanceTo(lastPos) > 0.5 || bot.pathfinder.isMining?.() || bot.pathfinder.isBuilding?.()) {
        lastPos = p.clone();
        stillSince = Date.now();
      }
      if (Date.now() - start > timeoutMs) throw new Error(`navigation timed out after ${Math.round(timeoutMs / 1000)}s`);
      if (Date.now() - stillSince > 20_000) throw new Error("stuck — no movement progress for 20s");
    }
  })();

  const nav = bot.pathfinder.goto(goal);
  nav.catch(() => {}); // the watchdog may cancel it; never let it reject unhandled
  try {
    await Promise.race([nav, watchdog]);
  } catch (e) {
    bot.pathfinder.setGoal(null);
    bot.recordEvent?.(`navigation failed: ${e?.message ?? e}`);
    throw new Error(`${e?.message ?? e}${hint ? ` — ${hint}` : " — if underground, use go_to_surface; otherwise mine_block a way out or move_away"}`);
  } finally {
    done = true;
  }
}

/** Climb/dig back up to open sky above the bot's current column. */
export async function goToSurface(bot) {
  const p = bot.entity.position.floored();
  const topY = (bot.game?.minY ?? -64) + (bot.game?.height ?? 384) - 1;

  // First solid block above the bot's head in this column = the ceiling; none = open sky.
  let surfaceY = null;
  for (let y = topY; y > p.y + 1; y--) {
    const b = bot.blockAt(new Vec3(p.x, y, p.z));
    if (b && b.name !== "air") {
      surfaceY = y + 1;
      break;
    }
  }
  if (surfaceY === null) return "already at the surface (open sky above)";

  // Pathfinder digs/pillars its way up (it needs blocks: dirt/cobble/planks…).
  await gotoSafely(
    bot,
    new goals.GoalNear(p.x, surfaceY, p.z, 3),
    120_000,
    "if this keeps failing, mine_block a staircase upward one block at a time (never straight up)",
  );
  const q = bot.entity.position;
  return `back in the open: now at ${Math.round(q.x)}, ${Math.round(q.y)}, ${Math.round(q.z)}`;
}

/**
 * Equip `blockName` to hand. In SURVIVAL it must be in the real inventory (no
 * cheating). In CREATIVE the block is free — materialized on demand — so build
 * tasks just work without gathering.
 */
export async function ensureEquipped(bot, blockName) {
  let item = bot.inventory.items().find((i) => i.name === blockName);
  if (!item && bot.game.gameMode === "creative") item = await giveCreative(bot, blockName);
  if (!item) throw new Error(`no ${blockName} in inventory — collect_block/craft_item first, or set_game_mode creative to build with free blocks`);
  await bot.equip(item, "hand");
  return item;
}

/** Equip any inventory item to a slot: hand, head, torso, legs, feet, off-hand. */
export async function equipItem(bot, name, destination = "hand") {
  const item = bot.inventory.items().find((i) => i.name === name);
  if (!item) throw new Error(`no ${name} in inventory`);
  await bot.equip(item, destination);
  return `equipped ${name} to ${destination}`;
}

/** Eat: a specific food by name, or the first edible thing in inventory. */
export async function eatFood(bot, name) {
  const foods = bot.registry.foodsByName ?? {};
  let item;
  if (name) {
    item = bot.inventory.items().find((i) => i.name === name);
    if (!item) throw new Error(`no ${name} in inventory`);
  } else {
    item = bot.inventory.items().find((i) => foods[i.name]);
    if (!item) throw new Error("no food in inventory — hunt animals (attack_entity cow/pig/chicken) or gather crops first");
  }
  await bot.equip(item, "hand");
  await bot.consume(); // throws 'Food is full' when food is already 20/20
  return `ate ${item.name} (food now ${bot.food}/20)`;
}

/** Gather like a player: find nearest matching blocks, pathfind, mine, pick up drops. */
export async function collectBlocks(bot, blockName, count) {
  const id = bot.registry.blocksByName[blockName]?.id;
  if (id === undefined) throw new Error(`unknown block type: ${blockName}`);
  let collected = 0;
  let lastErr = null;
  for (let i = 0; i < count; i++) {
    const target = bot.findBlock({ matching: id, maxDistance: 64 });
    if (!target) break; // none left in range
    try {
      // pathfind + best tool + dig + pick up — with a deadline so a stuck path
      // can't hang the whole turn
      await withTimeout(bot.collectBlock.collect(target), 60_000, `collecting ${blockName} timed out after 60s (stuck?)`);
      collected++;
    } catch (e) {
      lastErr = e; // keep partial progress instead of throwing it away
      await bot.collectBlock.cancelTask().catch(() => {});
      bot.pathfinder.setGoal(null);
      break;
    }
  }
  if (collected === 0 && lastErr) throw lastErr;
  return collected;
}

/** Fight an entity by name (mob or player): pursue + cooldown-aware melee, then loot drops. */
export async function attackEntity(bot, name, timeoutMs = 60_000) {
  const lower = name.toLowerCase();
  const target = bot.nearestEntity(
    (e) => e !== bot.entity && e.position && (e.name === lower || e.username === name || String(e.displayName).toLowerCase() === lower),
  );
  if (!target) throw new Error(`no ${name} nearby — scan_surroundings to see what's around`);
  const startDist = Math.round(target.position.distanceTo(bot.entity.position));

  const outcome = await new Promise((resolve) => {
    let settled = false;
    const finish = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bot.off("stoppedAttacking", onStop);
      resolve(msg);
    };
    const onStop = () => finish(target.isValid === false ? `killed the ${name}` : `stopped attacking the ${name} (it left or died)`);
    const timer = setTimeout(() => {
      bot.pvp.forceStop();
      finish(`gave up on the ${name} after ${timeoutMs / 1000}s`);
    }, timeoutMs);
    bot.on("stoppedAttacking", onStop);
    bot.pvp.attack(target);
  });

  await collectNearbyDrops(bot).catch(() => {}); // loot what it dropped
  return `${outcome} (was ${startDist} blocks away)`;
}

/** Walk over nearby dropped items to pick them up (used after kills). */
export async function collectNearbyDrops(bot, radius = 8) {
  await sleep(800); // let drops spawn/settle
  const drops = Object.values(bot.entities).filter(
    (e) => e?.position && e.name === "item" && e.position.distanceTo(bot.entity.position) <= radius,
  );
  for (const d of drops.slice(0, 6)) {
    try {
      await withTimeout(bot.collectBlock.collect(d), 20_000, "drop pickup timed out");
    } catch {
      await bot.collectBlock.cancelTask().catch(() => {});
    }
  }
  return drops.length;
}

/** Run away from where the bot is standing (creepers, mobs, danger). */
export async function moveAway(bot, distance = 8) {
  const p = bot.entity.position;
  await gotoSafely(bot, new goals.GoalInvert(new goals.GoalNear(p.x, p.y, p.z, distance)), 45_000);
  const q = bot.entity.position;
  return `moved away to ${Math.round(q.x)}, ${Math.round(q.y)}, ${Math.round(q.z)}`;
}

/** Find a bed, walk to it, and sleep. mineflayer's own errors explain refusals. */
export async function sleepInBed(bot, maxDistance = 24) {
  const bedIds = Object.values(bot.registry.blocksByName)
    .filter((b) => b.name.endsWith("_bed"))
    .map((b) => b.id);
  const bed = bot.findBlock({ matching: bedIds, maxDistance });
  if (!bed) throw new Error(`no bed within ${maxDistance} blocks — craft one (3 wool + 3 planks) and place it first`);
  await gotoSafely(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
  // throws precise reasons: "it's not night", "there are monsters nearby", "the bed is occupied"…
  await bot.sleep(bed);
  return "in bed and sleeping — will wake at dawn automatically";
}

/** Smelt items in a nearby furnace: walk over, load fuel + input, wait, take output. */
export async function smeltItem(bot, itemName, count = 1, fuelName = "coal") {
  const reg = bot.registry;
  const input = reg.itemsByName[itemName];
  if (!input) throw new Error(`unknown item: ${itemName}`);
  const fuel = reg.itemsByName[fuelName];
  if (!fuel) throw new Error(`unknown fuel item: ${fuelName}`);

  const furnaceId = reg.blocksByName.furnace?.id;
  const furnaceBlock = bot.findBlock({ matching: furnaceId, maxDistance: 24 });
  if (!furnaceBlock) {
    if (bot.inventory.items().some((i) => i.name === "furnace"))
      throw new Error("no furnace nearby but you have one — place_block it first, then smelt again");
    throw new Error("no furnace within 24 blocks — craft one from 8 cobblestone at a crafting table, place it, then smelt");
  }

  await gotoSafely(bot, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2));
  const furnace = await bot.openFurnace(furnaceBlock);
  try {
    // coal/charcoal smelt 8 items each; other fuels (planks…) roughly 1 each
    const perFuel = fuelName === "coal" || fuelName === "charcoal" ? 8 : 1;
    await furnace.putFuel(fuel.id, null, Math.ceil(count / perFuel)); // throws if we lack the fuel
    await furnace.putInput(input.id, null, count); // throws if we lack the items

    const deadline = Date.now() + count * 11_000 + 15_000; // ~10s per item + slack
    let collected = 0;
    while (collected < count && Date.now() < deadline) {
      await sleep(1000);
      const out = furnace.outputItem();
      if (out && out.count >= count - collected) {
        const taken = await furnace.takeOutput();
        collected += taken?.count ?? 0;
      }
    }
    if (collected < count && furnace.outputItem()) {
      const taken = await furnace.takeOutput(); // grab whatever finished
      collected += taken?.count ?? 0;
    }
    return `smelted ${collected}x from ${itemName}${collected < count ? ` (wanted ${count} — out of time or fuel)` : ""}`;
  } finally {
    furnace.close();
  }
}

function summarizeIngredients(recipe, reg) {
  const parts = [];
  for (const d of recipe.delta ?? []) {
    if (d.count < 0) parts.push(`${-d.count}x ${reg.items[d.id]?.name ?? d.id}`);
  }
  return parts.join(", ") || "unknown ingredients";
}

/** Place our crafting table on clear ground near the bot, return the placed block. */
async function placeCraftingTable(bot) {
  const base = bot.entity.position.floored();
  const offsets = [ [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2], [1, 0, 1], [-1, 0, -1] ];
  for (const [dx, dy, dz] of offsets) {
    const t = new Vec3(base.x + dx, base.y + dy, base.z + dz);
    const at = bot.blockAt(t);
    const below = bot.blockAt(t.offset(0, -1, 0));
    if (!at || at.boundingBox === "block" || !below || below.boundingBox !== "block") continue;
    try {
      await physicalPlace(bot, { x: t.x, y: t.y, z: t.z }, "crafting_table");
      return bot.blockAt(t);
    } catch {
      continue;
    }
  }
  throw new Error("couldn't find a clear spot to place the crafting table — move somewhere open and try again");
}

/**
 * Craft from inventory materials. Uses a nearby crafting table when the recipe
 * needs one — and if none is nearby but we're carrying one, places it first.
 * Errors name the exact missing ingredients.
 */
export async function craftItem(bot, itemName, count) {
  const reg = bot.registry;
  const item = reg.itemsByName[itemName];
  if (!item) throw new Error(`unknown item: ${itemName}`);
  const tableId = reg.blocksByName["crafting_table"]?.id;
  let table = tableId !== undefined ? bot.findBlock({ matching: tableId, maxDistance: 6 }) : null;
  let recipes = bot.recipesFor(item.id, null, 1, table);

  if (!recipes.length && !table) {
    // Would a crafting table unlock it? (`true` = assume table present)
    const tableRecipes = bot.recipesFor(item.id, null, 1, true);
    if (tableRecipes.length) {
      if (bot.inventory.items().some((i) => i.name === "crafting_table")) {
        table = await placeCraftingTable(bot); // we carry one — put it down
        recipes = bot.recipesFor(item.id, null, 1, table);
      } else {
        throw new Error(`crafting ${itemName} needs a crafting table — none within 6 blocks and none in inventory. craft_item crafting_table (4 planks) first`);
      }
    }
  }

  if (!recipes.length) {
    const all = bot.recipesAll(item.id, null, table ?? true);
    if (!all.length) throw new Error(`no recipe exists for ${itemName}`);
    throw new Error(`missing ingredients for ${itemName} — need ${summarizeIngredients(all[0], reg)}. collect_block or craft what's missing first`);
  }
  await bot.craft(recipes[0], count, table ?? undefined);
  return `crafted ${count}x ${itemName}`;
}

/** What can be crafted RIGHT NOW from inventory (and a nearby table, if any). */
export function listCraftable(bot) {
  const reg = bot.registry;
  const tableId = reg.blocksByName["crafting_table"]?.id;
  const table = tableId !== undefined ? bot.findBlock({ matching: tableId, maxDistance: 6 }) : null;
  const craftable = [];
  for (const idStr of Object.keys(reg.recipes ?? {})) {
    const id = Number(idStr);
    try {
      if (bot.recipesFor(id, null, 1, table).length) craftable.push(reg.items[id]?.name ?? String(id));
    } catch {}
    if (craftable.length >= 40) break;
  }
  return { craftingTableNearby: !!table, craftable };
}

// The 6 neighbours of a target cell; we place against whichever is already solid.
const NEIGHBORS = [
  new Vec3(0, -1, 0),
  new Vec3(0, 1, 0),
  new Vec3(-1, 0, 0),
  new Vec3(1, 0, 0),
  new Vec3(0, 0, -1),
  new Vec3(0, 0, 1),
];

/** Find an adjacent solid block to place against, with the face vector toward target. */
function findReference(bot, target) {
  for (const d of NEIGHBORS) {
    const ref = bot.blockAt(target.plus(d));
    if (ref && ref.boundingBox === "block") return { ref, face: d.scaled(-1) };
  }
  return null;
}

/** Walk to within reach of `target` and physically place `blockName` there. */
export async function physicalPlace(bot, target, blockName) {
  const t = new Vec3(target.x, target.y, target.z);
  const existing = bot.blockAt(t);
  if (existing && existing.boundingBox === "block") return "already occupied";

  await gotoSafely(bot, new goals.GoalNear(t.x, t.y, t.z, 3), 60_000);
  await ensureEquipped(bot, blockName);

  const found = findReference(bot, t);
  if (!found) throw new Error(`no solid block to place against at ${t.x},${t.y},${t.z}`);

  await bot.lookAt(t.offset(0.5, 0.5, 0.5), true);
  await bot.placeBlock(found.ref, found.face); // resolves when server confirms placement
  return `placed ${blockName} at ${t.x},${t.y},${t.z}`;
}

/** Walk to within reach of `target`, equip the best tool for it, and dig it. */
export async function physicalMine(bot, target) {
  const t = new Vec3(target.x, target.y, target.z);
  const block = bot.blockAt(t);
  if (!block || block.name === "air") return "nothing to mine";

  await gotoSafely(bot, new goals.GoalNear(t.x, t.y, t.z, 3), 60_000);
  if (bot.tool) await bot.tool.equipForBlock(block).catch(() => {}); // best tool we own
  if (!bot.canDigBlock(block)) throw new Error(`can't dig ${block.name} from here`);
  await bot.dig(block); // throws "dig time is Infinity" if the block needs a better tool
  return `mined ${block.name} at ${t.x},${t.y},${t.z}`;
}

/**
 * Block positions for a hollow-box shell (4 walls + floor), ordered BOTTOM-UP so
 * every block always has a solid block beneath it to place against. Roof is
 * omitted on purpose — interior ceiling blocks have nothing to reference.
 * `skipKeys` ("x,y,z" strings) lets callers leave openings (door, windows).
 */
export function boxShellPositions(origin, width, depth, height, skipKeys = new Set()) {
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) {
        const isWall = x === 0 || x === width - 1 || z === 0 || z === depth - 1;
        const isFloor = y === 0;
        const pos = { x: origin.x + x, y: origin.y + y, z: origin.z + z };
        if ((isWall || isFloor) && !skipKeys.has(`${pos.x},${pos.y},${pos.z}`)) out.push(pos);
      }
    }
  }
  out.sort((a, b) => a.y - b.y);
  return out;
}

/**
 * House openings for the shell: a 1x2 doorway mid-front wall, and a 1x1 window
 * at eye level (origin.y+2) mid-way along each of the other three walls.
 */
export function houseOpenings(origin, width, depth, height) {
  if (height < 3) return { door: [], windows: [] };
  const midX = origin.x + Math.floor(width / 2);
  const midZ = origin.z + Math.floor(depth / 2);
  const door = [
    { x: midX, y: origin.y + 1, z: origin.z },
    { x: midX, y: origin.y + 2, z: origin.z },
  ];
  const wy = origin.y + 2;
  const windows = [
    { x: midX, y: wy, z: origin.z + depth - 1 },
    { x: origin.x, y: wy, z: midZ },
    { x: origin.x + width - 1, y: wy, z: midZ },
  ];
  return { door, windows };
}
