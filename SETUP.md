# Setup

Get Relay running locally and drive your first app in a couple of minutes.

## Prerequisites

- **macOS** (adapters drive native apps).
- **Node.js 20+**.
- **Codex CLI** already installed and signed in — the backend spawns `codex app-server`.
  Verify with:
  ```bash
  codex --version
  ```

## 1. Install

```bash
git clone https://github.com/ryankamiri/codex-adapters
cd codex-adapters
npm install
```

## 2. Start the backend (from the repo root)

```bash
npm run dev:backend
```

Fastify + `codex app-server` come up on **http://localhost:4000**.

## 3. Start the frontend (new terminal)

```bash
cd frontend
npm install      # first time only
npm run dev
```

The workspace UI is at **http://localhost:3000**.

## 4. Build an adapter — just ask

Open the workspace and prompt the agent in plain English, e.g.:

> make a spotify mcp using applescript and register it

The agent reads the adapter contract, writes `adapters/spotify-mcp/server.mjs`,
smoke-tests it, and registers it in your `~/.codex/config.toml`. A generated adapter
that fails its smoke test is **not** registered.

Then hit **Reload MCP** in the UI (or `curl -XPOST localhost:4000/api/mcp/reload`),
give it a moment to finish handshaking, and try it out:

> play my Discover Weekly on Spotify

## macOS permissions

Driving real apps means the OS gets a say. Grant these once as adapters need them:

| Need | Where |
| --- | --- |
| Any AppleScript adapter (e.g. Spotify) | System Settings → Privacy → **Automation** |
| `chrome-mcp` | Chrome → View → Developer → **Allow JavaScript from Apple Events** |
| Reading `chat.db` | System Settings → Privacy → **Full Disk Access** |
| Synthetic clicks | System Settings → Privacy → **Accessibility** |

## Troubleshooting

If the agent claims it "can't" do something, it almost certainly has no tool loaded.
Check what's registered:

```bash
curl -s localhost:4000/api/mcp/servers | jq '.servers[] | {name, tools: (.tools|length)}'
```

A server showing `0` tools is connected but useless — it either failed to start or
hasn't finished handshaking. See the main [README](README.md) for deeper debugging.
