// All configuration comes from env vars (passed by `codex mcp add ... --env`).
// Defaults target a LOCAL, OFFLINE Minecraft 1.21.1 server.
import path from "node:path";

export const config = {
  host: process.env.MC_HOST ?? "127.0.0.1",
  port: Number(process.env.MC_PORT ?? 25565),
  version: process.env.MC_VERSION ?? "1.21.1",
  username: process.env.MC_USERNAME ?? "CodexBot",
  gameMode: process.env.MC_GAMEMODE ?? "survival", // survival = real, grounded play
  // If set (e.g. "peaceful"), the bot runs /difficulty on spawn (needs op).
  // Default: leave the server's difficulty alone — real survival includes mobs.
  difficulty: process.env.MC_DIFFICULTY ?? "",
  viewerPort: Number(process.env.VIEWER_PORT ?? 3007), // agent-POV render for snapshots
  // Where capture_* tools write artifacts. Per the adapter contract this is
  // passed in via ARTIFACTS_DIR; default keeps smoke runs self-contained.
  artifactsDir: process.env.ARTIFACTS_DIR ?? path.resolve(process.cwd(), "data/artifacts"),
};
