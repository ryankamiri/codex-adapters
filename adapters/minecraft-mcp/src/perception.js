// Perception: turn mineflayer's world model into a compact JSON the agent can
// reason over — "what's around me, what threatens me, what do I have, what
// just happened?"

import vec3Pkg from "vec3";
const Vec3 = vec3Pkg.Vec3;

// Always-notable blocks; wood/ore/bed variants are added dynamically from the
// registry so every 1.21 variant (cherry_log, deepslate_iron_ore…) is covered.
const FIXED_NOTABLE = [
  "stone", "cobblestone", "dirt", "grass_block", "sand", "gravel",
  "water", "lava", "crafting_table", "furnace", "chest",
];

function notableBlockIds(reg) {
  const idToName = new Map();
  const add = (name) => {
    const b = reg.blocksByName[name];
    if (b) idToName.set(b.id, name);
  };
  for (const name of FIXED_NOTABLE) add(name);
  for (const name of Object.keys(reg.blocksByName)) {
    if (name.endsWith("_log") || name.endsWith("_ore") || name.endsWith("_bed")) add(name);
  }
  return idToName;
}

/** A compact JSON snapshot of the world around the bot. */
export function scanSurroundings(bot, radius = 32) {
  const me = bot.entity.position;
  const reg = bot.registry;

  // nearest instance of each notable block type — one scan pass, closest-first
  const idToName = notableBlockIds(reg);
  const hits = bot.findBlocks({ matching: [...idToName.keys()], maxDistance: radius, count: 400 });
  const nearestBlocks = {};
  for (const p of hits) {
    const name = bot.blockAt(p)?.name;
    if (!name || nearestBlocks[name]) continue; // hits are sorted nearest-first
    nearestBlocks[name] = { x: p.x, y: p.y, z: p.z, distance: Math.round(me.distanceTo(p)) };
  }

  // nearby entities, split by what they mean to a survival player
  const threats = []; // hostile mobs — fight or flee
  const animals = []; // passive mobs — food/resources
  const drops = []; // items on the ground — walk over to pick up
  const players = [];
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position) continue;
    const d = Math.round(me.distanceTo(e.position));
    if (d > radius) continue;
    const pos = { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) };
    if (e.type === "player") players.push({ name: e.username, distance: d });
    else if (e.kind === "Hostile mobs") threats.push({ name: e.name, distance: d, ...pos });
    else if (e.kind === "Passive mobs") animals.push({ name: e.name, distance: d });
    else if (e.name === "item") drops.push({ distance: d, ...pos });
  }
  threats.sort((a, b) => a.distance - b.distance);
  animals.sort((a, b) => a.distance - b.distance);
  drops.sort((a, b) => a.distance - b.distance);

  // inventory rolled up by item name
  const inventory = {};
  for (const it of bot.inventory.items()) inventory[it.name] = (inventory[it.name] ?? 0) + it.count;

  // what we're wearing (equipment layout 1.9+: 2=feet 3=legs 4=torso 5=head)
  const eq = bot.entity.equipment ?? [];
  const armor = {
    head: eq[5]?.name ?? null,
    torso: eq[4]?.name ?? null,
    legs: eq[3]?.name ?? null,
    feet: eq[2]?.name ?? null,
    offHand: eq[1]?.name ?? null,
  };

  const feet = bot.blockAt(me);
  const environment = {
    timeOfDay: bot.time?.timeOfDay,
    isDay: bot.time?.isDay, // false = night: hostile mobs spawn, consider sleeping
    isRaining: bot.isRaining,
    lightAtFeet: feet?.light ?? null, // ≤7 in darkness = mobs can spawn nearby
    dimension: bot.game?.dimension,
  };

  return {
    position: { x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z) },
    health: bot.health,
    food: bot.food,
    heldItem: bot.heldItem?.name ?? null,
    armor,
    inventory,
    environment,
    nearestBlocks,
    threats: threats.slice(0, 10),
    animals: animals.slice(0, 10),
    drops: drops.slice(0, 8),
    players,
    recentEvents: recentEvents(bot),
  };
}

/** The bot's short event memory ("took damage", "ate", "died"), newest last. */
export function recentEvents(bot, limit = 12) {
  return (bot.recentEvents ?? [])
    .slice(-limit)
    .map((e) => ({ what: e.what, secondsAgo: Math.round((Date.now() - e.at) / 1000) }));
}
