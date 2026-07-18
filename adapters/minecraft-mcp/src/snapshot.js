// Snapshotter: a screenshot of the actual Minecraft window as YOU see it, via
// macOS `screencapture`.
//
// This used to render the bot's own POV through prismarine-viewer into a hidden
// headless Chromium page (Playwright). That was dropped: the viewer's render is
// hard to read compared to the real game, and each browser cost ~430 MB
// resident — which the Codex app-server multiplied by every superseded adapter
// instance it left running. Capturing the real screen is cheaper AND shows what
// the human is actually looking at, which is what makes a demo legible.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const sanitize = (s) => String(s).replace(/[^a-z0-9-_]+/gi, "_").slice(0, 40) || "snapshot";

/**
 * Screenshot the screen. Saves a PNG artifact AND returns the image as base64
 * so it can be handed to the model as vision.
 */
export async function takeSnapshot(artifactsDir, label = "progress") {
  await fs.mkdir(artifactsDir, { recursive: true });
  const file = path.join(artifactsDir, `minecraft-${sanitize(label)}-${Date.now()}.png`);

  // -x suppresses the camera shutter sound so a burst of snapshots during a
  // fight isn't audible in the OBS recording.
  try {
    await run("screencapture", ["-x", file]);
  } catch (e) {
    // macOS gates screen capture behind a per-app TCC grant, and the failure
    // text ("could not create image from display") never says so. The grant
    // belongs to the app that LAUNCHED this process — the terminal running the
    // backend — not to node itself.
    const msg = String(e?.stderr || e?.message || e);
    if (/could not create image|not authorized|denied/i.test(msg)) {
      throw new Error(
        "screen capture is blocked by macOS privacy settings. Grant Screen Recording to the app " +
          "that launches the backend (System Settings → Privacy & Security → Screen Recording), then " +
          "restart it. Until then use obs-mcp's capture_screenshot, which goes through OBS and is already permitted.",
      );
    }
    throw e;
  }
  await run("sips", ["-Z", "1280", file]).catch(() => {}); // keep the vision payload small
  const buf = await fs.readFile(file);
  return { type: "image", path: file, label, createdBy: "minecraft", source: "screen", base64: buf.toString("base64") };
}
