// Transport: spawn the codex app-server and speak newline-delimited JSON-RPC.
//
// Notes grounded in the M0 spike + codex-rs research:
//   - Codex is JSON-RPC-*shaped* but does NOT use a "jsonrpc" field on the wire.
//   - Framing is one JSON object per line, both directions.
//   - We spawn the GLOBAL `codex` on PATH (override with CODEX_BIN), never node_modules/.bin.
//   - The child's stdout is JSON-RPC we consume; its stderr is human/log text we forward
//     to OUR stderr so it can never corrupt an event stream printed on stdout.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export interface Transport {
  send(msg: Record<string, unknown>): void;
  onMessage(cb: (msg: any) => void): void;
  onClose(cb: (code: number | null) => void): void;
  close(): void;
}

export interface TransportOptions {
  bin?: string; // defaults to CODEX_BIN or "codex" (resolved via PATH)
  cwd?: string;
  onStderr?: (chunk: string) => void; // child app-server stderr
  journal?: (line: string, dir: "in" | "out") => void; // raw byte-level tap for lossless replay
}

export function spawnAppServer(opts: TransportOptions = {}): Transport {
  const bin = opts.bin ?? process.env.CODEX_BIN ?? "codex";
  const child: ChildProcessWithoutNullStreams = spawn(bin, ["app-server"], {
    cwd: opts.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const messageCbs: ((msg: any) => void)[] = [];
  const closeCbs: ((code: number | null) => void)[] = [];

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    opts.journal?.(line, "in");
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      opts.onStderr?.(`[app-server unparseable] ${line}\n`);
      return;
    }
    for (const cb of messageCbs) cb(msg);
  });

  if (opts.onStderr) {
    child.stderr.on("data", (d: Buffer) => opts.onStderr!(d.toString()));
  }

  child.on("exit", (code) => {
    for (const cb of closeCbs) cb(code);
  });

  return {
    send(msg) {
      const line = JSON.stringify(msg);
      opts.journal?.(line, "out");
      child.stdin.write(line + "\n");
    },
    onMessage(cb) {
      messageCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close() {
      rl.close();
      child.kill();
    },
  };
}
