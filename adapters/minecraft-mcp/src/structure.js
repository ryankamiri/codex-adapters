// Structure capture: export a region of the bot's world to a portable JSON
// artifact via prismarine-schematic. This is the cross-app handoff — the JSON
// is what the Blender adapter reads to recreate the build.

import schematicPkg from "prismarine-schematic";
import vec3Pkg from "vec3";
import fs from "node:fs/promises";
import path from "node:path";

const { Schematic } = schematicPkg;
const Vec3 = vec3Pkg.Vec3;

/**
 * Copy the blocks between two corners of `bot.world` into a JSON artifact.
 * The region must be loaded (the bot should be near it).
 */
export async function captureStructure(bot, from, to, artifactsDir, label = "structure") {
  const start = new Vec3(from.x, from.y, from.z);
  const end = new Vec3(to.x, to.y, to.z);
  // Schematic.copy(world, start, end, offset, version) — static async.
  const schematic = await Schematic.copy(bot.world, start, end, new Vec3(0, 0, 0), bot.version);
  const json = schematic.toJSON();

  await fs.mkdir(artifactsDir, { recursive: true });
  const file = path.join(artifactsDir, `minecraft-${label}-${Date.now()}.json`);
  await fs.writeFile(file, typeof json === "string" ? json : JSON.stringify(json));
  return { type: "structure", path: file, label, createdBy: "minecraft" };
}
