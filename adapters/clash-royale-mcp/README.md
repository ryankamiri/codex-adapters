# clash-royale-mcp

MCP adapter for controlling Clash Royale through macOS iPhone Mirroring.

This adapter does not talk to Clash Royale internals. It observes the mirrored iPhone
window, captures screenshots, and sends macOS mouse/keyboard events into iPhone
Mirroring. An agent can then decide what to do from screenshots.

## Capabilities

- `strategy` — returns the Clash Royale playbook (reading the screen, elixir management,
  defending, counter-pushing, placement, phase-by-phase advice). The agent should call
  this once at match start so it plays deliberately.
- `observe_phone` — read-only window state for iPhone Mirroring (bounds, phone rectangle,
  preset targets) plus a short reading guide. Does not show game state.
- `capture_phone_screen` — writes a PNG screenshot artifact so the agent can see the board
  (elixir bar, hand, tower HP, enemy troops).
- `deploy_card` — **one-shot deploy**: selects a hand slot (1-4) and places it at a
  normalized x/y. Prefer this over `tap`-then-`tap` (fewer round trips, faster, more
  reliable).
- `tap` — taps normalized coordinates inside the phone rectangle.
- `swipe` — drags/swipes between normalized coordinates (e.g. drag-deploy a card).
- `tap_preset` — taps named targets: menu buttons (`ok`, `play_again`), card slots, and
  deploy points (`defend_left/right`, `bridge_left/right`, `behind_king_left/right`, …).
- `wait` — pauses (≤5s) to bank elixir or watch a play develop.
- `press_key` — sends simple keyboard keys after activating iPhone Mirroring.

## Performance

Mouse events are driven by `mouse.swift`. It is **compiled once** to a native binary
(`swiftc -O`) cached under `MOUSE_BIN_DIR` and reused for every tap/swipe — interpreting
the source per action cost seconds each; the compiled binary is ~0.2s. The binary is
built at server startup and recompiled only when `mouse.swift` changes. If `swiftc` is
unavailable, it falls back to interpreting the source.

Window geometry is cached (`PHONE_WINDOW_TTL_MS`, default 1500ms) and app activation is
throttled (`PHONE_ACTIVATE_TTL_MS`, default 2500ms), so a tap is one fast subprocess
instead of three slow `osascript`/compile round trips.

Requires Xcode command-line tools (`swiftc`) for the fast path: `xcode-select --install`.

## How to run the target app

1. Open Apple's **iPhone Mirroring** app on macOS.
2. Unlock/connect the iPhone if prompted.
3. Open Clash Royale on the mirrored iPhone.
4. Make sure the process is visible to macOS Accessibility as `iPhone Mirroring`.

The adapter needs:

- Screen Recording permission for the process running Codex/Node, so screenshots work.
- Accessibility permission for the process running Codex/Node, so taps and swipes work.

If taps do nothing, open macOS **System Settings → Privacy & Security → Accessibility**
and grant permission to the terminal/Codex host app. If screenshots are blank or
blocked, grant Screen Recording permission as well.

## Environment

- `ARTIFACTS_DIR` — absolute directory where screenshots are written. Defaults to the
  adapter working directory.
- `IPHONE_MIRRORING_APP` — macOS app/process name. Defaults to `iPhone Mirroring`.
- `PHONE_INSET_LEFT`, `PHONE_INSET_TOP`, `PHONE_INSET_RIGHT`, `PHONE_INSET_BOTTOM` —
  optional point insets applied to the iPhone Mirroring window before interpreting
  normalized coordinates. Defaults to `0` for all sides.
- `MOUSE_BIN_DIR` — where the compiled mouse binary is cached. Default
  `/private/tmp/clash-royale-mcp-bin`.
- `PHONE_WINDOW_TTL_MS` — how long cached window geometry is reused (default `1500`).
- `PHONE_ACTIVATE_TTL_MS` — minimum gap between iPhone Mirroring activations (default `2500`).

## Coordinate model

`tap` and `swipe` use normalized coordinates:

- `x = 0` is the left edge of the phone rectangle.
- `x = 1` is the right edge.
- `y = 0` is the top edge.
- `y = 1` is the bottom edge.

Call `capture_phone_screen` before actions and adjust coordinates from what is visible.
Preset targets are approximate because Clash Royale screens and iPhone Mirroring window
chrome can vary.
