# Adapter Contract

The **framework interface** every Relay adapter conforms to. An adapter is a
small program that turns a live desktop app (Minecraft, Blender, a browser, macOS via
AppleScript, …) into a set of tools a Codex agent can call. This document is the
single source of truth: the **generator** embeds it when it authors a new adapter, and
hand-written adapters (e.g. `minecraft-mcp`) must satisfy it too.

If your adapter passes the [Smoke test](#smoke-test) and follows the
[Checklist](#checklist), it is contract-compliant.

---

## 1. What an adapter is

> An adapter = a **stdio MCP server** in `adapters/<app>-mcp/`, registered in Codex's
> `config.toml`, that exposes tools driving one live application. Codex spawns it as a
> child process and talks to it in MCP JSON-RPC.

You do **not** implement anything Codex-side. You implement one MCP server that speaks
the small protocol in §3 and exposes the tools in §5.

## 2. Directory & naming

```
adapters/<app>-mcp/
├── server.mjs      # entry point — Codex runs `node server.mjs`
├── package.json    # name "<app>-mcp", "type":"module"; deps only if the app needs them
└── README.md       # capabilities + how to run the target app (§8)
```

- Directory: `adapters/<app>-mcp/` (kebab-case app name, `-mcp` suffix).
- Entry: `server.mjs`.
- MCP identity: report `serverInfo.name = "<app>-mcp"` in the `initialize` response.
- Registered name in `config.toml` = `<app>-mcp` (so panels/registry can filter by the
  `-mcp` suffix; `mcpServerStatus/list` returns *all* servers).

## 3. Transport & required methods

- **Transport:** stdio, **newline-delimited JSON-RPC 2.0** (one JSON object per line).
  No SDK required — the [template](./template/server.mjs) is ~70 lines of built-ins.
- **Must handle** these request methods and reply with a matching `id`:
  | Method | Reply |
  |---|---|
  | `initialize` | `{ protocolVersion, capabilities:{tools:{}}, serverInfo:{name:"<app>-mcp",version} }` |
  | `tools/list` | `{ tools: [ …tool descriptors… ] }` |
  | `tools/call` | a **tool result** (see §6) for `params.name` with `params.arguments` |
  | anything else with an `id` | `{ result: {} }` — so the client never hangs |
- Never write non-JSON to **stdout** (stdout is the protocol channel). Logs → stderr.

## 4. Environment

Config passes env into the server. Every adapter reads:

- **`ARTIFACTS_DIR`** — absolute dir where `capture_*` tools write artifacts. `mkdir -p`
  it on first use; fall back to `process.cwd()` if unset.

Plus **app-specific** vars as needed, documented in the README, e.g. `MC_HOST`/`MC_PORT`
(Minecraft), `BLENDER_SOCKET` (Blender). Keep them optional with sane defaults.

## 5. Required tools — the triad

Every adapter MUST expose at least one of each:

1. **`observe_*`** — a cheap, **read-only** description of current app state
   (e.g. `observe_world`, `observe_frontmost`). Safe to call anytime; no side effects.
2. **action tool(s)** — verbs that change the app (`place_block`, `run_applescript`,
   `import_structure`). Name them for what they do.
3. **`capture_*`** — produces an **artifact**: writes a file under `ARTIFACTS_DIR` and
   returns its absolute path (`capture_structure`, `capture_screenshot`). Artifacts are
   how apps hand off to each other (one adapter writes a file, the next reads it).

**Descriptions are the agent's UX.** Each tool's `description` must say *what it does
and when to use it* — the agent picks tools from these strings alone.

## 6. Tool descriptors, results & errors

- Each tool descriptor: `{ name, description, inputSchema }` where `inputSchema` is a
  JSON Schema (`type:"object"`, `properties`, `required`).
- Success result: `{ content: [ { type:"text", text } ] }`. For `capture_*`, include the
  artifact path in the text.
- Failure: `{ content: [ { type:"text", text } ], isError: true }` — **return** an error
  result; do not throw/crash. A crashed adapter fails the whole turn.

## 7. Artifacts

- Artifacts are plain **files** under `ARTIFACTS_DIR` (JSON, PNG, GLB, txt…).
- The tool result text must include the artifact's absolute path so the agent (and the
  timeline) can reference it.
- Prefer stable, descriptive filenames; overwrite deterministically when re-run.

## 8. README

`adapters/<app>-mcp/README.md` must state:
- **Capabilities** — the tool list and what each does.
- **How to run the target app** — the exact command / setup the app needs to be live
  (e.g. start a local Minecraft server, open Blender with the addon) before the adapter
  is useful.
- **Environment** — every env var the server reads and its default.

## Smoke test

The acceptance bar. An adapter passes if, run standalone:

```
spawn `node server.mjs`  →  send `initialize`  →  send `tools/list`  →  ≥1 tool returned
```

`backend/src/registry.ts` (`smokeTest`) automates exactly this. A generated adapter is
only registered after it passes.

## Checklist

- [ ] `adapters/<app>-mcp/{server.mjs, package.json, README.md}` present.
- [ ] `initialize` reports `serverInfo.name = "<app>-mcp"`.
- [ ] `tools/list` returns ≥1 tool; every tool has `name`, `description`, `inputSchema`.
- [ ] At least one `observe_*`, one action, one `capture_*`.
- [ ] `capture_*` writes under `ARTIFACTS_DIR` and returns the path.
- [ ] Errors returned as `{ isError:true }` results, never thrown.
- [ ] stdout carries only JSON-RPC; logs go to stderr.
- [ ] README documents capabilities, how to run the app, and env vars.
- [ ] Passes the smoke test.

See [`template/`](./template/) for a compliant skeleton to copy.
