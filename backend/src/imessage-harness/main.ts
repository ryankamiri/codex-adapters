import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadHarnessConfig, type HarnessMode, type ImessageHarnessConfig } from "./config";
import { CodexTaskWorker } from "./codex-worker";
import { SqliteHarnessLedger } from "./ledger";
import { ImessageListener } from "./listener";
import { SqliteMessagesStore } from "./messages-store";
import { MessagesMcpClient, ReplyDelivery } from "./reply-delivery";
import { ImessageHarnessService } from "./service";
import type { AgentEvent } from "../codex/contract";

export interface HarnessCliOptions {
  mode?: HarnessMode;
}

export function formatMcpDiagnostic(worker: "trusted" | "conversation", event: AgentEvent): string | undefined {
  const base = { worker, threadId: event.threadId, turnId: event.turnId };
  if (event.kind === "mcp" && event.phase === "startup") {
    return JSON.stringify({ ...base, type: "startup", server: event.server, status: event.status });
  }
  if (event.kind === "approval" && event.method === "mcpServer/elicitation/request") {
    const params = event.params as Record<string, unknown> | undefined;
    const response = event.response as Record<string, unknown> | undefined;
    return JSON.stringify({
      ...base,
      type: "approval",
      server: params?.serverName ?? params?.mcpServerName,
      tool: params?.toolName,
      decision: response?.action ?? response?.decision,
    });
  }
  if (event.kind === "item" && event.itemType === "mcpToolCall") {
    const item = event.item as { server?: string; tool?: string; status?: string; error?: unknown };
    return JSON.stringify({
      ...base,
      type: "tool_call",
      phase: event.phase,
      server: item.server,
      tool: item.tool,
      status: item.status,
      error: Boolean(item.error),
    });
  }
  return undefined;
}

const logMcpDiagnostic = (worker: "trusted" | "conversation") => (event: AgentEvent): void => {
  const diagnostic = formatMcpDiagnostic(worker, event);
  if (diagnostic) process.stderr.write(`[imessage-harness:mcp] ${diagnostic}\n`);
};

export function parseHarnessCli(argv: string[]): HarnessCliOptions {
  let mode: HarnessMode | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let value: string | undefined;
    if (argument === "--mode") value = argv[++index];
    else if (argument.startsWith("--mode=")) value = argument.slice("--mode=".length);
    else throw new Error(`unknown iMessage harness argument: ${argument}`);
    if (value !== "dry-run" && value !== "auto-send") {
      throw new Error('--mode must be exactly "dry-run" or "auto-send"');
    }
    mode = value;
  }
  return { ...(mode ? { mode } : {}) };
}

export function applyCliOverrides(config: ImessageHarnessConfig, cli: HarnessCliOptions): ImessageHarnessConfig {
  return cli.mode ? { ...config, mode: cli.mode } : config;
}

export interface RunningHarness {
  config: ImessageHarnessConfig;
  service: ImessageHarnessService;
  reloadConfiguration(): Promise<void>;
  stop(): Promise<void>;
}

export async function startHarness(argv = process.argv.slice(2)): Promise<RunningHarness> {
  const config = applyCliOverrides(await loadHarnessConfig(), parseHarnessCli(argv));
  const messagesDatabase = process.env.IMESSAGE_HARNESS_MESSAGES_DB
    ? path.resolve(process.env.IMESSAGE_HARNESS_MESSAGES_DB)
    : path.join(os.homedir(), "Library/Messages/chat.db");
  const ledgerDatabase = path.resolve(process.env.IMESSAGE_HARNESS_STATE_DB ?? "data/imessage-harness/state.sqlite");

  const messagesStore = new SqliteMessagesStore(messagesDatabase);
  const ledger = new SqliteHarnessLedger(ledgerDatabase);
  const listener = new ImessageListener({
    store: messagesStore,
    ledger,
    allowedSenders: config.allowedSenders,
    pollIntervalMs: config.pollIntervalMs,
    maxQueuedTasks: config.maxQueuedTasks,
    freshnessWindowMs: config.freshnessWindowMs,
  });
  const worker = new CodexTaskWorker({
    allowedMcpServers: config.allowedMcpServers,
    // This worker receives prompts only from allowedSenders. The separate
    // conversation worker below remains unable to invoke messages-mcp.
    allowMessagesMcp: true,
    allowShellCommands: config.allowShell,
    allowFileChanges: config.allowFileChanges,
    timeoutMs: config.maxTaskRuntimeMs,
    cwd: process.cwd(),
    onApprovalDecision: (event) => ledger.recordApprovalDecision(event),
    onEvent: logMcpDiagnostic("trusted"),
  });
  const conversationWorker = new CodexTaskWorker({
    allowedMcpServers: [],
    allowMessagesMcp: false,
    allowShellCommands: false,
    allowFileChanges: false,
    timeoutMs: config.maxTaskRuntimeMs,
    cwd: process.cwd(),
    onApprovalDecision: (event) => ledger.recordApprovalDecision(event),
    onEvent: logMcpDiagnostic("conversation"),
  });
  const delivery = new ReplyDelivery({
    mode: config.mode,
    maxReplyCharacters: config.maxReplyCharacters,
    client: new MessagesMcpClient({ cwd: process.cwd() }),
  });
  const service = new ImessageHarnessService({
    config,
    listener,
    store: ledger,
    worker,
    conversationWorker,
    delivery,
    onEvent: (event) => process.stderr.write(`[imessage-harness] ${JSON.stringify(event)}\n`),
  });

  let stopped = false;
  const reloadConfiguration = async () => {
    const next = await loadHarnessConfig();
    listener.setAllowedSenders(next.allowedSenders);
    delivery.setMode(next.mode);
    process.stderr.write(
      `[imessage-harness] reloaded mode=${next.mode} trusted_senders=${next.allowedSenders.length}\n`,
    );
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await service.stop();
    messagesStore.close();
  };

  try {
    await service.start();
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
  process.stderr.write(
    `[imessage-harness] started enabled=${config.enabled} mode=${config.mode} trusted_senders=${config.allowedSenders.length}\n`,
  );
  return { config, service, reloadConfiguration, stop };
}

async function cli(): Promise<void> {
  const running = await startHarness();
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[imessage-harness] stopping after ${signal}\n`);
    void running.stop().then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`[imessage-harness] shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => {
    void running.reloadConfiguration().catch((error) => {
      process.stderr.write(`[imessage-harness] reload failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void cli().catch((error) => {
    process.stderr.write(`[imessage-harness] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
