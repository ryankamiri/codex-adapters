# Local iMessage-to-Codex harness

This service watches this Mac's Messages database for new one-to-one plain-text
iMessages and has two routes:

- Numbers in `allowedSenders` submit their text to Codex unchanged and may use
  only the configured MCP servers.
- Other E.164 numbers submit up to the last five plain-text messages in that
  chat from the preceding five minutes to a separate reply-only Codex worker.
  Each message becomes a visible UI thread whose prompt asks for a concise,
  funny, personality-forward Gen-Z response without forcing slang or emojis.
  That worker has no MCP, shell, or file access.

Both routes send the final response to the originating chat through the trusted
`messages-mcp` delivery layer. The model cannot select or redirect the recipient.

Read [the full specification](../../../IMESSAGE_CODEX_HARNESS_SPEC.md) before
enabling automatic sends.

## 1. Create private configuration

```sh
cp config/imessage-harness.example.json config/imessage-harness.json
chmod 600 config/imessage-harness.json
```

Edit `allowedSenders` to contain the trusted phone numbers in strict E.164 form.
Automatic sending is the operational default. Keep `enabled` false until setup
is complete; explicitly choose `dry-run` when you want a no-send validation.

Add only the MCP servers that the remote operator may use. `messages-mcp` may be
explicitly allowlisted for trusted-sender commands that need to contact another
recipient. It remains unavailable to unknown-sender conversation workers, and
the harness still owns delivery of the final response to the originating chat.
Allowlisting it grants trusted senders immediate external-message side effects.

## 2. Grant macOS permissions

The process identity that runs Node/tsx needs:

- Full Disk Access to read `~/Library/Messages/chat.db`.
- Automation access to control Messages.app.
- Any additional permissions required by allowlisted desktop adapters.

Messages.app must be signed in and able to send replies. Keep
the Mac awake and the user logged in.

## 3. Run the read-only preflight

```sh
npm run imessage:smoke
```

This checks private config permissions, access to `chat.db`, and the
`messages-mcp` handshake. It does not start Codex or send a message.

## Developer diagnostics

MCP adapter diagnostics are written to the backend process's `stderr`, never to
the task reply or frontend chat stream. The harness also emits structured
`[imessage-harness:mcp]` lines for server startup, approval decisions, and tool
call lifecycle events. Those structured lines intentionally omit arguments,
results, message bodies, recipients, and chat identifiers.

## 4. Establish the watermark

Set `enabled` to true while retaining `mode: "dry-run"`, then start:

```sh
npm run imessage:dry-run
```

On first startup the listener records the current newest Messages row and does
not process older messages. Send a new test message only after the harness logs
that it has started.

Dry-run executes the listener, allowlist, Codex turn, tool policy, durable
ledger, and reply preparation, but does not invoke Messages sending.

State is stored at `data/imessage-harness/state.sqlite` by default.

## 5. Enable replies

After reviewing dry-run behavior, stop the process, change the private config to
`"mode": "auto-send"`, and run:

```sh
npm run imessage:start
```

The CLI mode flag never enables a disabled configuration. `enabled` remains the
kill switch.

## LaunchAgent

Copy `scripts/com.codex-adapters.imessage-harness.plist.example` into
`~/Library/LaunchAgents/`, replace every placeholder with an absolute path, and
validate it with `plutil -lint` before loading it. Run it as the logged-in user,
not as a root LaunchDaemon.

## Known POC limitation

The listener currently accepts `message.text` only. Some macOS releases may
store visually plain text solely in the private `attributedBody` typedstream.
The listener fails closed for those rows to preserve exact prompt fidelity. The
first live smoke must confirm that new messages on this Mac populate `text`
before automatic sending is enabled.
