# obs-mcp

Codex Bodies adapter for **OBS Studio**. Switch scenes, roll recordings, and pull frames
back as artifacts — over [obs-websocket](https://github.com/obsproject/obs-websocket) v5
via [`obs-websocket-js`](https://github.com/obs-websocket-community-projects/obs-websocket-js).

## Capabilities

| Tool | What it does |
|---|---|
| `observe_obs` | Read-only: every scene name, which is live, recording status + duration + bytes, and the record directory. Call this first — it's how the agent learns the real scene names. |
| `switch_scene` | Sets the live (program) scene. Accepts a partial, case-insensitive name: `demo` resolves `demo screen capture`. Ambiguous or unknown names error with the full scene list. |
| `start_recording` | Starts recording to disk. |
| `stop_recording` | Stops recording, waits for OBS to finish writing the file, and returns the **absolute path** plus size. Also drops a PNG thumbnail in `ARTIFACTS_DIR`. |
| `capture_screenshot` | Saves a PNG of the live scene (or a named source) to `ARTIFACTS_DIR` and returns its path. This is the adapter's "eyes". |

## Running OBS

The adapter talks to OBS's WebSocket server, which is **off by default**:

1. Launch OBS Studio.
2. **Tools → WebSocket Server Settings**
3. Check **Enable WebSocket server**. Default port is **4455**.
4. If **Enable Authentication** is checked, click **Show Connect Info** and copy the
   password into `OBS_PASSWORD`. Leave `OBS_PASSWORD` unset if auth is off.

Scenes are whatever you've built in OBS — this adapter doesn't create them. Set up your
scenes (e.g. `minecraft`, `google`, `demo screen capture`) in the OBS UI first.

OBS does **not** need to be running for the adapter to start; it connects lazily on the
first tool call, so `tools/list` works regardless. Tools return a readable error when OBS
is unreachable.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `ARTIFACTS_DIR` | `process.cwd()` | Where `capture_screenshot` and recording thumbnails are written. |
| `OBS_URL` | `ws://127.0.0.1:4455` | obs-websocket endpoint. |
| `OBS_PASSWORD` | *(unset)* | Only needed if OBS has authentication enabled. |

## OBS settings this adapter expects

Two settings must be configured in OBS for recordings to play in the workspace panel.
Both can be set from the OBS UI (**Settings → Output → Recording**) or over the
websocket; this repo's OBS already has them applied.

| Setting | Required value | Why |
|---|---|---|
| Recording path | `<repo>/data/artifacts/recordings` | The backend only serves files under a small allowlist of safe roots (`ALLOWED_ROOTS` in `backend/src/server.ts`). `~/Movies` is deliberately **not** on it — recording into artifacts avoids widening the allowlist to a whole home directory. |
| Filename formatting | `%CCYY-%MM-%DD_%hh-%mm-%ss` | OBS's default contains a **space** (`2026-07-18 12-28-38.mov`). The workspace panel scrapes media paths out of tool output with a regex, and allowing spaces there makes matching greedy and ambiguous. The underscore keeps paths unambiguous. |

Recording format should be **mp4 or mov with h264** — `.mkv` is served but no browser
plays it.

## Notes / gotchas

- **Recordings play in the workspace panel** via `<video>`. The backend serves them with
  HTTP range support (206 + `Content-Range`), which browsers require for seeking —
  Safari refuses to play at all without it. `stop_recording` also saves a PNG thumbnail.
- **`GetSourceScreenshot` returns a full data URI**, not bare base64, despite what the
  protocol docs say — the `data:image/png;base64,` prefix is stripped before writing.
- **`obs-websocket-js` does not auto-reconnect.** The adapter re-dials lazily on each
  call. The one exception is close code `4011` (you hit "Kick" in the OBS UI), after
  which the protocol forbids reconnecting — restart the adapter.
- **Requires obs-websocket v5** (OBS 28+). The v4 protocol used entirely different
  request names and is not supported.
- Importing `obs-websocket-js` bare in Node resolves to the **msgpack** build; this
  adapter imports `obs-websocket-js/json` deliberately.
