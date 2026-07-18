// registry.ts — make a generated/hand-written adapter live in Codex.
//
//   smokeTest()       standalone: spawn the server, run the MCP handshake, assert ≥1 tool
//                     (the acceptance bar from adapter-contract/CONTRACT.md).
//   registerAdapter() write the config.toml entry via `codex mcp add`, then hot-reload.
//   verifyRegistered() confirm Codex now sees the server with tools.
//
// Uses only the frozen CodexClient seam (reloadMcpConfig / listMcpServers) plus the
// `codex` CLI — no direct TOML parsing, no app-server restart.

import { spawn } from "node:child_process";
import readline from "node:readline";
import type { CodexClient, McpServerStatus } from "./codex/contract";

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

// ── smoke test ───────────────────────────────────────────────────────────────
export interface SmokeResult {
  ok: boolean;
  tools: string[];
  serverInfo?: { name?: string; version?: string };
  error?: string;
}

// Spawn `node <serverPath>` and run initialize -> tools/list. Passes if ≥1 tool.
export function smokeTest(opts: {
  serverPath: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<SmokeResult> {
  const { serverPath, env = {}, timeoutMs = 8000 } = opts;
  return new Promise((resolve) => {
    const child = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let settled = false;
    let stderr = "";
    let serverInfo: SmokeResult["serverInfo"];

    const finish = (r: SmokeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, tools: [], error: `smoke timed out after ${timeoutMs}ms${stderr ? ` — stderr: ${stderr.slice(-400)}` : ""}` }),
      timeoutMs,
    );

    child.stderr.on("data", (d) => (stderr += String(d)));
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // ignore non-JSON chatter on stdout
      }
      if (msg.id === 0 && msg.result) {
        serverInfo = msg.result.serverInfo;
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
      } else if (msg.id === 1 && msg.result) {
        const tools: string[] = (msg.result.tools ?? []).map((t: any) => t.name);
        finish({ ok: tools.length > 0, tools, serverInfo, error: tools.length ? undefined : "tools/list returned 0 tools" });
      }
    });
    child.on("error", (e) => finish({ ok: false, tools: [], error: `spawn failed: ${e.message}` }));
    child.on("exit", (code) => finish({ ok: false, tools: [], error: `server exited before tools/list (code ${code})${stderr ? ` — stderr: ${stderr.slice(-400)}` : ""}` }));

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  });
}

// ── registration ─────────────────────────────────────────────────────────────
function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// `codex mcp add <name> --env ARTIFACTS_DIR=… [--env …] -- node <serverPath>`, then hot-reload.
// Idempotent: removes any prior entry of the same name first.
export async function registerAdapter(opts: {
  name: string; // registered name / config key, e.g. "applescript-mcp"
  serverPath: string; // absolute path to server.mjs
  artifactsDir: string; // absolute ARTIFACTS_DIR
  env?: Record<string, string>; // extra app-specific env
  client: CodexClient;
}): Promise<void> {
  const { name, serverPath, artifactsDir, env = {}, client } = opts;
  await run(CODEX_BIN, ["mcp", "remove", name]); // ignore result — may not exist yet
  const envArgs = Object.entries({ ARTIFACTS_DIR: artifactsDir, ...env }).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  const res = await run(CODEX_BIN, ["mcp", "add", name, ...envArgs, "--", "node", serverPath]);
  if (res.code !== 0) {
    throw new Error(`\`codex mcp add ${name}\` failed (code ${res.code}): ${(res.stderr || res.stdout).trim()}`);
  }
  await client.reloadMcpConfig(); // hot-reload; no app-server restart
}

// Confirm the app-server now lists <name> with ≥1 tool. Polls, because a hot-reload
// returns before the newly-spawned MCP server has finished initialize + tools/list.
export async function verifyRegistered(
  client: CodexClient,
  name: string,
  opts: { retries?: number; delayMs?: number } = {},
): Promise<McpServerStatus> {
  const { retries = 12, delayMs = 500 } = opts;
  let last = "not seen";
  for (let i = 0; i < retries; i++) {
    const servers = await client.listMcpServers();
    const found = servers.find((s) => s.name === name);
    if (found) {
      const tools = Object.keys(found.tools ?? {});
      if (tools.length > 0) return found;
      last = `"${name}" present but 0 tools (still initializing?)`;
    } else {
      last = `"${name}" not listed (have: ${servers.map((s) => s.name).join(", ") || "none"})`;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`verifyRegistered failed after ${retries} tries: ${last}`);
}

// Unregister (cleanup / re-generation).
export async function unregisterAdapter(name: string, client?: CodexClient): Promise<void> {
  await run(CODEX_BIN, ["mcp", "remove", name]);
  if (client) await client.reloadMcpConfig();
}
