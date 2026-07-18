# Codex Bodies — Hackathon Plan (Ramp)

Repo: `~/codex-shi` (currently empty — greenfield). Working name "Codex Bodies"; rename freely.

## 1. Context & Positioning

**What we're building:** a framework that turns live desktop applications (Minecraft, Blender, browsers…) into environments a coding agent (Codex) can perceive and act in — plus a **generator** that creates new app adapters from a prose prompt + local docs, and a **dashboard** that shows the agent working across apps in real time.

**Why this isn't "ChatGPT's plugin maker":** OpenAI's `@plugin-creator` (per `build-plugins.md`) only _packages_ an already-existing MCP server into a `plugin.json` + marketplace entry. It generates zero app-control code, and their docs mention nothing about driving live applications. Our wedge is exactly that gap:

> **We generate and run the adapter code itself** — the MCP server that drives a live app's runtime (Mineflayer bot, `bpy` inside Blender, Playwright). The MCP wire format is the commodity; the app-runtime adapter is the product.

**Three deliverables, one contract:**

1. **Dashboard** — submit missions, watch a live timeline, see adapters + artifacts.
2. **Two pre-generated demo adapters** — Minecraft + Blender, with the flagship cross-app mission.
3. **Generator** — user describes intent + drops in local doc files → Codex proposes a toolkit → user approves → Codex writes the adapter → auto-registered, smoke-tested, appears in dashboard.

**Demo stance (decided):** adapters are pre-generated before the demo; on stage we show the _generation inputs_ (the prompts/sources they were born from), then run the flagship mission. No live codegen risk.

## 2. Doc-Grounded Facts We Rely On

From `app-server.md` (verified by fetch, not assumed):

- JSON-RPC 2.0 over **stdio** (newline-delimited JSON); `initialize` → `initialized` handshake required first.
- **Threads are persistent**: `thread/start`, `thread/resume`, `thread/read`, `thread/list`. History survives process restarts. → Generator memory persists across propose/approve/generate turns on one thread.
- `turn/start` streams `item/started` / deltas / `item/completed` notifications. Item types include `agentMessage`, `commandExecution`, `fileChange`, `mcpToolCall`, `reasoning`, `plan`. → This is the dashboard timeline. No hooks hack needed.
- MCP is first-class: `mcpServerStatus/list` (servers + tools + auth status), `mcpServer/tool/call`. → "Connected adapters" panel.
- Sandbox per turn: `readOnly`, `workspaceWrite` (with `writableRoots`), `dangerFullAccess`. Server sends `item/*/requestApproval` requests; client responds `accept`/`decline`.
- `turn/interrupt` cancels a turn (dashboard Stop button).

From `codex-sdk.md`: `@openai/codex-sdk` exposes `thread.run()` only; docs explicitly do not cover tool registration or event streaming. → **Decision: use the app-server, not the SDK.** It's the documented surface for rich clients (powers the VS Code extension) and removes the "does `thread.run` load MCP config?" unknown.

From `hooks.md` / `local-environment.md`: hooks exist (`PostToolUse` etc.) but have no dashboard-emission API; local environments are a ChatGPT-desktop-only feature. Neither is needed — noted here so nobody re-explores them.

**Assumption to verify in M0 (only one):** exact `config.toml` `mcp_servers` entry shape and that app-server exposes those servers' tools to turns. The app-server doc confirms MCP support; the precise config syntax comes from the Codex CLI docs/`codex --help` during the spike.

## 3. Architecture

```
┌─ Dashboard (Next.js, :3000) ───────────────────────────────┐
│ mission input · live timeline · adapters panel · artifacts │
│ generator wizard (intent + source files → approve toolkit) │
└──────────────┬─────────────────────────────────────────────┘
               │ REST + WS (our own clean schema — FE never sees JSON-RPC)
┌──────────────▼─ Backend (Node/TS Fastify, :4000) ──────────┐
│ codex-client: spawns `codex app-server` (stdio child),     │
│   handshake, id-correlation, notification dispatch,        │
│   auto-answers approval requests (policy below)            │
│ translate.ts: app-server items → dashboard events          │
│ missions: thread per mission, state in data/missions/      │
│ generator: propose→approve→generate, thread per adapter    │
│ registry: writes config.toml mcp_servers, smoke-tests      │
│ artifacts: serves data/artifacts/ statically               │
└──────┬──────────────────────────────┬──────────────────────┘
       │ child process (stdio JSON-RPC)
┌──────▼──────────────┐   MCP (spawned by Codex per config.toml)
│ codex app-server    │──► adapters/minecraft-mcp (Node + Mineflayer ──► local MC server)
│ threads: mission,   │──► adapters/blender-mcp   (stdio shim ──► socket :9876 ──► Blender addon/bpy)
│ generator-<name>    │──► adapters/<generated>-mcp …
└─────────────────────┘
```

**Decisions (settled during planning):**
| Decision | Choice | Why |
|---|---|---|
| Codex integration | **app-server via backend** (single client) | Documented rich-client surface; native streaming, MCP status, approvals; threads persist |
| Generator engine | **Codex authors the code** (not a template engine) | The differentiator vs `@plugin-creator`; grounded by user-supplied local docs |
| Generator memory | propose + generate = **turns on one persistent thread** | `thread/resume` keeps full context between approval steps |
| Live timeline | native `item/*` events → translate → WS | No hook hack |
| Adapter packaging | `config.toml` `mcp_servers` only | Enough for demo; `plugin.json`/marketplace = stretch |
| Approvals | backend auto-accepts within allowed roots, logs each as a timeline event | Turns never stall on a prompt during the demo |
| Storage | JSON files under `data/` | Hackathon; no DB |

## 4. Repo Layout

```
codex-shi/
├── apps/dashboard/            # Next.js (Track B)
│   ├── app/                   # pages: mission, generator wizard
│   ├── components/            # Timeline, AdapterPanel, ArtifactGrid, ToolkitApproval
│   └── lib/api.ts             # typed client for backend REST/WS
├── backend/                   # Fastify (Track A)
│   └── src/
│       ├── server.ts          # REST + WS endpoints
│       ├── codex/client.ts    # app-server spawn + JSON-RPC + approvals
│       ├── codex/translate.ts # item/* → DashEvent (ONLY place raw items are touched)
│       ├── missions.ts        # mission lifecycle, thread ids
│       ├── generator.ts       # propose/approve/generate flow
│       ├── registry.ts        # config.toml writes + adapter smoke test
│       └── artifacts.ts
├── adapter-contract/          # THE framework contract (Track C first, everyone reads)
│   ├── CONTRACT.md            # conventions: naming, tools, artifacts, env, smoke
│   └── template/              # skeleton MCP server (Node) Codex imitates
├── adapters/
│   ├── minecraft-mcp/         # Node + @modelcontextprotocol/sdk + mineflayer
│   └── blender-mcp/           # shim.py (stdio MCP) + addon/ (socket server + bpy)
├── data/                      # gitignored: missions/ artifacts/ sources/ generated/
├── scripts/                   # start.sh, start-minecraft.sh, install-blender-addon.sh, spike/
└── package.json               # npm run dev = concurrently(dashboard, backend)
```

## 5. Contracts (freeze these in M1 — everything builds against them)

### 5a. Dashboard WS events (`translate.ts` output)

```ts
type DashEvent =
  | {
      type: "mission.status";
      missionId: string;
      status: "running" | "done" | "failed" | "stopped";
    }
  | {
      type: "step";
      itemType:
        | "message"
        | "command"
        | "toolCall"
        | "fileChange"
        | "reasoning"
        | "plan";
      status: "started" | "completed" | "failed";
      summary: string;
      adapter?: string;
      ts: number;
    }
  | { type: "artifact.created"; artifact: Artifact }
  | {
      type: "adapters.updated";
      adapters: {
        id: string;
        status: "connected" | "error";
        tools: string[];
      }[];
    }
  | {
      type: "generator.status";
      name: string;
      phase:
        | "proposing"
        | "awaiting-approval"
        | "generating"
        | "registering"
        | "smoke-testing"
        | "ready"
        | "failed";
    };
```

### 5b. Backend REST

```
GET  /health                         GET  /adapters
POST /missions {goal}                GET  /missions/current
POST /missions/current/stop          GET  /artifacts        GET /artifacts/:file
POST /generator {name, intent}                  # + source files (multipart) → data/sources/<name>/
GET  /generator/:name                            # proposal + phase
POST /generator/:name/approve {toolkit}          # user-edited toolkit → generate phase
WS   /events
```

### 5c. Adapter contract (`adapter-contract/CONTRACT.md`)

- An adapter = **stdio MCP server** in `adapters/<app>-mcp/`, registered in `config.toml`.
- Env passed via config: `ARTIFACTS_DIR` (+ app-specific like `MC_HOST`). Artifacts are **files written to `ARTIFACTS_DIR`**; tool results include the path. Cross-app handoff = one adapter writes a file, the next reads it.
- Required tools: one `observe_*` (cheap state description) + action tools + at least one `capture_*` (artifact producer). Tool descriptions must say when to use them — they're the agent's UX.
- Must pass smoke test: spawn → MCP `initialize` → `tools/list` returns ≥1 tool.
- `README.md` states capabilities + how to run the target app.

### 5d. Generator flow (backend `generator.ts`)

```
1. POST /generator → thread/start (generator-<name>), turn A, sandbox readOnly:
   prompt = CONTRACT.md + template + file list of data/sources/<name>/ + user intent
   instruction: end with fenced JSON toolkit proposal {tools:[{name,description,inputSchema,notes}]}
2. Backend parses proposal → dashboard ToolkitApproval UI (editable) → user approves
3. turn B on the SAME thread (context retained), sandbox workspaceWrite,
   writableRoots [adapters/]: "implement the approved toolkit per the contract"
   (fileChange items stream to the timeline — visible codegen)
4. registry.ts: append config.toml entry → restart app-server child → resume threads
5. smoke test → adapters.updated → it's live in the dashboard
```

### 5e. Demo adapter toolkits

- **minecraft-mcp:** `observe_world, navigate_to, place_block, mine_block, build_structure, capture_structure` (blocks→JSON), stretch `capture_screenshot` (prismarine-viewer headless).
- **blender-mcp:** `inspect_scene, clear_scene, import_structure` (the JSON above), `set_material, add_camera_and_light, render_scene` (PNG artifact), `export_glb`. Addon executes `bpy` on Blender's main thread via `bpy.app.timers`; shim relays stdio MCP ↔ socket `localhost:9876`.

## 6. Work Tracks (self-assign; contracts in §5 are the interfaces between you)

| Track                                       | Owns                             | Delivers                                                                                                                              |
| ------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Backend/Runtime**                     | `backend/`                       | app-server client, translate, missions, generator flow, registry, artifacts                                                           |
| **B — Frontend**                            | `apps/dashboard/`                | mission view, timeline, adapters panel, artifact grid, generator wizard. Build against §5a/5b from day 0 (mock WS feed until A lands) |
| **C — Adapters**                            | `adapter-contract/`, `adapters/` | CONTRACT.md + template FIRST (unblocks A's generator + B's panels), then minecraft-mcp, then blender-mcp                              |
| **D — Generator prompts** (can pair with A) | prompts in `generator.ts`        | propose/generate prompts, iterate on quality, pre-generate demo adapters via the real pipeline                                        |

## 7. Milestones

**M0 — Spike (first hours, Track A; blocks everything):**
`scripts/spike/`: spawn `codex app-server`, handshake, `thread/start` + `turn/start "list files"`, print every notification. Then add a 20-line dummy MCP server to `config.toml`, confirm it appears in `mcpServerStatus/list` and a turn can call its tool; note exact config syntax + approval behavior under `workspaceWrite`.
_Verify: raw item stream printed; dummy tool called by a turn._

**M1 — Contracts + skeleton:** repo layout, §5 types in a shared `packages/shared` (or duplicated file), CONTRACT.md + template, dashboard renders mock events.
_Verify: `npm run dev` boots both; dashboard shows fake timeline._

**M2 — Vertical slice (one adapter):** minecraft-mcp registered; mission "build a 3×3 stone platform" runs from the dashboard with live timeline + `capture_structure` artifact.
_Verify: artifact JSON in `data/artifacts/`, visible in dashboard._

**M3 — Flagship mission:** blender-mcp done; mission "Build a small wooden cabin in Minecraft, capture its structure, recreate it in Blender, render it, export GLB" end-to-end.
_Verify: render PNG + .glb in artifact grid._

**M4 — Generator:** full propose→approve→generate→register→smoke loop on a small target (good first candidate: an "applescript-mcp" or "browser-mcp" with sources = Playwright docs saved locally). Re-generate demo adapters through the real pipeline so the demo claim is honest.
_Verify: generated adapter passes smoke + one tool call from a mission._

**M5 — Demo polish:** status pills, generation-input showcase panel, `scripts/start.sh`, rehearse.

## 8. Demo Script

1. Open dashboard: runtime/Minecraft/Blender/Codex all green.
2. Show generator wizard filled with the _actual inputs_ that produced minecraft-mcp & blender-mcp ("these adapters were born from this prompt + these docs").
3. Run flagship mission; narrate the live timeline as Codex hops apps.
4. Artifact grid: structure JSON → Blender render → GLB (open it).
5. Close on the contract: "any app is one generated adapter away."

## 9. Cut List (explicitly out)

Auth/users/DB · cloud anything · mission history UI · resumability UX (threads persist; we just don't build UI) · plugin.json/marketplace packaging (stretch) · Minecraft screenshots (stretch) · arbitrary mission robustness — the flagship mission is the product of rehearsal, not generality.

## 10. Risks

| Risk                                               | Mitigation                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| app-server protocol drift (some APIs experimental) | M0 spike against installed CLI version; pin it; all raw-protocol code isolated in `codex/client.ts` + `translate.ts` |
| Approval stalls mid-demo                           | auto-accept policy in client.ts, logged as timeline events                                                           |
| Blender threading (`bpy` off main thread crashes)  | addon runs commands via `bpy.app.timers`; shim stays dumb                                                            |
| Generated adapter quality                          | grounded by CONTRACT.md + template + user sources; smoke gate; demo adapters pre-generated + hand-verified           |
| Codex auth/rate limits on demo box                 | `codex` CLI logged in beforehand; rehearse on the demo account                                                       |

## Verification (overall)

- Each milestone has its own verify line above.
- End-to-end: `npm run dev` + `scripts/start-minecraft.sh` + Blender open with addon → run flagship mission from a clean `data/` → all three artifacts appear and the GLB opens.
- Generator: `POST /generator` with intent "control the macOS `say` command" + a saved man page → approve → generated adapter passes smoke → mission "say hello" works.
