# M0 Spike Findings (codex-cli 0.144.5)

Verified against the real app-server + generated JSON schema (`codex app-server generate-json-schema`),
not the docs. Where they differ, trust this file.

**Source of truth = the official README:** `codex-rs/app-server/README.md`
(raw: https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md).
It confirmed every finding below. Regenerate per Codex version — don't hand-write protocol knowledge.

## README cross-check (all CONFIRMED) + new actionable bits
- ✅ No `jsonrpc` field on wire · ✅ thread id at `result.thread.id` · ✅ no `turn/failed` (use
  `turn/completed.turn.status`) · ✅ `config/mcpServer/reload` hot-reloads config without restart.
- ✅ Two SEPARATE approval channels, different response shapes:
  - shell/file: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
    `item/permissions/requestApproval` → respond `{decision: "accept"|"acceptForSession"|"decline"|"cancel"|…}`
  - MCP tool calls: `mcpServer/elicitation/request` (modes `form`|`openai/form`|`url`;
    `_meta.codex_approval_kind:"mcp_tool_call"`) → respond `{action:"accept", content:{}}`
- ⭐ **Our spike filled a README GAP:** the README does NOT state whether `approvalPolicy:"never"` suppresses
  MCP-tool elicitations. We PROVED empirically it does NOT — the elicitation fires regardless. So
  `codex/client.ts` must always answer `mcpServer/elicitation/request`, whatever the approval policy.
- 🔧 **Types:** `codex app-server generate-ts --out <dir>` (add `--experimental` for experimental surface).
  Track A: generate into `backend/src/codex/protocol/` and build `client.ts` on those — no hand-written types.
- 🔧 **Cut the event noise** (answers "why so much stuff"): `initialize.capabilities.optOutNotificationMethods`
  = exact method names to suppress at the source. Also `experimentalApi:true` to unlock experimental methods.
- 🔧 **Generator codegen viz is real:** `item/fileChange/patchUpdated` deltas stream as Codex writes files →
  "watch the adapter being written" demo confirmed.
- ⚠️ WebSocket transport is explicitly experimental/unsupported → we use **stdio** (default). `thread/rollback`
  is deprecated. Backpressure returns JSON-RPC `-32001` "Server overloaded; retry later."
- Only reference client named: the Codex VS Code extension (`clientInfo.name:"codex_vscode"`). **No reusable
  UI ships** — our dashboard is a from-scratch client, same category as that extension.
- Full raw README saved: `scratchpad/app-server-readme.md`.

## Proven working (unauthenticated)
- `codex app-server` on stdio, newline-delimited JSON-RPC, **no `jsonrpc` field** on the wire.
- Handshake: `initialize {clientInfo:{name,title,version}}` → result; then `{method:"initialized"}` notification.
- MCP registration: `codex mcp add <name> -- <command> [args…]` writes to `~/.codex/config.toml`:
  ```toml
  [mcp_servers.dummy]
  command = "node"
  args = ["/abs/path/dummy-mcp.mjs"]
  ```
  `--env KEY=VALUE` supported (→ how adapters get `ARTIFACTS_DIR`).
- `mcpServerStatus/list {}` → `result.data[]`: `{name, serverInfo, tools:{<toolName>:{name,description,inputSchema}}, authStatus}`.
- The app-server **spawns registered MCP servers itself** when a turn starts; emits
  `mcpServer/startupStatus/updated {name, status:"starting"|"ready", error}`.
- `thread/start {cwd, approvalPolicy, sandbox}` → thread id at **`result.thread.id`** (not `result.threadId`).
  Session persisted under `~/.codex/sessions/…/rollout-…jsonl`. Works without auth.
- `turn/start {threadId, input:[{type:"text",text}]}` → `result.turn.id`; then notifications:
  `thread/started`, `thread/status/changed`, `turn/started`, `item/started`, `item/completed`,
  `error {error:{message, codexErrorInfo, additionalDetails}, willRetry}`, `turn/completed {turn:{status}}`.
  A failed turn ends with `turn/completed` where `turn.status === "failed"` + `turn.error` (no separate `turn/failed`).
- Enums: `approvalPolicy: "untrusted"|"on-request"|"never"`; thread `sandbox: "read-only"|"workspace-write"|"danger-full-access"`.
- `config/mcpServer/reload` exists → registry can hot-reload MCP config **without restarting the app-server**.
- `codex app-server generate-ts --out <dir>` generates TypeScript protocol bindings — use this for Track A types.

## VERIFIED end-to-end (authenticated, 2026-07-17)
- Full loop works: model reasons → calls `dummy.ping` → gets `pong: hello from spike` → final `agentMessage`
  with that text → `turn/completed status:"completed"`. Run: `node scripts/spike/appserver-spike.js`.
- NOTE: spike files are `.js` (repo is `"type":"module"`), not `.mjs`.

## MCP tool-call approval — IMPORTANT GOTCHA
- **Every MCP tool call is gated by an elicitation, even with `approvalPolicy:"never"`.** The exec/command
  approval policy does NOT cover MCP tools — they use a separate elicitation channel.
- The gate arrives as a **server→client request** `mcpServer/elicitation/request`:
  ```json
  { "method":"mcpServer/elicitation/request", "id":0, "params":{
      "serverName":"dummy", "mode":"form", "message":"Allow the dummy MCP server to run tool \"ping\"?",
      "requestedSchema":{"type":"object","properties":{}},
      "_meta":{"codex_approval_kind":"mcp_tool_call","persist":["session","always"],
               "tool_params":{"message":"hello from spike"}} } }
  ```
- **Respond with `{action:"accept"}`** (NOT `{decision:...}`). Enum: `accept|decline|cancel`; optional `content`.
  Wrong shape ⇒ tool fails with `"user rejected MCP tool call"`.
- The other families use `{decision:"accept"}`: `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`, plus `item/tool/requestUserInput`
  (the generator's toolkit-approval hook). Full server-request list is in the generated schema.
- → **Backend `codex/client.ts` must auto-answer `mcpServer/elicitation/request` with `{action:"accept"}`**
  for the demo (log each as a timeline step). `_meta.tool_params` gives the args to show in the UI.

## Also observed
- User's existing Codex apps show up too: an MCP server `codex_apps` (plugin-runtime) exposed Figma tools
  alongside our `dummy`. `mcpServerStatus/list` returns ALL configured servers → adapters panel should filter
  to ours (by name prefix) or show all.

## Notes
- Unauthenticated turns retry 5× (WebSocket transport), fall back to HTTPS, retry 5× more, then fail. Backend
  should surface `error.willRetry` to the timeline rather than treating first error as fatal.
- Default model reported by `thread/start`: check `result.model` (spike showed the account default; can override per turn).
