// Generic MCP test server — a handful of side-effect-free-ish tools to exercise
// the harness's approval + result/error translation paths. Speaks newline-delimited
// JSON-RPC 2.0 per the MCP spec; no SDK needed.
//
// Every model-issued tool call triggers Codex's MCP tool-call approval elicitation,
// so calling ANY tool here tests client.ts's auto-accept of `mcpServer/elicitation/request`.
//
// Tools:
//   echo{message}        -> echoes text (happy-path result item)
//   add{a,b}             -> numeric result
//   fail{reason?}        -> returns an MCP error result (tests error-item translation)
//   write_note{name,text}-> writes a file under ARTIFACTS_DIR (tests env passing + a side effect)

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, text) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
const errResult = (id, text) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });

const TOOLS = [
  { name: "echo", description: "Echo a message back verbatim. Use to verify the server is reachable.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "add", description: "Add two numbers and return the sum.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "fail", description: "Always returns an error result. Use to test error handling.", inputSchema: { type: "object", properties: { reason: { type: "string" } } } },
  { name: "write_note", description: "Write a text note to a file in the artifacts directory; returns the path.", inputSchema: { type: "object", properties: { name: { type: "string" }, text: { type: "string" } }, required: ["name", "text"] } },
];

function callTool(id, name, args = {}) {
  switch (name) {
    case "echo":
      return ok(id, `pong: ${args.message ?? ""}`);
    case "add":
      return ok(id, `sum: ${Number(args.a) + Number(args.b)}`);
    case "fail":
      return errResult(id, `error: ${args.reason ?? "deliberate failure"}`);
    case "write_note": {
      const dir = process.env.ARTIFACTS_DIR || process.cwd();
      try {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, String(args.name || "note.txt"));
        fs.writeFileSync(file, String(args.text ?? ""));
        return ok(id, `wrote ${file}`);
      } catch (e) {
        return errResult(id, `write failed: ${e?.message ?? e}`);
      }
    }
    default:
      return errResult(id, `unknown tool: ${name}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "generic-mcp", version: "0.1.0" } } });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    callTool(id, params?.name, params?.arguments);
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} }); // answer anything else so the client never hangs
  }
});
