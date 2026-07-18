import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessMode } from "./config";

export interface SendToChatClient {
  sendToChat(chatId: string, message: string, timeoutMs: number): Promise<void>;
}

export type DeliveryResult =
  | { state: "dry_run"; message: string }
  | { state: "sent"; message: string }
  | { state: "send_uncertain"; message: string; error: string }
  | { state: "failed"; message: string; error: string };

export interface ReplyDeliveryOptions {
  mode: HarnessMode;
  maxReplyCharacters: number;
  timeoutMs?: number;
  client: SendToChatClient;
}

const TRUNCATED_SUFFIX = "\n\n[Reply truncated]";

export function boundReply(reply: string, maximum: number): string {
  if (reply.length <= maximum) return reply;
  if (maximum <= TRUNCATED_SUFFIX.length) return TRUNCATED_SUFFIX.slice(0, maximum);
  return `${reply.slice(0, maximum - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}

export class ReplyDelivery {
  private readonly timeoutMs: number;

  constructor(private readonly options: ReplyDeliveryOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  setMode(mode: HarnessMode): void {
    this.options.mode = mode;
  }

  async deliver(chatId: string, reply: string): Promise<DeliveryResult> {
    const message = boundReply(reply, this.options.maxReplyCharacters);
    if (!chatId) return { state: "failed", message, error: "missing original chat ID" };
    if (!message.trim()) return { state: "failed", message, error: "refusing to send an empty reply" };
    if (this.options.mode === "dry-run") return { state: "dry_run", message };

    // Once tools/call is dispatched, a timeout or transport failure is ambiguous:
    // Messages may have accepted the send. Never report it as safely retryable.
    try {
      await this.options.client.sendToChat(chatId, message, this.timeoutMs);
      return { state: "sent", message };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { state: "send_uncertain", message, error: detail };
    }
  }
}

interface RpcResponse {
  id?: number;
  result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  error?: { message?: string };
}

export interface MessagesMcpClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Developer-only adapter diagnostics. Defaults to backend stderr. */
  onStderr?: (chunk: string) => void;
}

export class MessagesMcpClient implements SendToChatClient {
  private readonly command: string;
  private readonly args: string[];

  constructor(private readonly options: MessagesMcpClientOptions = {}) {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    this.command = options.command ?? process.execPath;
    this.args = options.args ?? [path.join(repositoryRoot, "adapters/messages-mcp/server.mjs")];
  }

  async sendToChat(chatId: string, message: string, timeoutMs: number): Promise<void> {
    const child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (this.options.onStderr) this.options.onStderr(text);
      else process.stderr.write(`[messages-mcp] ${text}`);
    };
    child.stderr.on("data", onStderr);
    try {
      const initialize = await request(child, 1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "imessage-codex-harness", version: "0.1.0" },
      }, timeoutMs);
      if (initialize.error) throw new Error(initialize.error.message ?? "messages-mcp initialization failed");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const response = await request(child, 2, "tools/call", {
        name: "send_to_chat",
        arguments: { chat_id: chatId, message },
      }, timeoutMs);
      if (response.error) throw new Error(response.error.message ?? "messages-mcp send failed");
      if (response.result?.isError) {
        const detail = response.result.content?.map((item) => item.text ?? "").filter(Boolean).join("; ");
        throw new Error(detail || "messages-mcp returned an error");
      }
    } finally {
      child.stderr.off("data", onStderr);
      child.kill();
    }
  }
}

function request(
  child: ChildProcessWithoutNullStreams,
  id: number,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line) as RpcResponse;
          if (response.id === id) return finish(undefined, response);
        } catch {
          // Ignore non-JSON diagnostics; compliant MCP adapters reserve stdout.
        }
      }
    };
    const onStderr = (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000); };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(`${method} transport exited (${code})${stderr ? `: ${stderr.trim()}` : ""}`));
    const finish = (error?: Error, response?: RpcResponse) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(response!);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
