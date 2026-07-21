# spotify-mcp

A dependency-free, newline-delimited stdio MCP server that controls Spotify for
macOS through AppleScript.

## Capabilities

- `play_song` — plays a Spotify URI/URL, or starts playback from a search query.
- `skip_song` — skips to the next track.
- `set_volume` — sets Spotify's volume from `0` to `100`.
- `adjust_volume` — raises or lowers Spotify's volume by a relative amount.
- `observe_playback` — reads playback state, current track metadata, position, and volume.
- `get_status` — compatibility alias for `observe_playback`.
- `capture_status` — writes the current playback status to `spotify-status.json` under `ARTIFACTS_DIR`.

## Run

Open Spotify at least once on the Mac, then run:

```sh
node adapters/spotify-mcp/server.mjs
```

macOS may ask for Automation permission. Grant that permission to the process
hosting Codex, or to Terminal when running the adapter directly.

To register with Codex from the repository root:

```sh
codex mcp add spotify-mcp --env ARTIFACTS_DIR="$PWD/data/artifacts" -- node "$PWD/adapters/spotify-mcp/server.mjs"
```

## Environment

- `ARTIFACTS_DIR` — directory for `capture_status` output. Defaults to the adapter process working directory.
- `SPOTIFY_APP` — optional application name to target. Defaults to `Spotify`.

The adapter uses the macOS-provided `/usr/bin/osascript` command line tool and has
no npm dependencies.
