import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadHarnessConfig, parseHarnessConfig } from "../../src/imessage-harness/config";

test("config defaults to disabled auto-send and requires strict E.164", () => {
  const config = parseHarnessConfig({ allowedSender: "+15551234567" });
  assert.equal(config.enabled, false);
  assert.equal(config.mode, "auto-send");
  assert.deepEqual(config.allowedSenders, ["+15551234567"]);
  assert.throws(() => parseHarnessConfig({ allowedSender: "(555) 123-4567" }), /strict E\.164/);
  assert.throws(() => parseHarnessConfig({ allowedSender: "+15551234567", surprise: true }), /unknown/);
});

test("config accepts and deduplicates multiple trusted senders", () => {
  const config = parseHarnessConfig({ allowedSenders: ["+15551234567", "+15557654321", "+15551234567"] });
  assert.deepEqual(config.allowedSenders, ["+15551234567", "+15557654321"]);
  assert.equal(config.allowedSender, "+15551234567");
});

test("messages-mcp can be allowlisted for the trusted-sender worker", () => {
  const config = parseHarnessConfig({
    allowedSender: "+15551234567",
    allowedMcpServers: ["messages-mcp"],
  });
  assert.deepEqual(config.allowedMcpServers, ["messages-mcp"]);
});

test("config path is selected through IMESSAGE_HARNESS_CONFIG and must be private", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "imessage-config-"));
  const configPath = path.join(directory, "private.json");
  await writeFile(configPath, JSON.stringify({ allowedSender: "+15551234567", mode: "auto-send" }));
  await chmod(configPath, 0o600);
  try {
    const loaded = await loadHarnessConfig({ cwd: "/", env: { IMESSAGE_HARNESS_CONFIG: configPath } });
    assert.equal(loaded.mode, "auto-send");
    await chmod(configPath, 0o644);
    await assert.rejects(() => loadHarnessConfig({ env: { IMESSAGE_HARNESS_CONFIG: configPath } }), /chmod 600/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
