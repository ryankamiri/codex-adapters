import type { ApprovalOutcome, ApprovalPolicy } from "../codex/approvals";

export type ApprovalDecision = "allow" | "deny";
export type ApprovalCapability = "mcp" | "shell" | "file" | "permissions" | "user-input" | "unknown";

export interface ApprovalAuditEvent {
  taskId: string;
  method: string;
  capability: ApprovalCapability;
  server?: string;
  tool?: string;
  decision: ApprovalDecision;
  reason: string;
}

export interface ScopedApprovalOptions {
  allowedMcpServers: readonly string[];
  /** Enable messages-mcp only for the trusted-sender command worker. */
  allowMessagesMcp?: boolean;
  allowShellCommands?: boolean;
  allowFileChanges?: boolean;
  /** Called at decision time so a long-lived client can audit the active task. */
  getTaskId?: () => string | undefined;
  onDecision?: (event: ApprovalAuditEvent) => void;
}

const stringAt = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const serverFrom = (params: any): string | undefined =>
  stringAt(params?.serverName) ??
  stringAt(params?.server) ??
  stringAt(params?.mcpServerName) ??
  stringAt(params?.item?.server) ??
  stringAt(params?._meta?.serverName);

const toolFrom = (params: any): string | undefined => {
  const explicit =
    stringAt(params?.toolName) ??
    stringAt(params?.tool) ??
    stringAt(params?.item?.tool) ??
    stringAt(params?._meta?.toolName) ??
    stringAt(params?._meta?.tool_name);
  if (explicit) return explicit;

  // Current app-server approval requests identify the tool only in the stable
  // human message (for example: `run tool "record"?`). Keep this fallback so
  // the audit record remains useful without inspecting or storing tool args.
  const message = stringAt(params?.message);
  return message?.match(/\btool\s+["'“]([^"'”]+)["'”]/i)?.[1];
};

/**
 * A fail-closed policy for turns whose prompts came from iMessage.
 *
 * The app-server uses different response shapes for each approval protocol, so
 * denials deliberately retain those protocol-specific shapes.
 */
export function createScopedApprovalPolicy(options: ScopedApprovalOptions): ApprovalPolicy {
  const allowed = new Set(options.allowedMcpServers);

  return (method: string, params: any): ApprovalOutcome => {
    const taskId = options.getTaskId?.() ?? "unassigned";
    let capability: ApprovalCapability = "unknown";
    let decision: ApprovalDecision = "deny";
    let reason = "unknown approval request";
    let response: Record<string, unknown> = {};
    const server = serverFrom(params);
    const tool = toolFrom(params);

    switch (method) {
      case "mcpServer/elicitation/request": {
        capability = "mcp";
        const isDeliveryAdapter = server === "messages-mcp";
        const messagesMcpAllowed = isDeliveryAdapter && options.allowMessagesMcp === true;
        if (server && allowed.has(server) && (!isDeliveryAdapter || messagesMcpAllowed)) {
          decision = "allow";
          reason = messagesMcpAllowed
            ? "messages-mcp is allowlisted for a trusted-sender task"
            : "MCP server is allowlisted";
          response = { action: "accept", content: {} };
        } else {
          reason = isDeliveryAdapter
            ? "messages-mcp is disabled for this worker"
            : server
              ? "MCP server is not allowlisted"
              : "MCP server identity is missing";
          response = { action: "decline" };
        }
        break;
      }
      case "item/commandExecution/requestApproval":
        capability = "shell";
        decision = options.allowShellCommands ? "allow" : "deny";
        reason = decision === "allow" ? "shell commands explicitly enabled" : "shell commands disabled";
        response = { decision: decision === "allow" ? "accept" : "decline" };
        break;
      case "item/fileChange/requestApproval":
        capability = "file";
        decision = options.allowFileChanges ? "allow" : "deny";
        reason = decision === "allow" ? "file changes explicitly enabled" : "file changes disabled";
        response = { decision: decision === "allow" ? "accept" : "decline" };
        break;
      case "execCommandApproval":
        capability = "shell";
        decision = options.allowShellCommands ? "allow" : "deny";
        reason = decision === "allow" ? "legacy shell commands explicitly enabled" : "legacy shell commands disabled";
        response = { decision: decision === "allow" ? "approved" : "denied" };
        break;
      case "applyPatchApproval":
        capability = "file";
        decision = options.allowFileChanges ? "allow" : "deny";
        reason = decision === "allow" ? "legacy file changes explicitly enabled" : "legacy file changes disabled";
        response = { decision: decision === "allow" ? "approved" : "denied" };
        break;
      case "item/permissions/requestApproval":
        capability = "permissions";
        reason = "additional permissions are never granted";
        response = { permissions: {}, scope: "turn" };
        break;
      case "item/tool/requestUserInput":
        capability = "user-input";
        reason = "interactive user input is unavailable to background tasks";
        response = { answers: {} };
        break;
    }

    options.onDecision?.({ taskId, method, capability, server, tool, decision, reason });
    return {
      response,
      describe: `${decision}: ${reason}${server ? `; server=${server}` : ""}${tool ? `; tool=${tool}` : ""}; task=${taskId}`,
    };
  };
}
