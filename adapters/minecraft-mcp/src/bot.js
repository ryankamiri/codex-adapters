// Bot lifecycle: create the mineflayer bot, load the survival plugin stack, and
// wire up REFLEXES — things a real player does without thinking (eat when
// hungry, wear armor, fight back when hit). The LLM does strategy through MCP
// tools; reflexes keep it alive between turns. (Two-tier design borrowed from
// mindcraft/Voyager.)
//
// Also keeps a short event memory (bot.recentEvents) — "took damage", "ate",
// "died" — surfaced through observe_world/scan_surroundings so the agent knows
// what happened between its turns.
//
// mineflayer + most plugins are CommonJS — imported via default + destructure.

import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import collectblockPkg from "mineflayer-collectblock";
import pvpPkg from "mineflayer-pvp";
import toolPkg from "mineflayer-tool";
import armorManager from "mineflayer-armor-manager";
import { loader as autoEat } from "mineflayer-auto-eat";

const { pathfinder, Movements } = pathfinderPkg;
const { plugin: collectBlock } = collectblockPkg; // pathfind → mine → pick up drops
const { plugin: pvp } = pvpPkg; // cooldown-aware melee combat
const { plugin: toolPlugin } = toolPkg; // bot.tool.equipForBlock — best-tool selection

/**
 * @param {import("./config.js").config} cfg
 * @returns {{ bot: import("mineflayer").Bot, ready: Promise<import("mineflayer").Bot> }}
 */
export function createMinecraftBot(cfg) {
  const bot = mineflayer.createBot({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    version: cfg.version,
    auth: "offline", // local offline-mode server; no Microsoft login
  });

  // Swallow stray errors so a late 'error' can't crash the MCP process.
  bot.on("error", (e) => console.error("[minecraft-mcp] bot error:", e?.message ?? e));
  bot.on("kicked", (reason) => console.error("[minecraft-mcp] kicked:", JSON.stringify(reason)));
  bot.on("end", (reason) => console.error("[minecraft-mcp] disconnected:", reason));

  // ── event memory: short log of what happened, read by perception tools ──
  bot.recentEvents = [];
  const record = (what) => {
    bot.recentEvents.push({ what, at: Date.now() });
    if (bot.recentEvents.length > 30) bot.recentEvents.shift();
    console.error(`[minecraft-mcp] event: ${what}`);
  };
  bot.recordEvent = record;

  const ready = new Promise((resolve, reject) => {
    bot.once("spawn", () => {
      try {
        // Load order matters: pathfinder first (pvp/collectblock depend on it).
        bot.loadPlugin(pathfinder);
        bot.loadPlugin(pvp);
        bot.loadPlugin(toolPlugin);
        bot.loadPlugin(collectBlock);
        bot.loadPlugin(armorManager);
        bot.loadPlugin(autoEat);

        // Escape-friendly pathing: the default pillar-jump materials are only
        // dirt+cobblestone — below y=0 mining drops cobbled_deepslate, so without
        // this the bot literally cannot tower out of deep caves. Also don't leap
        // into deep water.
        const movements = new Movements(bot);
        for (const n of ["cobbled_deepslate", "oak_planks", "spruce_planks", "birch_planks", "netherrack"]) {
          const it = bot.registry.itemsByName[n];
          if (it) movements.scafoldingBlocks.push(it.id);
        }
        movements.infiniteLiquidDropdownDistance = false;
        bot.pathfinder.setMovements(movements);

        if (cfg.difficulty) bot.chat(`/difficulty ${cfg.difficulty}`); // optional, needs op
        bot.chat(`/gamemode ${cfg.gameMode} @s`); // needs op; fails silently otherwise

        // ── reflexes (non-fatal if a plugin's API drifts) ──
        try {
          // Eat automatically when hungry/hurt, from whatever food is in inventory.
          // strictErrors:false — a failed auto-eat (no food) must not throw.
          bot.autoEat.setOpts({ priority: "foodPoints", minHunger: 15, minHealth: 14, strictErrors: false });
          bot.autoEat.enableAuto();
          bot.autoEat.on?.("eatFinish", () => record(`ate food (food ${bot.food}/20)`));
          bot.autoEat.on?.("eatFail", (e) => record(`eating failed: ${e?.message ?? e}`));
        } catch (e) {
          console.error("[minecraft-mcp] auto-eat setup failed:", e?.message ?? e);
        }

        // Wear the best armor we own — now, and shortly after picking items up.
        bot.armorManager.equipAll().catch(() => {});
        let armorTimer = null;
        bot.on("playerCollect", (collector) => {
          if (collector !== bot.entity) return;
          record("picked up a dropped item");
          clearTimeout(armorTimer);
          armorTimer = setTimeout(() => bot.armorManager.equipAll().catch(() => {}), 1500);
        });

        // Fight back: if something hurts us and a hostile mob is close, attack it.
        bot.on("entityHurt", (entity) => {
          if (entity !== bot.entity) return;
          record(`took damage (health ${Math.round(bot.health)}/20)`);
          if (bot.pvp.target) return; // already fighting
          const hostile = bot.nearestEntity(
            (e) => e.kind === "Hostile mobs" && e.position && e.position.distanceTo(bot.entity.position) < 12,
          );
          if (hostile) {
            record(`defending self against ${hostile.name}`);
            Promise.resolve(bot.pvp.attack(hostile)).catch(() => {});
          }
        });

        bot.on("death", () => record("DIED — respawned at spawn point; inventory dropped where you died"));
        bot.on("sleep", () => record("fell asleep in a bed"));
        bot.on("wake", () => record("woke up"));
        bot.on("path_update", (r) => {
          if (r.status === "noPath") record("pathfinding: no path to the current goal");
        });

        resolve(bot);
      } catch (e) {
        reject(e);
      }
    });
    bot.once("error", reject);
    bot.once("end", (reason) => reject(new Error(`disconnected before spawn: ${reason}`)));
  });

  return { bot, ready };
}
