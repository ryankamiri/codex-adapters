#!/usr/bin/env node
// minecraft-mcp — Codex Bodies adapter: hands + eyes in Minecraft.
//
// A stdio MCP server (newline-delimited JSON-RPC 2.0, one object per line, no
// SDK — same shape as applescript-mcp and the adapter-contract template). It
// holds a mineflayer bot (the ACTOR) and hands screenshots back as vision.
// Contract: ../../adapter-contract/CONTRACT.md
//
// The bot actually PLAYS survival: perceive (JSON + a screenshot) → gather →
// craft → build from real inventory. No /give, no /setblock cheats.
//
// IMPORTANT: stdout is the JSON-RPC channel. All logging MUST go to stderr
// (console.error) — a stray console.log would corrupt the protocol stream.

import "./src/stdout-guard.js"; // MUST be first: reroutes library console.log → stderr
import readline from "node:readline";
import pathfinderPkg from "mineflayer-pathfinder";
import vec3Pkg from "vec3";

import { config } from "./src/config.js";
import { createMinecraftBot } from "./src/bot.js";
import { scanSurroundings, recentEvents } from "./src/perception.js";
import {
  physicalPlace, physicalMine, boxShellPositions, houseOpenings, collectBlocks, craftItem,
  equipItem, eatFood, attackEntity, moveAway, sleepInBed, smeltItem, listCraftable,
  gotoSafely, goToSurface, setGameMode,
} from "./src/actions.js";
import { buildHouse } from "./src/house.js";
import { duelPlayer, KITS } from "./src/duel.js";
import { captureStructure } from "./src/structure.js";
import { takeSnapshot } from "./src/snapshot.js";

const { goals } = pathfinderPkg;
const Vec3 = vec3Pkg.Vec3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── JSON-RPC plumbing ───────────────────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, text) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
const okContent = (id, content) => send({ jsonrpc: "2.0", id, result: { content } });
const errResult = (id, text) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });

// ── tiny arg validation (replaces zod) — throws are caught → { isError } ─────
const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};
const int = (v, def, name) => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
};
const str = (v, name) => {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return v;
};
const xyz = (v, name) => {
  if (!v || typeof v !== "object") throw new Error(`${name} must be an object {x,y,z}`);
  return { x: num(v.x, `${name}.x`), y: num(v.y, `${name}.y`), z: num(v.z, `${name}.z`) };
};

// ── connect the bot (non-fatal: tools/list still works if MC is down) ────────
let bot = null;
let botError = null;
const { ready } = createMinecraftBot(config);
const botSpawned = ready
  .then((b) => {
    bot = b;
    console.error(`[minecraft-mcp] spawned as ${b.username} at ${b.entity.position}`);
  })
  .catch((e) => {
    botError = e;
    console.error("[minecraft-mcp] bot failed to connect:", e?.message ?? e);
  });

// Snapshots are plain `screencapture` of the real screen — no browser to warm
// up, nothing to initialise. See src/snapshot.js for why the headless-Chromium
// agent-POV renderer was dropped.

const timeout = (ms, msg) => new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));

/** Await the bot being ready (blocks through the warm-up instead of erroring). */
async function ensureBot() {
  if (!bot && !botError) await Promise.race([botSpawned, timeout(30_000, "bot did not connect within 30s")]);
  if (botError) throw new Error(`bot not connected: ${botError.message}. Is the Minecraft server running?`);
  if (!bot) throw new Error("bot not ready");
  return bot;
}

const XYZ = { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x", "y", "z"] };

// Survival context handed to the model: via `instructions` on initialize AND the
// survival_guide tool (belt and braces — not every client surfaces instructions).
const INSTRUCTIONS = `You control a Minecraft player. FIRST choose the game mode from the task:
• BUILD task (build/make/create something): call set_game_mode creative first. For a HOUSE, use build_house (one call → floor, walls, real roof, openable door, glass windows, torches). For other shapes use place_block / build_structure (free blocks in creative). Do NOT hand-build a house out of build_structure — it has no roof or door; build_house is the tool.
• SURVIVAL task (survive, gather, mine, get food/tools/diamonds, "play the game"): call set_game_mode survival and play for REAL — perceive → gather → craft → build from inventory. No cheating in survival.
If the task only says "build X", default to CREATIVE. If it says survive/gather/mine/play, default to SURVIVAL. When you switch tasks, switch modes.

Core loop (either mode): scan_surroundings (world JSON: threats, resources, inventory, recent events) + capture_snapshot (your eyes) → decide → act → re-scan. capture_snapshot after EVERY milestone — it is both your eyes and the demo artifact trail.

SURVIVAL specifics:
Progression: collect_block a *_log → craft_item planks → crafting_table → wooden_pickaxe → collect_block stone → stone tools → coal_ore → furnace → iron. Better tools unlock better blocks (stone needs a wooden pickaxe; iron ore needs stone).
Food: hunt animals with attack_entity (cow/pig/chicken/sheep). Eating is AUTOMATIC when food is in inventory; eat_food forces it.
Danger: night spawns zombies/skeletons/creepers. NEVER melee a creeper — move_away instead. Avoid lava and falls over 3 blocks. sleep_in_bed skips the night. Reflexes handled for you: auto-eat, auto-armor, fighting back when attacked.
Mining: keep 8+ cobblestone/dirt in inventory (needed to pillar out of caves). When underground and done (or stuck), call go_to_surface. If a navigation tool errors with "stuck", do NOT retry it — go_to_surface or move_away first.
Call survival_guide for the full crafting and strategy reference.`;

const SURVIVAL_GUIDE = `MINECRAFT SURVIVAL PLAYBOOK
(This is the SURVIVAL reference. For a pure BUILD task, set_game_mode creative instead
and build with free blocks — no gathering needed.)

FIRST 10 MINUTES (do this in order):
1. scan_surroundings — find the nearest *_log (any wood type works).
2. collect_block <wood>_log 4
3. craft_item <wood>_planks 4      (1 log → 4 planks)
4. craft_item crafting_table 1     (4 planks)
5. craft_item stick 4              (2 planks → 4 sticks)
6. craft_item wooden_pickaxe 1     (3 planks + 2 sticks; table is auto-placed from inventory)
7. collect_block stone 8           (wooden pickaxe mines stone → drops cobblestone)
8. craft_item stone_pickaxe / stone_axe / stone_sword
9. craft_item furnace 1            (8 cobblestone)
10. Before night: build a shelter (build_structure for a quick shell) or sleep_in_bed.

TOOL TIERS (what mines what): hand → wood, dirt | wooden pickaxe → stone, coal
| stone pickaxe → iron_ore | iron pickaxe → diamond_ore. Wrong tool = block drops nothing.

KEY RECIPES: torch = stick + coal. bed = 3 wool (kill sheep) + 3 planks.
iron_ingot = smelt_item raw_iron (needs furnace + fuel). bread = 3 wheat.
Cook meat in the furnace (smelt_item beef) — cooked food restores much more hunger.

FOOD: hunt cow/pig/chicken/sheep with attack_entity. Auto-eat keeps you fed if food
is in inventory. Cooked > raw. Never eat rotten_flesh unless desperate.

MOBS: zombie = melee, easy. skeleton = shoots arrows — rush it or take cover.
creeper = EXPLODES, never melee; move_away and let it lose interest. spider = passive
in daylight. Reflex: if something hits you, you automatically fight back.

DANGER RULES: don't dig straight down. Don't stand near lava. Falls > 3 blocks hurt.
Night + open ground = death; shelter, torches (light > 7 stops spawns), or bed.
Watch health/food in every scan; retreat (move_away) when health < 8.

MINING SAFETY: always carry 8+ spare cobblestone/dirt — the pathfinder pillar-jumps
with them to climb out of caves. Mine ores in short trips, then go_to_surface.
If navigation reports "stuck" or "timed out": call go_to_surface (it digs/climbs to
open sky). Still stuck? mine_block a diagonal staircase upward one block at a time
(mine head-height block, then the step, move up, repeat — never mine straight up).

STRATEGY: wood → stone → iron. Keep a weapon equipped when exploring (equip_item).
Store extra loot before risky trips. Check recent events in scans — they tell you
what happened while you were thinking (damage taken, items picked up, deaths).`;

// ── tool descriptors ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "observe_world",
    description:
      "Report the bot's current state: position, health, food, game mode, held item, time, and nearby players. Call this to see where the bot is before and after acting.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "scan_surroundings",
    description:
      "Your main senses — JSON of the world around the bot: nearest resource blocks (coords + distance), THREATS (hostile mobs), animals (food), dropped items, inventory, armor, time of day (night = danger), and recent events (damage taken, items picked up, deaths). Call this before every decision.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_blocks",
    description:
      "Find the nearest blocks of a given type and return their coordinates. Use this to locate resources before navigating or gathering (e.g. find oak_log).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        maxDistance: { type: "integer", minimum: 4, maximum: 128, default: 64 },
      },
      required: ["name"],
    },
  },
  {
    name: "collect_block",
    description:
      "Gather resources like a player would: find the nearest blocks of this type, walk to them, mine them, and pick up the drops into inventory. This is how the bot OBTAINS materials (e.g. collect_block oak_log 4). No cheating — it actually harvests them.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 64, default: 1 } },
      required: ["name"],
    },
  },
  {
    name: "craft_item",
    description:
      "Craft an item from materials in the bot's inventory. Automatically uses a crafting table within 6 blocks — and if the recipe needs one that isn't nearby but the bot is carrying one, places it first. Errors name the exact missing ingredients. E.g. craft_item oak_planks from oak_log.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 64, default: 1 } },
      required: ["name"],
    },
  },
  {
    name: "list_craftable",
    description:
      "List every item the bot can craft RIGHT NOW from its current inventory (and a nearby crafting table, if any). Call this when unsure what to make next.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "smelt_item",
    description:
      "Smelt/cook items in a furnace within 24 blocks: walks over, loads fuel + input, waits, takes the output. Use for iron (smelt_item raw_iron) and cooking meat (smelt_item beef). Default fuel is coal; pass fuel to use charcoal/planks. Craft + place a furnace first if there isn't one.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "input item, e.g. raw_iron, beef, sand" },
        count: { type: "integer", minimum: 1, maximum: 64, default: 1 },
        fuel: { type: "string", default: "coal" },
      },
      required: ["name"],
    },
  },
  {
    name: "eat_food",
    description:
      "Eat food from inventory to restore hunger (a specific item, or the first edible thing if name is omitted). Eating is usually AUTOMATIC when hungry — use this only to top up before a fight or when auto-eat reports failure.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
  {
    name: "equip_item",
    description:
      "Equip an inventory item: a tool/weapon/block to 'hand', armor to head/torso/legs/feet, or a shield to 'off-hand'. Armor is normally auto-equipped; use this for weapons and tools.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        destination: { type: "string", enum: ["hand", "head", "torso", "legs", "feet", "off-hand"], default: "hand" },
      },
      required: ["name"],
    },
  },
  {
    name: "attack_entity",
    description:
      "Fight a nearby mob or player by name: pursues it and melee-attacks with proper timing until it dies or 60s passes, then picks up the drops. This is how you HUNT for food (attack_entity cow) and clear hostile mobs. NEVER use on a creeper — it explodes; move_away instead.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "duel_player",
    description:
      "Fight a 1v1 duel against a human player. Equips BOTH the bot and the player with the same armor + sword kit, puts both in survival, counts down in chat, then fights until one of them dies — and reports the winner. Use this when a user asks you to fight them, duel them, or 'pvp' them. Requires the bot to be opped. For hunting animals or killing mobs use attack_entity instead.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Exact username of the player to duel." },
        kit: { type: "string", enum: Object.keys(KITS), default: "iron", description: "Gear tier given to BOTH fighters." },
        countdown: { type: "integer", minimum: 0, maximum: 10, default: 3, description: "Seconds counted down in chat before the first swing." },
      },
      required: ["username"],
    },
  },
  {
    name: "move_away",
    description:
      "Retreat: pathfind at least this many blocks away from the current spot, in any safe direction. Use to escape creepers, mob crowds, or danger while hurt.",
    inputSchema: { type: "object", properties: { distance: { type: "number", minimum: 2, maximum: 64, default: 8 } } },
  },
  {
    name: "sleep_in_bed",
    description:
      "Find a bed within 24 blocks, walk to it, and sleep to skip the night (wakes at dawn automatically). Fails with the exact reason if it can't (not night, monsters nearby, no bed — craft one from 3 wool + 3 planks).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "survival_guide",
    description:
      "The full survival playbook: first-10-minutes checklist, tool tiers, key recipes, mob guide, and danger rules. Read this once at the start of a survival session before making a plan.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_game_mode",
    description:
      "Set the bot's game mode to match the task. Use 'creative' for BUILD tasks — blocks become FREE, so place_block/build_structure work without any gathering; build immediately. Use 'survival' to play the game for real (gather → craft → build from inventory, mobs, hunger). Requires the bot to be opped. Call this FIRST based on what the user asked for.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["survival", "creative", "adventure", "spectator"] } },
      required: ["mode"],
    },
  },
  {
    name: "navigate_to",
    description:
      "Walk the bot to the given coordinates using pathfinding (it can dig and bridge on the way). Aborts with an error instead of hanging if it gets stuck or times out — then try go_to_surface or move_away.",
    inputSchema: XYZ,
  },
  {
    name: "go_to_surface",
    description:
      "ESCAPE TOOL: climb/dig back up to open sky from underground (caves, mineshafts, holes). Use whenever you are below ground and done mining, or when navigation keeps failing underground. Needs some blocks in inventory (cobblestone/dirt/planks) to pillar up with.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "follow_player",
    description:
      "Continuously follow a player around (they physically trail the bot). Great for live spectating. Call stop_moving to stop.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string" }, range: { type: "number", default: 2 } },
      required: ["username"],
    },
  },
  { name: "stop_moving", description: "Stop the bot's current movement or following.", inputSchema: { type: "object", properties: {} } },
  {
    name: "look_at",
    description: "Turn the bot's head to look at the given coordinates (visible head/body turn).",
    inputSchema: XYZ,
  },
  { name: "jump", description: "Make the bot jump once.", inputSchema: { type: "object", properties: {} } },
  {
    name: "say",
    description: "Send a chat message in-game as the bot (visible to spectators in chat).",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "mine_block",
    description:
      "Physically walk to a block and mine it (auto-equips the best tool the bot owns for it first). Coordinates of the block to break. Fails if the block needs a better tool tier than the bot has.",
    inputSchema: XYZ,
  },
  {
    name: "place_block",
    description:
      "Physically walk up to a spot and place a block by hand (equips it and places against a neighbouring block). In creative the block is free; in survival you must already have it in inventory (collect_block / craft_item first).",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, blockType: { type: "string" } },
      required: ["x", "y", "z", "blockType"],
    },
  },
  {
    name: "build_structure",
    description:
      "Low-level builder: physically place a rectangular hollow-box shell (4 walls + floor, NO roof) block by block, bottom-up. For an actual HOUSE (roof, door, windows, lights) use build_house instead — this is only for open shells/platforms/walls. In creative the blocks are FREE; in survival you must already have enough of `block` in inventory.",
    inputSchema: {
      type: "object",
      properties: {
        origin: XYZ,
        width: { type: "integer", minimum: 2, maximum: 16, default: 5 },
        depth: { type: "integer", minimum: 2, maximum: 16, default: 5 },
        height: { type: "integer", minimum: 2, maximum: 8, default: 3 },
        block: { type: "string", default: "oak_planks" },
        windows: { type: "boolean", default: false },
      },
      required: ["origin"],
    },
  },
  {
    name: "capture_snapshot",
    description:
      "Take a screenshot of the live macOS screen (where you're spectating the bot in your Minecraft client) as a PNG artifact. It is BOTH saved to the artifacts directory AND returned to you as an image so you can SEE the world and judge your progress. Use it to look before/after building and to verify results.",
    inputSchema: { type: "object", properties: { label: { type: "string" } } },
  },
  {
    name: "build_house",
    description:
      "Build a COMPLETE, enclosed house at `origin` (its min-corner, at floor level) — floor, walls, a real roof (gabled by default), an actual openable oak_door, glass windows, and interior torches. This is THE tool for 'build me a house'. Pick flat open ground; it auto-levels minor bumps. Needs the bot opped (the creative build flow already ops it). Defaults make a good 7x7 house; override size/materials as asked.",
    inputSchema: {
      type: "object",
      properties: {
        origin: XYZ,
        width: { type: "integer", minimum: 5, maximum: 24, default: 7 },
        depth: { type: "integer", minimum: 5, maximum: 24, default: 7 },
        wallHeight: { type: "integer", minimum: 3, maximum: 10, default: 4 },
        wall: { type: "string", default: "oak_planks", description: "wall material block" },
        roof: { type: "string", default: "spruce_planks", description: "roof material block" },
        floor: { type: "string", default: "oak_planks", description: "floor material block" },
        roofStyle: { type: "string", enum: ["peaked", "flat"], default: "peaked" },
        windows: { type: "boolean", default: true },
        door: { type: "boolean", default: true },
        light: { type: "boolean", default: true },
      },
      required: ["origin"],
    },
  },
  {
    name: "capture_structure",
    description:
      "Capture all blocks in a region into a portable JSON structure artifact. Use this to hand the build off to other apps (e.g. recreate it in Blender). Provide the two opposite corners of the region.",
    inputSchema: {
      type: "object",
      properties: { from: XYZ, to: XYZ, label: { type: "string" } },
      required: ["from", "to"],
    },
  },
];

// ── tool dispatch ─────────────────────────────────────────────────────────────
async function callTool(id, name, args = {}) {
  try {
    switch (name) {
      case "observe_world": {
        const b = await ensureBot();
        const p = b.entity.position;
        const eq = b.entity.equipment ?? [];
        return ok(
          id,
          JSON.stringify(
            {
              position: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
              health: b.health,
              food: b.food,
              gameMode: b.game?.gameMode,
              heldItem: b.heldItem?.name ?? null,
              armor: { head: eq[5]?.name ?? null, torso: eq[4]?.name ?? null, legs: eq[3]?.name ?? null, feet: eq[2]?.name ?? null },
              timeOfDay: b.time?.timeOfDay,
              isDay: b.time?.isDay,
              nearbyPlayers: Object.keys(b.players).filter((n) => n !== b.username),
              username: b.username,
              version: b.version,
              recentEvents: recentEvents(b),
            },
            null,
            2,
          ),
        );
      }

      case "scan_surroundings": {
        const b = await ensureBot();
        return ok(id, JSON.stringify(scanSurroundings(b), null, 2));
      }

      case "find_blocks": {
        const b = await ensureBot();
        const blockName = str(args.name, "name");
        const count = int(args.count, 5, "count");
        const maxDistance = int(args.maxDistance, 64, "maxDistance");
        const blockId = b.registry.blocksByName[blockName]?.id;
        if (blockId === undefined) throw new Error(`unknown block type: ${blockName}`);
        const hits = b.findBlocks({ matching: blockId, maxDistance, count });
        return ok(id, JSON.stringify(hits.map((p) => ({ x: p.x, y: p.y, z: p.z })), null, 2));
      }

      case "collect_block": {
        const b = await ensureBot();
        const blockName = str(args.name, "name");
        const count = int(args.count, 1, "count");
        const got = await collectBlocks(b, blockName, count);
        return ok(id, `collected ${got}x ${blockName}${got < count ? ` (only ${got} were reachable)` : ""}`);
      }

      case "craft_item": {
        const b = await ensureBot();
        const itemName = str(args.name, "name");
        const count = int(args.count, 1, "count");
        return ok(id, await craftItem(b, itemName, count));
      }

      case "list_craftable": {
        const b = await ensureBot();
        return ok(id, JSON.stringify(listCraftable(b), null, 2));
      }

      case "smelt_item": {
        const b = await ensureBot();
        const itemName = str(args.name, "name");
        const count = int(args.count, 1, "count");
        const fuel = args.fuel === undefined ? "coal" : str(args.fuel, "fuel");
        return ok(id, await smeltItem(b, itemName, count, fuel));
      }

      case "eat_food": {
        const b = await ensureBot();
        const foodName = args.name === undefined ? undefined : str(args.name, "name");
        return ok(id, await eatFood(b, foodName));
      }

      case "equip_item": {
        const b = await ensureBot();
        const itemName = str(args.name, "name");
        const destination = args.destination === undefined ? "hand" : str(args.destination, "destination");
        return ok(id, await equipItem(b, itemName, destination));
      }

      case "attack_entity": {
        const b = await ensureBot();
        return ok(id, await attackEntity(b, str(args.name, "name")));
      }

      case "duel_player": {
        const b = await ensureBot();
        const username = str(args.username, "username");
        const kit = args.kit === undefined ? "iron" : str(args.kit, "kit");
        const countdown = int(args.countdown, 3, "countdown");
        return ok(id, await duelPlayer(b, username, kit, countdown));
      }

      case "move_away": {
        const b = await ensureBot();
        const distance = args.distance === undefined ? 8 : num(args.distance, "distance");
        return ok(id, await moveAway(b, distance));
      }

      case "sleep_in_bed": {
        const b = await ensureBot();
        return ok(id, await sleepInBed(b));
      }

      case "survival_guide":
        return ok(id, SURVIVAL_GUIDE);

      case "set_game_mode": {
        const b = await ensureBot();
        return ok(id, await setGameMode(b, str(args.mode, "mode")));
      }

      case "navigate_to": {
        const b = await ensureBot();
        const { x, y, z } = xyz(args, "args");
        await gotoSafely(b, new goals.GoalNear(x, y, z, 1));
        return ok(id, `walked to near ${x}, ${y}, ${z}`);
      }

      case "go_to_surface": {
        const b = await ensureBot();
        return ok(id, await goToSurface(b));
      }

      case "follow_player": {
        const b = await ensureBot();
        const username = str(args.username, "username");
        const range = args.range === undefined ? 2 : num(args.range, "range");
        const target = b.players[username]?.entity;
        if (!target) throw new Error(`can't see player "${username}" nearby`);
        b.pathfinder.setGoal(new goals.GoalFollow(target, range), true); // dynamic = keep following
        return ok(id, `now following ${username}`);
      }

      case "stop_moving": {
        const b = await ensureBot();
        b.pathfinder.setGoal(null);
        b.pvp?.forceStop?.();
        return ok(id, "stopped moving and fighting");
      }

      case "look_at": {
        const b = await ensureBot();
        const { x, y, z } = xyz(args, "args");
        await b.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true);
        return ok(id, `looking at ${x}, ${y}, ${z}`);
      }

      case "jump": {
        const b = await ensureBot();
        b.setControlState("jump", true);
        await sleep(350);
        b.setControlState("jump", false);
        return ok(id, "jumped");
      }

      case "say": {
        const b = await ensureBot();
        const message = str(args.message, "message");
        b.chat(message.startsWith("/") ? message.slice(1) : message); // never let 'say' run a command
        return ok(id, `said: ${message}`);
      }

      case "mine_block": {
        const b = await ensureBot();
        const { x, y, z } = xyz(args, "args");
        return ok(id, await physicalMine(b, { x, y, z }));
      }

      case "place_block": {
        const b = await ensureBot();
        const { x, y, z } = xyz(args, "args");
        const blockType = str(args.blockType, "blockType");
        return ok(id, await physicalPlace(b, { x, y, z }, blockType));
      }

      case "build_structure": {
        const b = await ensureBot();
        const origin = xyz(args.origin, "origin");
        const width = int(args.width, 5, "width");
        const depth = int(args.depth, 5, "depth");
        const height = int(args.height, 3, "height");
        const block = args.block === undefined ? "oak_planks" : str(args.block, "block");
        const withWindows = args.windows === true;
        const openings = withWindows ? houseOpenings(origin, width, depth, height) : { door: [], windows: [] };
        const skip = new Set([...openings.door, ...openings.windows].map((p) => `${p.x},${p.y},${p.z}`));
        const positions = boxShellPositions(origin, width, depth, height, skip);
        let placed = 0;
        let failed = 0;
        for (const pos of positions) {
          try {
            const r = await physicalPlace(b, pos, block);
            if (r.startsWith("placed")) placed++;
          } catch (e) {
            failed++;
            console.error(`[minecraft-mcp] build: couldn't place ${pos.x},${pos.y},${pos.z}: ${e?.message ?? e}`);
          }
        }
        // glaze the window holes if we have glass
        let glazed = 0;
        if (withWindows && b.inventory.items().some((i) => i.name === "glass")) {
          for (const w of openings.windows) {
            try {
              const r = await physicalPlace(b, w, "glass");
              if (r.startsWith("placed")) glazed++;
            } catch {}
          }
        }
        const houseNote = withWindows ? `; doorway + ${openings.windows.length} windows (${glazed} glazed with glass)` : "";
        return ok(id, `built ${block} shell by hand: ${placed} placed, ${failed} skipped${houseNote} (${width}x${depth}x${height} at ${origin.x},${origin.y},${origin.z})`);
      }

      case "capture_snapshot": {
        const label = args.label === undefined ? "progress" : str(args.label, "label");
        const art = await takeSnapshot(config.artifactsDir, label);
        return okContent(id, [
          { type: "text", text: `snapshot saved (${art.source === "agent-pov" ? "agent's POV" : "screen capture"}): ${art.path}` },
          { type: "image", data: art.base64, mimeType: "image/png" },
        ]);
      }

      case "build_house": {
        const b = await ensureBot();
        const origin = xyz(args.origin, "origin");
        const res = await buildHouse(b, origin, {
          width: args.width,
          depth: args.depth,
          wallHeight: args.wallHeight,
          wall: args.wall,
          roof: args.roof,
          floor: args.floor,
          roofStyle: args.roofStyle,
          windows: args.windows,
          door: args.door,
          light: args.light,
        });
        return ok(id, res);
      }

      case "capture_structure": {
        const b = await ensureBot();
        const from = xyz(args.from, "from");
        const to = xyz(args.to, "to");
        const label = args.label === undefined ? "structure" : str(args.label, "label");
        const art = await captureStructure(b, from, to, config.artifactsDir, label);
        return ok(id, `saved structure artifact: ${art.path}`);
      }

      default:
        return errResult(id, `unknown tool: ${name}`);
    }
  } catch (e) {
    return errResult(id, `${name || "tool"} failed: ${e?.message ?? e}`);
  }
}

// ── JSON-RPC loop ─────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  lastActivity = Date.now(); // feeds the idle-exit watchdog below
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "minecraft-mcp", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      },
    });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    void callTool(id, params?.name, params?.arguments);
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} }); // answer anything else so the client never hangs
  }
});

// A reflex/plugin hiccup must never kill the process — a dead adapter fails the
// whole turn AND makes the bot leave the game. Log it and keep playing.
process.on("uncaughtException", (e) => console.error("[minecraft-mcp] uncaught exception:", e?.stack ?? e));
process.on("unhandledRejection", (e) => console.error("[minecraft-mcp] unhandled rejection:", e?.stack ?? e));

// ── clean shutdown so we NEVER orphan a bot holding the username + port ──
let shuttingDown = false;
async function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[minecraft-mcp] shutting down (${why})`);
  // Hard deadline so cleanup can never wedge the process. A shutdown that
  // hangs leaves an orphan alive holding a bot session — observed in practice.
  setTimeout(() => process.exit(0), 5000).unref();
  try {
    bot?.quit();
  } catch {}
  process.exit(0);
}
rl.on("close", () => shutdown("stdin closed")); // parent (app-server) died → EOF
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// The Codex app-server spawns a FRESH set of adapters per turn and does not stop
// the previous set. That is expensive here specifically: every superseded
// instance keeps a headless Chromium (~430 MB) AND a second bot logged into the
// Minecraft server. A superseded instance never gets another tools/call, so idle
// time is the signal we've been replaced. Also exit if reparented to init
// (ppid 1), which means the parent died without our stdin reaching EOF.
const IDLE_EXIT_MS = Number(process.env.MCP_IDLE_EXIT_MS ?? 15 * 60_000);
let lastActivity = Date.now();
if (IDLE_EXIT_MS > 0) {
  setInterval(() => {
    if (process.ppid === 1) return shutdown("orphaned (parent died)");
    if (Date.now() - lastActivity > IDLE_EXIT_MS) {
      shutdown(`idle ${Math.round(IDLE_EXIT_MS / 60_000)}m — superseded by a newer instance`);
    }
  }, 30_000).unref();
}

console.error("[minecraft-mcp] MCP server ready on stdio");
