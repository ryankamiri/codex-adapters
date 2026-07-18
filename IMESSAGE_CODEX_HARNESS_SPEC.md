# iMessage-to-Codex Harness Specification

## 1. Summary

The iMessage-to-Codex harness turns one explicitly authorized phone number into a
remote command interface for the local Codex runtime.

When the authorized number sends a plain-text iMessage to this Mac:

1. A local Messages listener detects and durably records the inbound message.
2. The harness verifies the sender, chat, service, and message type.
3. The inbound message text is submitted to Codex unchanged as the user prompt.
4. Codex runs the task and may call explicitly approved MCP adapters.
5. The harness waits until the Codex turn completes or fails.
6. The harness sends the final Codex response back to the same iMessage chat through
   `messages-mcp`.

Example:

> Please use the OBS adapter to record, use the submit adapter to submit the
> recording, then tell me when the recording is done and submitted.

Codex receives that exact text, calls the permitted OBS and submit adapter tools,
waits for those operations to finish, and produces a final response. The harness then
texts that final response to the originating chat.

This is a local POC hosted entirely on this Mac. It is not a public webhook and does
not require a cloud control plane.

## 2. Goals

- Listen for new plain-text iMessages from one configured phone number.
- Pass the exact inbound text to Codex as the user prompt without rewriting it.
- Permit Codex to call an explicit allowlist of registered MCP adapters.
- Wait for the complete Codex turn, including long-running adapter actions.
- Send the final agent response back to the exact originating chat.
- Process each inbound message no more than once under normal operation.
- Survive process restarts without replaying historical messages.
- Serialize tasks per chat so multiple texts cannot create overlapping Codex turns.
- Provide a kill switch, bounded execution time, redacted logs, and an audit trail.

## 3. Non-goals for the POC

- Group-chat commands.
- Commands from more than one authorized sender.
- Attachment, image, audio, reaction, edit, or unsend handling.
- Public HTTP ingress or cloud deployment.
- Arbitrary SMS/RCS fallback; the initial route must be an iMessage conversation.
- Exactly-once network delivery guarantees from Messages.app.
- A general multi-user authentication or tenancy system.
- Allowing Codex to choose a reply recipient.

## 4. System architecture

```text
Authorized iPhone
    |
    | iMessage
    v
Messages.app on this Mac
    |
    | read-only polling of ~/Library/Messages/chat.db
    v
iMessage listener
    |
    | normalized, allowlisted inbound event
    v
Durable task ledger (SQLite)
    |
    | exact inbound text
    v
Codex task worker
    |
    | approved MCP tool calls
    +----> OBS adapter
    +----> submit adapter
    +----> other allowlisted adapters
    |
    | final agent message / sanitized failure
    v
Reply outbox
    |
    | messages-mcp.send_to_chat(originalChatId, result)
    v
Messages.app -> Authorized iPhone
```

The listener is a webhook substitute: Messages does not expose an inbound webhook,
so the harness creates a local event stream by observing new database rows.

## 5. Trust and authorization model

The authorized phone number is effectively a remote operator credential. A message
from that number may cause local applications to be controlled and external side
effects to occur.

The harness MUST enforce all of the following before starting a Codex turn:

- `enabled` is true.
- The message is incoming (`is_from_me = false`).
- The service is iMessage for the POC.
- The normalized sender exactly matches `allowedSender`.
- The message belongs to a one-to-one chat.
- The chat's participant set contains only the authorized sender.
- The message has a non-empty plain-text body.
- The message GUID has not already been processed.
- The message was received after the harness's initialization watermark.

Phone numbers must be normalized to E.164 before comparison. The raw sender string
must not be accepted using substring, suffix, contact-name, or fuzzy matching.

## 6. Prompt fidelity

The incoming message body MUST be passed to Codex unchanged as the user input. The
harness must not summarize, correct, expand, or interpolate it.

Trusted harness instructions may be supplied separately as developer/runtime policy,
for example:

- Treat the iMessage body as the operator's task.
- Use only permitted adapters.
- Do not send iMessages yourself.
- Complete the task before returning the final response.
- In the final response, state what completed and what failed.

The trusted policy must not be concatenated into or represented as part of the user's
exact prompt.

## 7. Codex execution model

### 7.1 Runtime

The worker reuses `backend/src/codex/client.ts` and starts one long-lived
`AppServerClient`. It creates a dedicated Codex thread for the authorized iMessage
chat and persists the logical chat-to-thread association when practical.

For the first version, the worker may create a fresh Codex thread per inbound command.
This provides stronger task isolation and avoids depending on in-memory conversation
history. Persistent conversational context can be added later.

### 7.2 Tool access

Inbound iMessage tasks are intentionally agentic. Codex may call MCP tools, but tool
access MUST be controlled by a configuration allowlist such as:

```json
{
  "allowedMcpServers": [
    "obs-mcp",
    "submit-mcp",
    "applescript-mcp",
    "messages-mcp"
  ]
}
```

The approval policy MUST:

- Auto-approve MCP calls only when the server is allowlisted.
- Permit `messages-mcp` only when it is explicitly allowlisted and the task came
  from a trusted sender. Unknown-sender conversation workers cannot enable it.
- Keep final-response delivery to the originating chat in trusted harness code,
  independent of any model-initiated `messages-mcp` calls.
- Deny unknown MCP servers.
- Deny shell-command and file-change approvals by default.
- Allow additional command/file capabilities only through explicit configuration.
- Record every approval decision with task ID, server, tool, and outcome.

The current general-purpose `autoAcceptPolicy()` is not acceptable for this worker
because it accepts MCP, command, and file-change requests broadly.

### 7.3 Completion

The worker consumes the turn's event stream until `turn.done` resolves. It collects
completed `agentMessage` items and uses the final non-empty agent message as the reply.

A task is complete only after:

- The Codex turn reports `completed`, and
- All tool calls in that turn have reached terminal results.

If the turn fails, times out, is interrupted, or produces no final agent text, the
harness creates a deterministic, sanitized failure response rather than asking Codex
to improvise another one.

Example failure response:

> I couldn't complete that task. The OBS adapter timed out before the recording was
> confirmed. Task ID: msg_01J...

## 8. Message ingestion

### 8.1 Source

The listener reads the current macOS user's Messages database in read-only mode:

```text
~/Library/Messages/chat.db
```

The database schema is private and macOS-version-dependent. Database access must be
isolated behind a `MessagesStore` interface and tested against the macOS version used
by this POC.

### 8.2 Cursor and startup behavior

- Maintain both a monotonically increasing database cursor and message GUID.
- On first startup, set the cursor to the current maximum row.
- Never reply to messages that existed before initialization.
- Advance the scanned cursor even when messages are filtered out.
- Add a unique constraint on inbound message GUID.
- Read against the live SQLite WAL safely and use a busy timeout.

### 8.3 Normalized event

```ts
interface InboundMessage {
  guid: string;
  cursor: number;
  chatId: string;
  sender: string;
  service: "iMessage";
  text: string;
  receivedAt: string;
  isFromMe: false;
  isGroup: false;
}
```

## 9. Queuing and concurrency

- A single chat may have only one running Codex turn.
- New messages received while a turn is running are persisted and queued in order.
- The POC treats each message as a separate command; it does not merge prompts.
- A configurable debounce window may delay dispatch briefly, but it must not alter the
  prompt text.
- A global concurrency limit defaults to one because multiple adapters may control the
  same desktop applications.
- Each task has a maximum runtime. The default should be generous enough for recording
  and submission workflows, for example 30 minutes.

Optional immediate acknowledgement is disabled by default. If enabled, it must be a
fixed harness message such as `Received; task msg_01J... is running.` and must not be
confused with the final result.

## 10. Reply delivery

The model never chooses the reply recipient. Trusted harness code calls:

```text
messages-mcp.send_to_chat({
  chat_id: inbound.chatId,
  message: finalReply
})
```

Using the original chat ID ensures the response returns to the exact originating
conversation and avoids creating a new conversation through service auto-selection.

The reply must be bounded by `maxReplyCharacters`. Longer final responses should be
truncated with an explicit suffix or split into a small configured maximum number of
messages.

## 11. Delivery and idempotency state

Suggested task states:

```text
observed
  -> queued
  -> running
  -> generated
  -> reply_prepared
  -> sending
  -> sent

terminal alternatives:
  filtered | failed | timed_out | interrupted | send_uncertain
```

Use a durable outbox with a unique key on `(inbound_guid, reply_kind)`.

Messages AppleScript does not provide an idempotency key or authoritative delivery
receipt. If the process crashes or times out after requesting a send but before
persisting `sent`, mark the reply `send_uncertain`. Do not retry it automatically;
automatic retry could produce duplicate texts.

## 12. Configuration

Example local configuration:

```json
{
  "enabled": false,
  "allowedSender": "+15551234567",
  "service": "iMessage",
  "allowedMcpServers": ["obs-mcp", "submit-mcp"],
  "allowShell": false,
  "allowFileChanges": false,
  "pollIntervalMs": 1000,
  "debounceMs": 1500,
  "maxTaskRuntimeMs": 1800000,
  "maxReplyCharacters": 1500,
  "maxQueuedTasks": 20,
  "sendAcknowledgement": false,
  "mode": "dry-run"
}
```

Configuration files containing phone numbers should be mode `0600` and must not be
committed. The default mode is `dry-run`; `auto-send` requires an explicit change.

## 13. Persistence

Use a local SQLite database under the ignored `data/` directory with, at minimum:

- `listener_state`: current database cursor and initialization timestamp.
- `inbound_messages`: normalized metadata, processing status, and sender hash.
- `tasks`: Codex thread/turn IDs, timestamps, outcome, and error category.
- `tool_calls`: adapter server/tool, approval decision, start/end time, and result.
- `reply_outbox`: response hash, send state, attempts, and timestamps.

Message bodies and full final responses may be stored for the POC only when explicitly
enabled. Default logs should contain GUIDs, task IDs, hashes, timestamps, and the last
four digits of the sender rather than full message content.

## 14. Process lifecycle and macOS permissions

The POC runs as the logged-in macOS user because it must access that user's
Messages.app session.

Required setup:

- Messages.app signed into the intended Apple Account and receiving identity.
- Full Disk Access for the stable worker process so it can read `chat.db`.
- Automation permission for the stable worker/Node host to control Messages.app.
- Automation permissions required by other desktop adapters such as OBS.
- Sleep disabled while the worker is enabled.

During development, run the worker manually from a terminal with the required
permissions. After validation, install it as a per-user LaunchAgent with automatic
restart. It must not run as a root LaunchDaemon.

## 15. Proposed repository layout

```text
backend/src/imessage-harness/
├── config.ts
├── messages-store.ts
├── listener.ts
├── ledger.ts
├── approval-policy.ts
├── codex-worker.ts
├── reply-delivery.ts
├── service.ts
└── types.ts

backend/test/imessage-harness/
├── fixtures/
├── messages-store.test.ts
├── listener.test.ts
├── approval-policy.test.ts
├── worker.test.ts
└── delivery.test.ts

scripts/
├── imessage-harness-smoke.mjs
└── com.codex-adapters.imessage-harness.plist.example
```

Add package scripts similar to:

```json
{
  "imessage:dry-run": "tsx backend/src/imessage-harness/service.ts --mode dry-run",
  "imessage:start": "tsx backend/src/imessage-harness/service.ts --mode auto-send",
  "imessage:smoke": "node scripts/imessage-harness-smoke.mjs"
}
```

## 16. Acceptance criteria

### Authorized happy path

1. The authorized phone sends a plain-text command.
2. Exactly one task is recorded.
3. Codex receives byte-for-byte equivalent user text.
4. Codex can call an allowlisted adapter.
5. The worker waits for the turn and adapter operations to finish.
6. Exactly one final response is requested through `send_to_chat` for the original
   chat ID.

### Authorization

- A message from any other sender is recorded as filtered and never reaches Codex.
- A group message never reaches Codex.
- An outbound/self-authored message never reaches Codex.

### Tool policy

- Allowlisted MCP adapter calls can proceed unattended.
- Non-allowlisted MCP calls are denied and audited.
- Model-initiated `messages-mcp` calls require both explicit allowlisting and the
  trusted-sender worker capability; they are always denied for unknown senders.
- Shell and file changes are denied unless explicitly enabled.

### Reliability

- Restarting the worker does not replay completed messages.
- Duplicate database observations produce one task.
- Two inbound commands execute sequentially.
- A timeout produces one sanitized failure reply.
- An ambiguous send is marked `send_uncertain` and is not automatically retried.

### Dry-run safety

- In `dry-run`, the full receive, filter, Codex, and reply-preparation path executes,
  but the harness's final `messages-mcp.send_to_chat` is replaced with an audit
  record. Explicit model-initiated side-effect tools remain governed by their
  own allowlist and are not made safe by reply dry-run mode.

## 17. Rollout plan

1. Grant Full Disk Access and confirm the listener can read schema and new messages.
2. Implement listener, normalization, cursoring, and SQLite deduplication.
3. Run listener-only against the authorized sender without invoking Codex.
4. Add Codex execution with every tool denied and inspect final responses.
5. Enable one harmless adapter and validate scoped approval behavior.
6. Add deterministic reply delivery but remain in dry-run mode.
7. Send replies to a test chat under manual observation.
8. Test restart, duplicate, timeout, denied-tool, and prompt-injection scenarios.
9. Enable the intended OBS/submit adapters.
10. Install the per-user LaunchAgent and enable `auto-send`.

## 18. Open configuration required before implementation

- The one authorized sender phone number in E.164 format.
- The receiving iMessage identity used on this Mac.
- The initial allowed MCP server names.
- Whether shell commands or file changes are ever permitted.
- Maximum task runtime.
- Whether to send an immediate acknowledgement.
- Maximum final reply length.
- The first real end-to-end command and expected completion response.
