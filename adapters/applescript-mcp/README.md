# applescript-mcp

A dependency-free, newline-delimited stdio MCP server that lets Codex observe and
control live macOS applications through AppleScript.

## Capabilities

- `observe_frontmost` — reads the frontmost application's name and front-window
  title without changing application state.
- `run_applescript` — executes a complete AppleScript program. Use it to activate
  applications, display notifications, inspect application state, or perform other
  AppleScript-supported actions.
- `capture_screenshot` — captures the current screen as a PNG under the artifacts
  directory and returns its absolute path.

## Run the target app

This adapter targets the macOS desktop rather than one specific application. Log in
to a graphical macOS session and open any application you want to automate. No app
plugin or companion process is required.

Run the adapter directly with:

```sh
node adapters/applescript-mcp/server.mjs
```

macOS may ask for Automation, Accessibility, or Screen Recording permission. Grant
those permissions to the process hosting Codex (or to Terminal when running the
adapter there). `observe_frontmost` and UI automation commonly require Automation
or Accessibility access; `capture_screenshot` requires Screen Recording access.

## Environment

- `ARTIFACTS_DIR` — directory where `capture_screenshot` writes PNG files. Defaults
  to the adapter process's current working directory. The directory is created on
  first capture.

The adapter uses the macOS-provided `/usr/bin/osascript` and `screencapture` command
line tools and has no npm dependencies.
