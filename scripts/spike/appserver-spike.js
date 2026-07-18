// M0 spike: prove the codex app-server integration end-to-end.
//   1. spawn `codex app-server` (stdio, newline-delimited JSON-RPC, no "jsonrpc" header per docs)
//   2. initialize -> initialized handshake
//   3. mcpServerStatus/list  (expect: dummy-mcp with its "ping" tool)
//   4. thread/start -> turn/start asking the model to call ping
//   5. print every message on the wire; exit on turn completion / error / timeout
// Shapes verified against `codex app-server generate-json-schema` output (v0.144.5).
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const codexBin = path.join(repoRoot, "node_modules", ".bin", "codex");

const child = spawn(codexBin, ["app-server"], {
  cwd: repoRoot,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[app-server stderr] ${d}`));

const send = (msg) => {
  console.log(`--> ${JSON.stringify(msg)}`);
  child.stdin.write(JSON.stringify(msg) + "\n");
};

let nextId = 0;
const pending = new Map(); // id -> resolve
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send(params === undefined ? { method, id } : { method, id, params });
  });

const die = (code, why) => {
  console.log(`\n=== exiting: ${why} ===`);
  child.kill();
  process.exit(code);
};
setTimeout(() => die(2, "timeout (120s)"), 120_000).unref();

const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log(`<-- [unparseable] ${line}`);
    return;
  }
  console.log(`<-- ${JSON.stringify(msg)}`);

  // response to one of our requests
  if (msg.id !== undefined && msg.method === undefined) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
    return;
  }
  // server-initiated request (approvals etc.) — auto-accept so nothing stalls
  if (msg.id !== undefined && msg.method !== undefined) {
    // Auto-accept, routed by request family (each has its own response shape):
    //   mcpServer/elicitation/request -> {action}  (this is how MCP tool calls are gated)
    //   item/*/requestApproval        -> {decision}
    const result =
      msg.method === "mcpServer/elicitation/request"
        ? { action: "accept", content: {} }
        : { decision: "accept" };
    console.log(`!!! server-initiated request: ${msg.method} — auto-accepting ${JSON.stringify(result)}`);
    send({ id: msg.id, result });
    return;
  }
  // notification
  if (msg.method === "turn/completed" || msg.method === "turn/failed") {
    die(0, msg.method);
  }
  if (msg.method === "error") {
    console.log("!!! turn-level error notification (see above)");
  }
});

child.on("exit", (code) => die(code ?? 1, `app-server exited (${code})`));

// ---- sequence ----
const init = await request("initialize", {
  clientInfo: { name: "codex_bodies_spike", title: "Codex Bodies Spike", version: "0.0.1" },
});
if (init.error) die(1, `initialize failed: ${JSON.stringify(init.error)}`);
send({ method: "initialized" });

const mcp = await request("mcpServerStatus/list", {});
const servers = mcp.result?.data ?? mcp.result?.servers ?? mcp.result;
console.log(`\n=== mcpServerStatus/list result (summary): ${JSON.stringify(servers)?.slice(0, 600)}\n`);

const threadRes = await request("thread/start", {
  cwd: repoRoot,
  approvalPolicy: "never",
  sandbox: "read-only",
});
if (threadRes.error) die(1, `thread/start failed: ${JSON.stringify(threadRes.error)}`);
const threadId = threadRes.result?.threadId ?? threadRes.result?.thread?.id;
if (!threadId) die(1, `could not find threadId in: ${JSON.stringify(threadRes.result)}`);
console.log(`\n=== threadId: ${threadId}\n`);

const turnRes = await request("turn/start", {
  threadId,
  input: [
    {
      type: "text",
      text: "Call the ping tool from the dummy MCP server with message 'hello from spike', then reply with exactly what it returned.",
    },
  ],
});
if (turnRes.error) die(1, `turn/start failed: ${JSON.stringify(turnRes.error)}`);
// now just stream notifications until turn/completed fires (handled above)
