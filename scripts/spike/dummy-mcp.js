// M0 spike: minimal stdio MCP server with one tool ("ping").
// Speaks newline-delimited JSON-RPC 2.0 per the MCP spec — no SDK needed.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

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
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "dummy-mcp", version: "0.0.1" },
      },
    });
  } else if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "ping",
            description:
              "Echo a message back. Use this to verify the dummy MCP server is reachable.",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
            },
          },
        ],
      },
    });
  } else if (method === "tools/call") {
    const text =
      params?.name === "ping"
        ? `pong: ${params?.arguments?.message ?? ""}`
        : `unknown tool: ${params?.name}`;
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
  } else if (id !== undefined) {
    // Answer anything else so the client never hangs on us.
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
