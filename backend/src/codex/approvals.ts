// Approval policy: auto-answer the server->client requests the app-server sends
// mid-turn so nothing ever stalls. Pluggable so we can add interactive/scoped
// modes later without touching client.ts.
//
// The response FIELD NAMES ARE NOT UNIFORM (verified against codex-rs source):
//   - command / file-change approvals   -> { decision: "accept" }
//   - MCP tool-call elicitation          -> { action: "accept", content: {} }   (NOT `decision`)
//   - permissions request                -> { permissions, scope }              (no accept/decline enum)
//   - legacy v1 apply-patch / exec       -> { decision: "approved" }            (NOT "accept")
//   - tool requestUserInput (experimental) -> { answers: {} }

export type ApprovalOutcome = {
  response: Record<string, unknown>;
  describe: string; // one-line human summary of what we auto-approved
};

export type ApprovalPolicy = (method: string, params: any) => ApprovalOutcome;

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

export function autoAcceptPolicy(): ApprovalPolicy {
  return (method, params) => {
    switch (method) {
      case "mcpServer/elicitation/request": {
        const server = str(params?.serverName, "mcp");
        const tool = str(params?._meta?.tool_params && "tool", "");
        return {
          response: { action: "accept", content: {} },
          describe: `mcp elicitation from "${server}"${tool ? ` (${tool})` : ""}`,
        };
      }
      case "item/commandExecution/requestApproval":
        return {
          response: { decision: "accept" },
          describe: `command: ${str(params?.command, "(exec)")}`,
        };
      case "item/fileChange/requestApproval":
        return {
          response: { decision: "accept" },
          describe: `file change${params?.itemId ? ` (${params.itemId})` : ""}`,
        };
      case "item/permissions/requestApproval":
        // Shape is a granted-permissions profile, not an accept/decline enum.
        // Respond in-shape with an empty grant so the turn proceeds without stalling.
        return {
          response: { permissions: {}, scope: "session" },
          describe: "permissions request (empty grant)",
        };
      case "applyPatchApproval":
      case "execCommandApproval":
        // Legacy v1 channel uses ReviewDecision ("approved"), not "accept".
        return { response: { decision: "approved" }, describe: `legacy approval (${method})` };
      case "item/tool/requestUserInput":
        // Experimental generator toolkit-approval hook; answer empty for now.
        return { response: { answers: {} }, describe: "tool requestUserInput (empty)" };
      default:
        // Unknown server request: answer with {} so we never hang the child.
        return { response: {}, describe: `unknown server request: ${method}` };
    }
  };
}
