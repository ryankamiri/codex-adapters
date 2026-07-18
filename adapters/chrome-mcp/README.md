# chrome-mcp

MCP adapter for driving a Google Chrome tab via AppleScript + injected JavaScript.
Built to fill out web forms an agent can see but not reliably operate.

## Setup (required)

Chrome blocks scripted JS by default. Enable it once:

**Chrome → View → Developer → ✅ Allow JavaScript from Apple Events**

Without it every JS tool fails with `-2700`; the adapter detects this specific case
and returns the instruction rather than a generic error.

Register it:

```toml
[mcp_servers.chrome-mcp]
command = "node"
args = ["<repo>/adapters/chrome-mcp/server.mjs"]
```

## Tools

| Tool | Effect |
| --- | --- |
| `list_tabs` | Every open tab with window/tab index, URL, title. Read-only. |
| `inspect_form` | Every input/textarea/select with selector, label, type, required, value. Read-only. |
| `fill_field` | Set one field's value. |
| `click` | Click an element. **Refuses submit-like controls** unless `allowSubmit: true`. |
| `read_text` | Visible text of the page or one element. Read-only. |

Always call `inspect_form` first and use the selectors it returns. Guessed selectors
(`input[name="title"]`, `input[type="text"]`) are the main failure mode.

## Three things that will bite you

**1. `nth-of-type` is not a document-order index.** It counts among *siblings under one
parent*. A selector like `input:nth-of-type(12)` meaning "the 12th input on the page" is
wrong and will match the wrong element or nothing — it silently broke every checkbox on
the first real run. `sel()` therefore emits a full ancestor path and verifies it resolves
back to the element before returning it.

**2. Setting `.value` does not work on React forms.** React tracks value on the DOM node
and ignores direct assignment: the field looks filled and submits empty. `fill_field` uses
the prototype's native setter, then dispatches `input` and `change`, and reads the value
back as `valueNow` so a silent rejection is visible.

**3. `[name=...]` is not unique for radio groups.** Every option in a group shares one
name, so emitting it makes them all resolve to the first radio and silently select the
wrong option. `sel()` only uses `[name]` when it matches exactly one element.

## Safety

`click` refuses any element with `type=submit` or text matching
submit/save/confirm/send/post/publish/finish unless the caller passes
`allowSubmit: true`. Filling a form is reversible; submitting it is not, so the
irreversible half is opt-in and enforced in the adapter rather than left to prompting.
Refusals are logged at `warn` with `refused: true`.

## Debugging

Verbose logs go to stderr and a file — **never stdout**, which carries the JSON-RPC
framing (one stray byte there kills the transport).

```
tail -f $TMPDIR/codex-adapter-logs/chrome-mcp.log
```

Useful events: `runJs` (the full injected JS and Chrome's raw return),
`fill_field.result` (`matched: false` means React rejected the write),
`click.refused`, `runJs.chromeBlockingAppleEvents`, `runJs.tabNotFound`.

## Environment

- `CHROME_APP` — app name, default `Google Chrome`.
- `ADAPTER_DEBUG=0` — disable logging. `ADAPTER_LOG_DIR` — change log location.
