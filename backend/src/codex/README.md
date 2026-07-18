# codex — app-server client and transport layer

Everything that talks to `codex app-server` lives here. Consumers (HTTP routes,
CLIs, the generator) import from this directory and never touch raw protocol.

## Layout

| File | Role |
| --- | --- |
| `transport.ts` | Spawns the app-server child, speaks newline-delimited JSON-RPC over stdio. |
| `contract.ts` | The stable surface consumers read: event envelopes + re-exported protocol types. |
| `approvals.ts` | Auto-answers mid-turn approval requests. Pluggable policy. |
| `translate.ts` | Raw `ServerNotification` → contract event bodies. Additive, lossless. |
| `client.ts` | `AppServerClient` — threads, streaming turns, interrupt, models, MCP. |
| `render.ts` | Projects an event to a readable terminal line (CLI view). |
| `ui-stream.ts` | Projects an event to Vercel AI SDK UI-message-stream chunks (web view). |
| `protocol/` | **Generated.** Not tracked in git — see below. |

Dependency order is `transport`/`approvals` → `contract` → `translate`/`render`/`ui-stream` → `client`.

## Generated protocol bindings

`protocol/` is produced by the codex CLI and is gitignored. After cloning, run:

```
npm run gen:protocol     # codex app-server generate-ts --out backend/src/codex/protocol
```

This requires the global `codex` binary on PATH (developed against `codex-cli 0.144.5`).
Until it is run, `contract.ts` will not typecheck — every protocol import there is
type-only, so the failure is compile-time, not runtime.

## Design notes

**Nothing is summarized away.** Each event is a small routable envelope wrapping the
*untouched* payload (`item: ThreadItem`, or `params` on a `raw` event). `translate.ts`
spreads the original through and only *adds* a human `title`. Anything we don't model
explicitly still arrives as a lossless `raw` event, so a new app-server field is never
silently dropped — it just isn't interpreted yet.

**Types come from the generated bindings**, so `item: ThreadItem` is provably the exact
app-server shape and is checked by the compiler rather than hand-maintained.

**The wire is JSON-RPC-shaped but not JSON-RPC** — there is no `jsonrpc` field, and
framing is one JSON object per line in both directions.

**Approval response fields are not uniform.** Verified against codex-rs:

| Request | Response shape |
| --- | --- |
| command / file-change approval | `{ decision: "accept" }` |
| MCP tool-call elicitation | `{ action: "accept", content: {} }` |
| permissions request | `{ permissions, scope }` |
| legacy v1 apply-patch / exec | `{ decision: "approved" }` |

**`render.ts` and `ui-stream.ts` are siblings**, not layers — same event union, two
target surfaces. Add a new event kind to both or neither.

## Scope

This directory is only the app-server client. The HTTP server, per-thread runtime
routing, and CLI entrypoints that consume it live in `backend/src/` alongside it.
