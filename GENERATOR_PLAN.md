# Adapter Contract + Generator Flow — Implementation Plan

## Context

Relay turns live desktop apps into environments Codex can drive, and its
wedge vs OpenAI's `@plugin-creator` is that **we generate and run the adapter code
itself** (the MCP server that drives a live app), not just package an existing one.
Two pieces make that real and don't exist yet:

1. **The adapter contract** (`adapter-contract/`) — the framework interface every
   adapter conforms to. It is the shared dependency for the whole project: the
   generator embeds it in its prompt, a teammate's hand-built `minecraft-mcp` must
   match it, and the dashboard (later) reads it. Per the parallel-work plan, this
   must be frozen first so the teammate is unblocked.
2. **The generator flow** (`backend/src/generator.ts` + `registry.ts`) — Codex
   *authors* a new adapter from prose + local docs, then we register and smoke-test
   it. This is the product differentiator.

PLAN.md §5d specs this flow through a **dashboard** (REST/WS + a ToolkitApproval UI)
that doesn't exist — we pivoted to the terminal harness. So this plan reframes §5d
to run propose→approve→generate through the **CLI**, building on the frozen
`CodexClient` seam (`backend/src/codex/`). Everything below is greenfield except the
seam, which already exposes exactly what we need.

Goal: generate a *local* MCP adapter for **any** app from a prose intent + local
docs. Proof target this pass: **`applescript-mcp`** (drives macOS apps, produces a
real screenshot artifact) — chosen so it does NOT collide with the teammate's
`minecraft-mcp`.

## What already exists (build on, don't rebuild)

- **`backend/src/codex/contract.ts`** — frozen `CodexClient`: `startThread({sandbox})`,
  `runTurn(threadId, input, {writableRoots, approvalPolicy})` → `TurnHandle
  {turnId, events, done}`, `listMcpServers()`, `reloadMcpConfig()`, `close()`, global
  `events`. The `item` event carries the untouched raw `item: ThreadItem` (full
  text) plus a truncated `title`.
- **`backend/src/codex/client.ts`** — `runTurn` already sends a per-turn
  `sandboxPolicy:{type:"workspaceWrite", writableRoots,…}` when `writableRoots` is
  passed. This is the exact lever turn B needs.
- **`backend/src/codex/render.ts`** — `renderHuman()`; reuse to stream codegen
  (`✎ fileChange` lines) live.
- **`backend/test/generic-mcp.mjs`** — the de-facto adapter template: hand-rolled
  newline-delimited JSON-RPC (no SDK), `ARTIFACTS_DIR` env, `initialize`/`tools/list`/
  `tools/call` + safe fallback, `ok()`/`errResult()` helpers. Lift its shape into the
  contract template.
- **`scripts/spike/FINDINGS.md`** — confirms `codex mcp add <name> --env K=V -- <cmd>`
  writes `[mcp_servers.<name>]` to `~/.codex/config.toml`, and `reloadMcpConfig()`
  hot-reloads without restarting the app-server. `mcpServerStatus/list` returns ALL
  servers → filter by name.

## Design decisions (confirmed)

- **Approval UX:** auto-approve A→B by default; `--review` pauses **in-process**
  (write proposal, wait on Enter, re-read edited `toolkit.json`, continue on the same
  live thread). No `thread/resume` needed → no seam change.
- **Registration:** `registry.ts` shells out to `codex mcp add` (remove-then-add for
  idempotency), then `client.reloadMcpConfig()`.
- **Proof target:** `applescript-mcp`.

## Files to create

### 1. `adapter-contract/CONTRACT.md`  (freeze first — unblocks the teammate)
The framework interface, expanded from PLAN.md §5c:
- **Layout/naming:** adapter dir `adapters/<app>-mcp/`; entry `server.mjs`; MCP
  `serverInfo.name = "<app>-mcp"`.
- **Transport:** stdio, newline-delimited JSON-RPC 2.0; must handle `initialize`,
  `tools/list`, `tools/call`, and a safe fallback that answers any other id'd request
  (never hang).
- **Env:** read `ARTIFACTS_DIR` (+ app-specific like `MC_HOST`); `mkdir -p` it.
- **Artifacts:** files written under `ARTIFACTS_DIR`; every tool result includes the
  artifact's absolute path. Cross-app handoff = one adapter writes a file, the next
  reads it.
- **Required tools (the triad):** ≥1 `observe_*` (cheap, read-only state), ≥1 action
  tool, ≥1 `capture_*` (writes an artifact). Descriptions must say *when to use each*
  — they are the agent's UX.
- **Robustness:** per-tool `inputSchema` (JSON Schema); failures return
  `{content:[…], isError:true}`, never crash.
- **Smoke test (the acceptance bar):** spawn → `initialize` → `tools/list` returns ≥1
  tool.
- **README.md:** capabilities + how to run the target app + env vars.

### 2. `adapter-contract/template/`  (skeleton Codex imitates)
- `server.mjs` — `generic-mcp.mjs` generalized: hand-rolled JSON-RPC, `ARTIFACTS_DIR`
  handling, `ok()`/`errResult()` helpers, and three stub tools with `TODO` markers
  (one per triad: `observe_*`, an action, `capture_*`).
- `README.md` — fill-in template.
- `package.json` — minimal (`"type":"module"`, name `<app>-mcp`, empty deps);
  built-in-only adapters need no `npm install`.

### 3. `backend/src/registry.ts`
- `registerAdapter({name, serverPath, artifactsDir, client})`: `codex mcp remove
  <name>` (ignore error) → `codex mcp add <name> --env ARTIFACTS_DIR=<abs> -- node
  <abs serverPath>` via `child_process` → `await client.reloadMcpConfig()`.
- `smokeTest({serverPath, env}) → {tools: string[]}`: spawn `node serverPath`
  standalone, send `initialize` + `tools/list` over stdio, assert ≥1 tool, kill.
  Deterministic and independent of Codex.
- `verifyRegistered(client, name)`: `listMcpServers()` filtered to `name`, assert
  present with `tools` non-empty (confirms Codex sees it post-reload).

### 4. `backend/src/generator.ts`
`generateAdapter({name, intent, sourcesDir, review, client}) → {toolkit, adapterDir}`:
1. `startThread({sandbox:"read-only"})`.
2. **Turn A (read-only):** `runTurn(threadId, promptA)`. `promptA` embeds
   `CONTRACT.md` + `template/server.mjs` + the **contents** of each file in
   `sourcesDir` (read in Node, bounded/truncated) + the user intent. Instruction:
   *end with a fenced ```json block* `{tools:[{name,description,inputSchema,notes}]}`.
3. Consume the `TurnHandle.events`; capture the final `agentMessage`'s **full text**
   from the raw `e.item` (NOT the truncated `title` — confirm the text field against
   `protocol/v2/` AgentMessage item). Extract the ```json fence → `JSON.parse` →
   toolkit. Write `data/generated/<name>/toolkit.json`.
4. If `review`: print the toolkit, prompt "edit
   data/generated/<name>/toolkit.json then press Enter…", wait on readline, re-read
   the file.
5. **Turn B (same thread):** `runTurn(threadId, promptB, {writableRoots:[<abs
   adapters/>]})`. `promptB` = the final toolkit JSON + "implement it at
   `adapters/<name>-mcp/` per the contract; create `server.mjs`, `README.md`,
   `package.json`". `fileChange` items stream live via `renderHuman`. Await `done`.

### 5. `backend/src/generator-cli.ts`  (terminal driver)
- `new <name> --intent "…" [--sources <dir>] [--review] [--json]`.
- Instantiate `AppServerClient`, `start()`, subscribe `events` → `renderHuman` so
  turn A reasoning and turn B codegen are visible.
- `generateAdapter(...)` → `registerAdapter(...)` → `smokeTest(...)` →
  `verifyRegistered(...)` → print `✔ <name>-mcp live (N tools)`.

### 6. `data/sources/applescript/`  (proof-target inputs, gitignored)
A short local primer: how to run AppleScript via `osascript -e`, and 3–4 snippets
(display notification, frontmost app, `screencapture`). This is the "user-supplied
local docs" that grounds the generator.

## Implementation order (staged, de-risked)

1. **CONTRACT.md + template/** — write, then hand to the teammate (freezes the shared
   interface; the one hard dependency from the parallel-work plan).
2. **registry.ts** — test immediately against the EXISTING `generic-mcp.mjs`
   (register → reload → smoke → `verifyRegistered`). Proves registry *before* the
   generator exists.
3. **Protocol spot-check** — the one real risk: confirm a per-turn `workspaceWrite`
   sandbox override lets turn B write under a `read-only` thread. Quick test with a
   throwaway one-file write turn. Fallback if it doesn't: start the thread as
   `workspace-write` and keep turn A read-only by prompt discipline.
4. **generator.ts + generator-cli.ts**.
5. **Generate applescript-mcp** — provide `data/sources/applescript/`, run the CLI
   with `--review`, produce `adapters/applescript-mcp/`.
6. **Register + smoke + mission run** — prove end-to-end through the existing harness.

## Verification (end-to-end)

- `npm run typecheck` → clean.
- **Registry (against generic):** register `generic` via `registry.ts`, reload,
  smoke → prints `echo, add, write_note, fail`; `verifyRegistered` passes.
- **Generator:** `npx tsx backend/src/generator-cli.ts new applescript --intent "Let
  an agent observe and control macOS apps via AppleScript and capture screenshots"
  --review`
  → watch turn A emit a fenced-JSON toolkit → edit `data/generated/applescript/
  toolkit.json` → Enter → watch turn B stream `✎` fileChange lines → `✔
  applescript-mcp live (N tools)`.
- **Files exist:** `adapters/applescript-mcp/server.mjs`, `README.md`, `package.json`.
- **Mission (proves the generated adapter):** `npx tsx backend/src/cli.ts "Use
  applescript-mcp to display a notification saying hi, then capture a screenshot."`
  → MCP tool-call approvals auto-fire, screenshot artifact lands in
  `data/artifacts/`.
- **Fidelity:** `--json` on the generator CLI shows every `item`/`approval` event
  with full raw payloads preserved.

## Notes / follow-ups

- `.gitignore` already covers `data/`. Decide whether generated `adapters/<name>-mcp/`
  is committed (it is real source; PLAN §4 treats `adapters/` as committed) — default:
  commit it.
- No `CodexClient` change required. If we later want a separate
  `generator approve <name>` command (file-based, cross-process), that would need
  `thread/resume` added to the seam — out of scope this pass.
- The generator generalizes to any app; `applescript-mcp` is only the proof. Next
  targets flow through the same path (never point it at `minecraft` — that's the
  teammate's hand-built exemplar).
