# messages-mcp

A dependency-free stdio MCP server for sending messages through the signed-in
macOS Messages app. It uses `/usr/bin/osascript` and exposes constrained tools
instead of arbitrary AppleScript execution.

## Capabilities

- `observe_messages` — reads configured services and recent chat metadata.
- `find_chats` — searches chats by name, participant, handle, or stable ID.
- `search_contacts` — searches macOS Contacts by name.
- `send_message` — sends exact text to an exact phone number or Apple ID/email.
- `send_to_chat` — sends exact text to a confirmed existing chat or group-chat ID.
- `capture_chats` — writes service and chat metadata to
  `messages-chats.json`; message bodies are not captured.

`send_message` sends immediately. The calling agent should confirm the exact
recipient and message with the user before invoking it.
`send_to_chat` also sends immediately. The calling agent should confirm the exact
chat (and participants when ambiguous) and exact message before invoking it.

## Run the target app

Sign in to Messages and confirm that sending works normally. Then run:

```sh
node adapters/messages-mcp/server.mjs
```

On first use, macOS may ask whether the host process (often Terminal or Codex)
may control Messages. Allow it under **System Settings → Privacy & Security →
Automation**. Full Disk Access is not required because this adapter does not read
the Messages database.

`search_contacts` may separately prompt for access under **System Settings →
Privacy & Security → Contacts**.

## Codex configuration

Add this server to `~/.codex/config.toml` (adjust the path if the repository moves):

```toml
[mcp_servers.messages-mcp]
command = "node"
args = ["/Users/aadibiyani/Desktop/codex-shi/adapters/messages-mcp/server.mjs"]
```

Restart Codex after changing the configuration.

## Environment

- `ARTIFACTS_DIR` — directory for `capture_chats`; defaults to the server's current
  working directory and is created on first capture.
