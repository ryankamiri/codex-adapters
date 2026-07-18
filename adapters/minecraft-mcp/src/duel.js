// duel.js — a fair 1v1 against a human player.
//
// Unlike attack_entity (which hunts mobs and loots the drops), a duel is
// symmetric and ceremonial: both sides get the IDENTICAL kit, both are forced
// into survival so hits actually land, there's a countdown, and it resolves with
// a winner when somebody dies.
//
// Gear goes on via `/item replace entity <player> <slot> with <item>` rather than
// `/give`. /give only drops items into an inventory — the human would have to
// open their inventory and dress themselves mid-duel. /item replace equips the
// piece directly, which is the only way to gear up BOTH sides hands-free.
// Both commands need the bot to be opped; see the gear check below.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same armor material + sword tier on both sides. Kits are deliberately whole
// tiers apart so the fight feels different rather than marginally different.
export const KITS = {
  leather: { armor: "leather", sword: "wooden_sword" },
  iron: { armor: "iron", sword: "iron_sword" },
  diamond: { armor: "diamond", sword: "diamond_sword" },
  netherite: { armor: "netherite", sword: "netherite_sword" },
};

// 1.9+ equipment slot layout, mirrored by perception.js: 2=feet 3=legs 4=torso 5=head
const ARMOR_SLOTS = [
  ["armor.head", "helmet"],
  ["armor.chest", "chestplate"],
  ["armor.legs", "leggings"],
  ["armor.feet", "boots"],
];

const gearCommands = (who, kit) => [
  ...ARMOR_SLOTS.map(([slot, piece]) => `/item replace entity ${who} ${slot} with minecraft:${kit.armor}_${piece}`),
  `/item replace entity ${who} weapon.mainhand with minecraft:${kit.sword}`,
];

/**
 * Equip both fighters identically, count down, then fight to the death.
 *
 * @param {import("mineflayer").Bot} bot
 * @param {string} username    the human to duel
 * @param {string} kitName     one of KITS
 * @param {number} countdown   seconds announced in chat before the first swing
 * @param {number} timeoutMs   draw deadline
 */
export async function duelPlayer(bot, username, kitName = "iron", countdown = 3, timeoutMs = 120_000) {
  const kit = KITS[kitName];
  if (!kit) throw new Error(`unknown kit "${kitName}" — pick one of: ${Object.keys(KITS).join(", ")}`);

  const player = bot.players[username];
  if (!player?.entity) {
    const seen = Object.keys(bot.players).filter((n) => n !== bot.username);
    throw new Error(`can't see player "${username}" nearby — visible players: ${seen.join(", ") || "none"}`);
  }
  const target = player.entity;

  // Survival on both sides, or the fight is theatre: creative players take no
  // damage and spectators can't be hit at all.
  bot.chat(`/gamemode survival ${username}`);
  bot.chat(`/gamemode survival ${bot.username}`);
  await sleep(200);

  // Gear up both fighters. Spaced out so a burst of commands can't get dropped
  // by the server's command rate limiting.
  for (const cmd of [...gearCommands(username, kit), ...gearCommands(bot.username, kit)]) {
    bot.chat(cmd);
    await sleep(120);
  }
  await sleep(600); // let the equipment change sync back to us

  // Verify OUR OWN gear landed. If it didn't, the bot almost certainly isn't
  // opped — fail loudly here rather than starting a naked, unwinnable fight.
  const eq = bot.entity.equipment ?? [];
  const worn = [eq[5], eq[4], eq[3], eq[2]].filter(Boolean).length;
  if (worn === 0) {
    throw new Error(
      `gear never arrived — the bot is almost certainly not opped. Run "/op ${bot.username}" on the server (or give it permission level 2) and try again.`,
    );
  }

  bot.recordEvent?.(`duel vs ${username} starting (${kitName} kit)`);
  bot.chat(`${username}, ${kitName} kit — fight me. First to die loses.`);
  for (let n = countdown; n > 0; n--) {
    bot.chat(`${n}...`);
    await sleep(1000);
  }
  bot.chat("FIGHT!");

  const startHealth = bot.health;
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      bot.off("death", onSelfDeath);
      bot.off("entityDead", onEntityDead);
    };
    const finish = (msg) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(msg);
    };
    const onSelfDeath = () => finish(`${username} WINS — the bot died`);
    // entityDead fires for any entity; match on id so another player's death
    // somewhere on the server can't end our duel.
    const onEntityDead = (e) => {
      if (e?.id === target.id) finish(`the bot WINS — ${username} died`);
    };
    const timer = setTimeout(() => finish(`DRAW — neither fighter died within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);

    bot.on("death", onSelfDeath);
    bot.on("entityDead", onEntityDead);
    bot.pvp.attack(target);
  });

  bot.pvp.forceStop(); // stop swinging whichever way it ended
  bot.pathfinder.setGoal(null); // and stop chasing
  bot.recordEvent?.(`duel vs ${username} ended: ${outcome}`);
  bot.chat(outcome.includes("bot WINS") ? "gg" : "gg wp");

  return `${outcome}. Bot health ${Math.round(bot.health)}/20 (started at ${Math.round(startHealth)}/20), kit: ${kitName}.`;
}
