# &lt;app&gt;-mcp

MCP adapter that lets a Codex agent observe and drive **&lt;app&gt;**.

> Template. Copy this directory to `adapters/<app>-mcp/`, rename, and fill in the
> real tools. See [`../CONTRACT.md`](../CONTRACT.md).

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `observe_state` | observe | Read-only snapshot of current app state. Call first. |
| `perform_action` | action | *(TODO)* Changes the app. |
| `capture_snapshot` | capture | Writes an artifact under `ARTIFACTS_DIR`, returns its path. |

## Environment

| Var | Default | Purpose |
|---|---|---|
| `ARTIFACTS_DIR` | `cwd` | Where `capture_*` tools write artifacts. |
| *(app-specific)* | — | e.g. `MC_HOST`, `MC_PORT` — document each here. |

## Run the target app

*(TODO)* Describe exactly what must be running before this adapter is useful —
e.g. "start a local server with `scripts/start-<app>.sh`", or "open <app> and enable
the addon". The agent's tools do nothing until the app is live.

## Smoke test

```bash
npm run smoke        # sends initialize + tools/list; expect ≥1 tool in the output
```
