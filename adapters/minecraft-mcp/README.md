# minecraft-mcp

A Relay adapter that gives Codex **hands and eyes in Minecraft**: a
mineflayer bot plays survival, macOS `screencapture` grabs progress screenshots
of the game you're spectating, and prismarine-schematic exports the build as JSON
for hand-off to other apps (Blender).

It follows the [adapter contract](../../adapter-contract/CONTRACT.md): a single
`server.mjs` stdio MCP server (newline-delimited JSON-RPC, no SDK), same shape as
`applescript-mcp`.

```
Codex ──(MCP tools)──▶ mineflayer bot ──▶ plays in the world       (ACTOR)
                              │
   you spectate in your own Minecraft client ──▶ 📸 screencapture   (CAMERA)
                              │
                     prismarine-schematic ──▶ structure.json   (Blender hand-off)
```

## How it plays

**Mode follows the task.** The agent picks its game mode from what you ask:
- **Build tasks** ("build a house with windows") → it calls `set_game_mode creative`
  and builds immediately — in creative, `place_block`/`build_structure` materialize
  the blocks for **free**, no gathering.
- **Survival tasks** ("survive the night", "gather iron", "play the game") → it calls
  `set_game_mode survival` and plays for real (perceive → gather → craft → build from
  inventory). No cheating in survival.

In survival it plays like another player — a two-tier design borrowed from
mindcraft/Voyager (the flagship LLM-Minecraft agents):

1. **Reflexes (automatic, zero LLM turns):** auto-eats when hungry (`mineflayer-auto-eat`),
   auto-equips the best armor it owns (`mineflayer-armor-manager`), fights back when
   attacked (`mineflayer-pvp`), and auto-selects the right tool before mining
   (`mineflayer-tool`). The agent never has to remember to survive.
2. **Deliberate tools (the LLM's moves):** perceive → gather → craft → smelt → fight →
   build, from real inventory. No `/give`, no `/setblock` cheats.

Survival knowledge ships with the adapter: the MCP `initialize` response carries a
survival playbook in `instructions`, and the `survival_guide` tool returns the full
strategy reference (first-10-minutes checklist, tool tiers, recipes, mob guide).
Every scan also includes a **recent-events memory** ("took damage", "ate", "died",
"picked up item") so the agent knows what happened between its turns.

| Tool | What it does |
|---|---|
| **Perceive** | |
| `observe_world` | self state: position, health, food, armor, held item, day/night, recent events |
| `scan_surroundings` | **the main senses**: nearest resource blocks, **threats** (hostile mobs), animals (food), drops, inventory, armor, time/light, recent events |
| `find_blocks {name,count,maxDistance}` | coordinates of the nearest blocks of a type |
| `capture_snapshot {label?}` | **the agent's first-person POV** (hidden prismarine-viewer + headless Chromium) → saved PNG artifact **and returned to the model as vision**; falls back to `screencapture` of your screen if the viewer can't render |
| `survival_guide` | the full survival playbook (static reference) |
| **Mode** | |
| `set_game_mode {mode}` | switch creative (free blocks for BUILD tasks) / survival (play for real); needs op |
| **Gather / craft / smelt** | |
| `collect_block {name,count}` | find → walk → auto-tool → mine → pick up drops |
| `mine_block {x,y,z}` | dig one specific block (auto-equips the best tool owned) |
| `craft_item {name,count}` | craft from inventory; auto-places a carried crafting table when needed; errors name the missing ingredients |
| `list_craftable` | everything craftable right now from inventory |
| `smelt_item {name,count,fuel?}` | furnace flow: walk over, load fuel+input, wait, take output (iron! cooked food!) |
| **Survive** | |
| `eat_food {name?}` | eat now (eating is otherwise automatic when food is in inventory) |
| `equip_item {name,destination?}` | equip weapon/tool/armor/shield |
| `attack_entity {name}` | pursue + melee a mob/player until dead (≤60s), then loot the drops — hunting and defense |
| `move_away {distance?}` | retreat from the current spot (creepers!) |
| `sleep_in_bed` | find a bed ≤24 blocks, sleep to skip the night |
| **Move** | `navigate_to`, `follow_player`, `stop_moving` (also stops fighting), `look_at`, `jump`, `say` |
| **Build** | |
| `build_house {origin,width,depth,wallHeight,...}` | **THE house builder** — one call makes a complete enclosed house: floor, walls, a real gabled/flat roof, an openable oak_door, glass windows, and interior torches. Auto-levels the ground. Needs op. |
| `place_block {x,y,z,blockType}` | place one block by hand (free in creative, from inventory in survival) |
| `build_structure {origin,w,d,h,block}` | low-level: a wall+floor shell only (**no roof/door**) — for platforms/walls, not houses |
| `capture_structure {from,to,label?}` | export a region → **structure JSON artifact** (Blender hand-off) |

> No cheating: `place_block`/`build_structure` fail if the bot doesn't have the material —
> it must `collect_block`/`craft_item` first. Physical play is slow and flakier than commands
> (that slowness is the spectacle). **Flat ground** makes pathing far more reliable.

### Watch it live (and play alongside)
Join the server yourself in the Minecraft client — spectate (`/spectate CodexBot`)
or just play. Snapshots come from the **bot's own POV** via a hidden off-screen
renderer, so they work even while you're playing on the visible screen. You can
also open `http://127.0.0.1:3007` to watch through the agent's eyes.

## Prerequisites

1. **Node ≥ 22** (mineflayer 4.x requirement).
2. A **local, offline** Minecraft **1.21.1** server:
   - `server.properties`: `online-mode=false` (so `auth: "offline"` can join)
   - start it, then op the bot once it has joined: in the server console run `op CodexBot`
     (or set `MC_USERNAME` and op that name).
3. Install deps + the snapshot browser:
   ```bash
   cd adapters/minecraft-mcp
   npm install
   npx playwright install chromium
   ```
4. **Screen Recording permission** (macOS): only needed for the `screencapture`
   *fallback* path (grant it to your terminal under *System Settings → Privacy &
   Security → Screen Recording*). The primary agent-POV snapshots need nothing.

## Test it standalone (no Codex)

With the Minecraft server running, the bot opped, and the game visible on screen,
from the **repo root**:

```bash
node adapters/minecraft-mcp/test/smoke.mjs
```

Expected: `spawned at …` → builds a 5×5×4 oak shell via `/fill` → `📸 snapshot → …png` →
`🧱 structure → …json` (both under `data/artifacts/`).

## Register with Codex (once the smoke test is green)

```bash
codex mcp add minecraft \
  --env ARTIFACTS_DIR="$PWD/data/artifacts" \
  --env MC_VERSION=1.21.1 \
  -- node "$PWD/adapters/minecraft-mcp/server.mjs"
```

Then drive it through the terminal harness:
`./scripts/play.sh "Gather wood and build a small oak shelter, capturing snapshots as you go."`

> Run it via **`./scripts/play.sh`** (a single-process `node --import tsx` launcher), **not**
> `npx tsx …`. With `npx`/`npm` in the process group, a Ctrl+C tears down the wrapper, closes
> the CLI's stdin, and the bot gets kicked. `play.sh` `exec`s node so Ctrl+C only interrupts the
> current turn — the bot stays in the game. Type `/quit` (or Ctrl+C at the `»` prompt) to disconnect.
> Add `--model gpt-5.4-mini` for the cheap model, `--loop 5` for endless autonomous play.

## Config (env vars)

| Var | Default | Notes |
|---|---|---|
| `MC_HOST` / `MC_PORT` | `127.0.0.1` / `25565` | Minecraft server address |
| `MC_VERSION` | `1.21.1` | pin to your server |
| `MC_USERNAME` | `CodexBot` | op this name |
| `MC_GAMEMODE` | `survival` | game mode set on spawn |
| `MC_DIFFICULTY` | *(unset)* | if set (e.g. `peaceful`), runs `/difficulty` on spawn; default leaves the server's difficulty alone — real survival includes mobs |
| `VIEWER_PORT` | `3007` | agent-POV renderer used by `capture_snapshot` (also viewable in a browser) |
| `ARTIFACTS_DIR` | `./data/artifacts` | where snapshots/structures are written |
