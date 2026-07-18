# imessage-listener-mcp

Management adapter for the local iMessage-to-Codex listener. It lets Codex
inspect, start, stop, and configure the service without arbitrary shell or file
access.

## Capabilities

- `observe_listener` — read listener status and trusted numbers.
- `start_listener` — enable and launch the managed listener with automatic
  replies by default; `dry_run: true` explicitly selects no-send testing.
- `stop_listener` — disable the kill switch and request a clean stop.
- `add_allowed_senders` — add trusted strict-E.164 phone numbers.
- `remove_allowed_senders` — remove trusted numbers while retaining at least one.
- `set_allowed_senders` — replace the complete trusted-number list.
- `capture_listener_state` — write a redacted JSON status artifact.

Changes to trusted numbers signal a running listener to reload so they apply
immediately without interrupting an active task.
The adapter never exposes message bodies, arbitrary config edits, arbitrary
process control, or arbitrary shell execution.

## Setup

Install repository dependencies and grant the listener host process Full Disk
Access plus Messages Automation permission. Keep
`config/imessage-harness.json` private (`chmod 600`). The adapter can create it
from the checked-in example when a number-management tool is called.

Register it with Codex:

```sh
codex mcp add imessage-listener-mcp \
  --env IMESSAGE_HARNESS_REPO=/absolute/path/to/codex-adapters \
  -- node /absolute/path/to/codex-adapters/adapters/imessage-listener-mcp/server.mjs
```

Then requests such as “add +15551234567 to the allowed iMessage senders and
start the listener” enable automatic replies. Say “start in dry-run mode” only
when you explicitly want tasks to execute without sending responses.

## Environment

- `IMESSAGE_HARNESS_REPO` — repository root; defaults relative to this adapter.
- `IMESSAGE_HARNESS_CONFIG` — private config path; defaults to
  `config/imessage-harness.json` under the repository.
- `IMESSAGE_HARNESS_CONTROL_DIR` — PID/log directory; defaults to
  `data/imessage-harness/control`.
- `ARTIFACTS_DIR` — directory for captured status snapshots.
