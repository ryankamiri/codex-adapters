# Codex Bodies — Terminal Harness: Setup & Test Guide

This harness drives a **`codex app-server`** child process over JSON-RPC and lets you
talk to the agent from your terminal. You type a prompt on stdin; it runs a Codex turn
and streams the events back. By default you see a clean, human-readable view; the full
protocol shape is always preserved underneath (`--json` / `--journal`).

It also auto-answers Codex's mid-turn approval requests (MCP tool calls, file writes,
shell commands) so nothing stalls — this is the main thing to verify works on your machine.

---

## Prerequisites

- **Node 18+** — `node -v`
- **Codex CLI installed globally and logged in:**
  ```bash
  codex --version        # expect: codex-cli 0.144.5  (match this if you can)
  codex login status     # expect: Logged in using ChatGPT
  ```
  Running a turn needs auth. The no-turn smoke test (`--list`) does not.

> ⚠️ We pin **codex-cli 0.144.5**. The generated protocol types (step 2) are produced
> from *your* binary, so a very different codex version can cause typecheck drift. If
> `npm run typecheck` fails right after generating, check your codex version first.

---

## 1. Get the code

```bash
git clone https://github.com/kilehsu/codex-shi
cd codex-shi
git fetch origin
git checkout codex-client       # the harness lives here until it's merged to main
```

## 2. Install, generate types, register the test server

```bash
npm install
npm run gen:protocol            # generates backend/src/codex/protocol/ (gitignored) from YOUR codex binary
mkdir -p data/artifacts
codex mcp add generic --env ARTIFACTS_DIR="$PWD/data/artifacts" -- node "$PWD/backend/test/generic-mcp.mjs"
```

Verify setup:
```bash
codex mcp list                  # should show a `generic` row (enabled)
npm run typecheck               # should print nothing and exit 0
```

---

## 3. Run the tests (cheapest first)

Run everything from the repo root. The `< /dev/null` makes a one-shot run exit after the
turn; omit it to stay in the interactive REPL (see test 6).

### Test 1 — Smoke test (no model tokens)
```bash
npx tsx backend/src/cli.ts --list < /dev/null
```
**✅ Pass** if you see:
- `● codex app-server ready (macos)` — spawn + handshake OK
- `⚙ mcp generic: ready` — our server was launched
- (on stderr) `• generic [unsupported] — echo, add, write_note, fail` — tools discovered
- `● app-server closed` and it exits on its own

### Test 2 — MCP tool-call approval (the primary health check)
```bash
npx tsx backend/src/cli.ts --sandbox read-only \
  "Call the generic.echo tool with the message 'hello from the harness', then reply with exactly what it returned and nothing else." \
  < /dev/null
```
**✅ Pass** — you should see this sequence:
```
◆ turn started
  ⚠ auto-approved request — mcp elicitation from "generic" (tool)   ← approval handler fired
  ⇄ generic.echo({"message":"hello from the harness"}) → ok         ← tool ran
▸ pong: hello from the harness                                       ← agent relayed result
✔ turn completed
```
**❌ Fail** if you see `✖ turn failed`, the text `user rejected MCP tool call`, or no `⚠ auto-approved` line.

### Test 3 — File + command approval (the other response shape)
```bash
rm -f data/artifacts/hello.txt
npx tsx backend/src/cli.ts --sandbox workspace-write --approval untrusted \
  "Create a file at data/artifacts/hello.txt containing exactly the text 'hi from codex'. Then stop." \
  < /dev/null
cat data/artifacts/hello.txt          # expect: hi from codex
```
**✅ Pass** — look for `⚠ auto-approved requestApproval — file change …`, a `✎ 1 file(s) [completed]: …/hello.txt` line, and the file containing `hi from codex`. (Often a `⚠ … command:` + `$ … (exit 0)` line appears too.)

### Test 4 — Full-shape fidelity (`--json` + `jq`)
```bash
npx tsx backend/src/cli.ts --json \
  "Call generic.echo with message 'shape check' and reply with what it returned." \
  < /dev/null 2>/dev/null \
  | jq -c 'select(.kind=="item" and .itemType=="mcpToolCall") | .item'
```
**✅ Pass** — you get a JSON object with every field (`server, tool, status, arguments, result, error, durationMs, …`). Every stdout line being valid JSON also proves the stream is cleanly parseable.

### Test 5 — Lossless raw journal
```bash
npx tsx backend/src/cli.ts --journal data/j.txt \
  "Call generic.echo with message 'journal test' and reply with what it returned." \
  < /dev/null
grep '^>>' data/j.txt | grep '"action"'     # our exact auto-accept reply
```
**✅ Pass** — prints `{"id":0,"result":{"action":"accept","content":{}}}`. `data/j.txt` holds every raw JSON-RPC message (`<<` inbound, `>>` outbound) for replay/debug.

### Test 6 — Interactive REPL
```bash
npx tsx backend/src/cli.ts --sandbox read-only
```
Type a prompt after `»` (e.g. `Call generic.add with a=2 b=40 and tell me the sum.`), press enter, watch the stream, then the prompt returns.
- **Ctrl-C** during a turn interrupts it; when idle, exits.
- `/quit` or `/exit` exits cleanly.

**One-line health check:** if you only run one test, run **Test 2**. A green run there means spawn, handshake, thread, turn, MCP tool call, approval handling, item translation, and rendering are all working.

---

## Reading the output — three channels

| Channel | Carries | Notes |
|---|---|---|
| **stdout** | events: human lines (default) or NDJSON (`--json`) | the thing you verify; safe to pipe to `jq`/a file |
| **stderr** | app-server logs, the `»` prompt, the connected-servers list | context; kept off stdout so pipes stay clean |
| **`--journal <file>`** | raw JSON-RPC, `<<` in / `>>` out | lossless replay + protocol debugging |

**Glyph legend (human view):** `●` session · `◆`/`✔`/`✖` turn started/ok/failed · `▸` agent message · `·` reasoning (dim) · `⇄` MCP tool call · `✎` file change · `$` command · `⚠` auto-approved approval · `⚙` MCP server startup.

## Flags

| Flag | Meaning |
|---|---|
| *(none)* | human-readable output (default) |
| `--json` | full-shape `AgentEvent` as NDJSON on stdout |
| `--journal <file>` | append raw JSON-RPC to a file |
| `--deltas` | include token-level streaming deltas |
| `--sandbox <mode>` | `read-only` \| `workspace-write` \| `danger-full-access` (default `workspace-write`) |
| `--approval <policy>` | `untrusted` \| `on-request` \| `never` (default `on-request`) |
| `--list` | print connected MCP servers/tools and exit |
| `[prompt…]` | run this prompt first, then drop into the REPL |

---

## Troubleshooting

- **`--list` hangs or "client not started":** `codex` isn't on your PATH, or `codex app-server` isn't available (need 0.144.x). Check `which codex`.
- **Turn fails with an auth/rate error:** run `codex login status`; the harness surfaces transient errors as `… (retrying)` and only fails hard on a real error.
- **`user rejected MCP tool call`:** an approval-response shape mismatch — shouldn't happen on 0.144.5; report your codex version.
- **Typecheck errors right after `gen:protocol`:** your codex version differs enough that the protocol shape drifted. Align to 0.144.5.
- **`generic` missing from `--list`:** re-run the `codex mcp add generic …` step from setup.

## Cleanup

```bash
rm -f data/artifacts/hello.txt data/j.txt   # test artifacts (data/ is gitignored)
codex mcp remove generic                     # only if you want to unregister the test server
```
