import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CONFIG_PATH = "config/imessage-harness.json";

export type HarnessMode = "dry-run" | "auto-send";

export interface ImessageHarnessConfig {
  enabled: boolean;
  /** @deprecated Read-only alias for the first trusted sender. */
  allowedSender: string;
  allowedSenders: string[];
  service: "iMessage";
  allowedMcpServers: string[];
  allowShell: boolean;
  allowFileChanges: boolean;
  pollIntervalMs: number;
  debounceMs: number;
  maxTaskRuntimeMs: number;
  maxReplyCharacters: number;
  maxQueuedTasks: number;
  sendAcknowledgement: boolean;
  mode: HarnessMode;
}

const DEFAULTS: Omit<ImessageHarnessConfig, "allowedSender" | "allowedSenders"> = {
  enabled: false,
  service: "iMessage",
  allowedMcpServers: [],
  allowShell: false,
  allowFileChanges: false,
  pollIntervalMs: 1_000,
  debounceMs: 1_500,
  maxTaskRuntimeMs: 30 * 60_000,
  maxReplyCharacters: 1_500,
  maxQueuedTasks: 20,
  sendAcknowledgement: false,
  mode: "auto-send",
};

const KNOWN_KEYS = new Set(["allowedSender", "allowedSenders", ...Object.keys(DEFAULTS)]);
const E164 = /^\+[1-9]\d{7,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

function assertBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
}

function positiveInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value as number;
}

export function parseHarnessConfig(input: unknown): ImessageHarnessConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("iMessage harness config must be a JSON object");
  }
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length) throw new Error(`unknown iMessage harness config key(s): ${unknown.join(", ")}`);

  if (raw.allowedSender != null && raw.allowedSenders != null) {
    throw new Error("configure allowedSenders, not both allowedSender and allowedSenders");
  }
  const senderInput = raw.allowedSenders ?? (raw.allowedSender == null ? undefined : [raw.allowedSender]);
  if (!Array.isArray(senderInput) || senderInput.length === 0 || senderInput.some((sender) => typeof sender !== "string" || !isE164(sender))) {
    throw new Error("allowedSenders must be a non-empty array of strict E.164 numbers such as +15551234567");
  }
  const allowedSenders = [...new Set(senderInput as string[])];

  const merged = { ...DEFAULTS, ...raw } as Record<string, unknown>;
  assertBoolean(merged.enabled, "enabled");
  assertBoolean(merged.allowShell, "allowShell");
  assertBoolean(merged.allowFileChanges, "allowFileChanges");
  assertBoolean(merged.sendAcknowledgement, "sendAcknowledgement");
  if (merged.service !== "iMessage") throw new Error('service must be exactly "iMessage"');
  if (merged.mode !== "dry-run" && merged.mode !== "auto-send") {
    throw new Error('mode must be either "dry-run" or "auto-send"');
  }
  if (!Array.isArray(merged.allowedMcpServers) || merged.allowedMcpServers.some((v) => typeof v !== "string" || !v)) {
    throw new Error("allowedMcpServers must be an array of non-empty strings");
  }
  const allowedMcpServers = [...new Set(merged.allowedMcpServers as string[])];

  return {
    enabled: merged.enabled,
    allowedSender: allowedSenders[0],
    allowedSenders,
    service: "iMessage",
    allowedMcpServers,
    allowShell: merged.allowShell,
    allowFileChanges: merged.allowFileChanges,
    pollIntervalMs: positiveInteger(merged.pollIntervalMs, "pollIntervalMs", 60_000),
    debounceMs: positiveInteger(merged.debounceMs, "debounceMs", 60_000),
    maxTaskRuntimeMs: positiveInteger(merged.maxTaskRuntimeMs, "maxTaskRuntimeMs", 24 * 60 * 60_000),
    maxReplyCharacters: positiveInteger(merged.maxReplyCharacters, "maxReplyCharacters", 10_000),
    maxQueuedTasks: positiveInteger(merged.maxQueuedTasks, "maxQueuedTasks", 10_000),
    sendAcknowledgement: merged.sendAcknowledgement,
    mode: merged.mode,
  };
}

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests and unusual filesystems may disable the POSIX permissions check. */
  requireSecurePermissions?: boolean;
}

export async function loadHarnessConfig(options: LoadConfigOptions = {}): Promise<ImessageHarnessConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configuredPath = env.IMESSAGE_HARNESS_CONFIG || DEFAULT_CONFIG_PATH;
  const configPath = path.resolve(cwd, configuredPath);
  const info = await stat(configPath);
  if ((options.requireSecurePermissions ?? process.platform !== "win32") && (info.mode & 0o077) !== 0) {
    throw new Error(`iMessage harness config must be private (chmod 600 ${configPath})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read iMessage harness config at ${configPath}`, { cause: error });
  }
  return parseHarnessConfig(parsed);
}
