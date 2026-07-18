// Snapshotter: the AGENT'S POV. Primary path: prismarine-viewer renders the
// bot's world first-person into a hidden headless Chromium page (Playwright) —
// so artifacts show what the BOT sees, even while you play Minecraft yourself
// on the visible screen. Fallback: macOS `screencapture` of the main display
// if the viewer isn't available (e.g. it can't render this MC version).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const sanitize = (s) => String(s).replace(/[^a-z0-9-_]+/gi, "_").slice(0, 40) || "snapshot";

let browser = null;
let page = null;

export async function initSnapshotter(viewerPort) {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({
    // Force software WebGL so it renders reliably in headless Chromium on any Mac.
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.goto(`http://127.0.0.1:${viewerPort}`, { waitUntil: "load", timeout: 30_000 });
  await page.waitForTimeout(3000); // let the initial chunks stream + render
}

/**
 * Screenshot the agent's view. Saves a PNG artifact AND returns the image as
 * base64 so it can be handed to the model as vision.
 */
export async function takeSnapshot(artifactsDir, label = "progress") {
  await fs.mkdir(artifactsDir, { recursive: true });
  const file = path.join(artifactsDir, `minecraft-${sanitize(label)}-${Date.now()}.png`);

  if (page) {
    try {
      await page.waitForTimeout(1000); // let recent block changes stream + render
      const buf = await page.screenshot(); // PNG buffer
      await fs.writeFile(file, buf);
      return { type: "image", path: file, label, createdBy: "minecraft", source: "agent-pov", base64: buf.toString("base64") };
    } catch (e) {
      console.error("[minecraft-mcp] viewer screenshot failed, falling back to screencapture:", e?.message ?? e);
    }
  }

  // Fallback: whole-screen capture of the main display (whatever is visible).
  await run("screencapture", ["-x", file]);
  await run("sips", ["-Z", "1280", file]).catch(() => {}); // keep the vision payload small
  const buf = await fs.readFile(file);
  return { type: "image", path: file, label, createdBy: "minecraft", source: "screen", base64: buf.toString("base64") };
}

export async function closeSnapshotter() {
  await browser?.close().catch(() => {});
  browser = null;
  page = null;
}
