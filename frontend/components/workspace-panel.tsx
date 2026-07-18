"use client";

// Right column: the agent's "workspace" — a single chronological feed of every
// verbose event the app-server emits (tool calls, shell commands, file changes,
// approvals, MCP status) plus any snapshot artifacts the tools produce. These are
// pulled out of the chat message parts so the middle column can stay clean.

import { useMemo } from "react";
import type { UIMessage } from "ai";
import { Camera, FilePen, Plug, ShieldCheck, Video, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { PanelRightClose } from "lucide-react";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Artifact, ArtifactHeader, ArtifactTitle, ArtifactContent } from "@/components/ai-elements/artifact";
import { cn } from "@/lib/utils";

type WorkEvent =
  | { id: string; kind: "tool"; part: Record<string, unknown> }
  | { id: string; kind: "command"; command: string; status: string; exitCode: number | null }
  | { id: string; kind: "file"; status: string; paths: string[] }
  | { id: string; kind: "approval"; method: string; describe: string }
  | { id: string; kind: "mcp"; server: string; status: string }
  | { id: string; kind: "snapshot"; name: string; src: string; video: boolean };

// Recordings (obs-mcp) sit alongside screenshots in the same feed.
//
// Deliberately NO space in the character class. OBS's default filename format
// contains one ("2026-07-18 12-28-38.mov"), but allowing spaces here makes the
// match greedy and ambiguous — "saved screenshot to shot.png" would match as a
// single bogus path, and "/tmp/a.png and /tmp/b.png" would collapse into one.
// The adapter's README instead has OBS write underscored names.
const IMG_RE = /([/\w.\-]+\.(?:png|jpe?g|gif|webp))/gi;
const VID_RE = /([/\w.\-]+\.(?:mp4|mov|webm|mkv))/gi;

function matchAll(re: RegExp, s: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(s))) found.add(m[1].trim());
  return [...found];
}

// Returns [path, isVideo] pairs for every media file mentioned in a blob.
function extractMedia(output: unknown): Array<[string, boolean]> {
  try {
    const s = typeof output === "string" ? output : JSON.stringify(output ?? "");
    return [
      ...matchAll(IMG_RE, s).map((p) => [p, false] as [string, boolean]),
      ...matchAll(VID_RE, s).map((p) => [p, true] as [string, boolean]),
    ];
  } catch {
    return [];
  }
}

function deriveEvents(messages: UIMessage[]): WorkEvent[] {
  const events: WorkEvent[] = [];
  const seenSnap = new Set<string>();

  // Screenshots surface in a few places — a capture tool's output, a raw
  // `screencapture <path>` shell command, or a file-change path. Scan the given
  // blob for image paths and emit one snapshot per new full path.
  const pushSnapshots = (key: string, blob: unknown) => {
    for (const [file, video] of extractMedia(blob)) {
      if (seenSnap.has(file)) continue;
      seenSnap.add(file);
      const name = file.split("/").pop() ?? file;
      events.push({
        id: `${key}-media-${file}`, // full path — basenames can repeat across dirs
        kind: "snapshot",
        name,
        src: `/api/artifacts?path=${encodeURIComponent(file)}`,
        video,
      });
    }
  };

  for (const message of messages) {
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i] as Record<string, unknown>;
      const type = String(part.type);
      const key = `${message.id}-${i}`;

      if (type === "dynamic-tool" || type.startsWith("tool-")) {
        events.push({ id: key, kind: "tool", part });
        if (part.state === "output-available") pushSnapshots(key, part.output);
        continue;
      }

      const data = part.data as Record<string, unknown> | undefined;
      if (type === "data-command" && data) {
        const command = String(data.command ?? "");
        events.push({
          id: key,
          kind: "command",
          command,
          status: String(data.status ?? ""),
          exitCode: (data.exitCode as number | null) ?? null,
        });
        pushSnapshots(key, command); // e.g. `screencapture -x /private/tmp/shot.png`
      } else if (type === "data-file-change" && data) {
        const paths = (data.paths as string[]) ?? [];
        events.push({ id: key, kind: "file", status: String(data.status ?? ""), paths });
        pushSnapshots(key, paths.join(" "));
      } else if (type === "data-approval" && data) {
        events.push({
          id: key,
          kind: "approval",
          method: String(data.method ?? ""),
          describe: String(data.describe ?? ""),
        });
      } else if (type === "data-mcp" && data) {
        events.push({
          id: key,
          kind: "mcp",
          server: String(data.server ?? ""),
          status: String(data.status ?? ""),
        });
      }
    }
  }
  return events;
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </div>
      {children}
    </div>
  );
}

interface WorkspacePanelProps {
  messages: UIMessage[];
  onClose?: () => void;
}

export function WorkspacePanel({ messages, onClose }: WorkspacePanelProps) {
  // Memoized because this walks every part of every message and regex-scans each
  // tool output. Unmemoized it re-ran on every render — i.e. on every streaming
  // token delta — which is far more work than the panel's own re-render.
  const events = useMemo(() => deriveEvents(messages), [messages]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          Workspace
          {events.length > 0 && <Badge variant="secondary">{events.length}</Badge>}
        </div>
        {onClose && (
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Hide workspace">
            <PanelRightClose />
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-3">
          {events.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-4 py-16 text-center">
              <p className="text-sm text-muted-foreground">No activity yet</p>
              <p className="text-xs text-muted-foreground">
                Tool calls, commands, and snapshots from the agent will appear here.
              </p>
            </div>
          ) : (
            events.map((ev) => {
              if (ev.kind === "tool") {
                // Part shape mirrors the AI SDK tool UI parts; loose access like page.tsx.
                const p = ev.part as any;
                return (
                  <Tool key={ev.id}>
                    <ToolHeader type={p.type} state={p.state} toolName={p.toolName} />
                    <ToolContent>
                      <ToolInput input={p.input} />
                      {(p.state === "output-available" || p.state === "output-error") && (
                        <ToolOutput output={p.output} errorText={p.errorText} />
                      )}
                    </ToolContent>
                  </Tool>
                );
              }
              if (ev.kind === "command") {
                const failed = ev.exitCode !== null && ev.exitCode !== 0;
                return (
                  <Row
                    key={ev.id}
                    icon={Wrench}
                    label={
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="truncate">shell</span>
                        <Badge variant={failed ? "destructive" : "secondary"}>
                          {ev.status || (failed ? `exit ${ev.exitCode}` : "ok")}
                        </Badge>
                      </span>
                    }
                  >
                    <CodeBlock code={`$ ${ev.command}`} language="bash" />
                  </Row>
                );
              }
              if (ev.kind === "file") {
                return (
                  <Row key={ev.id} icon={FilePen} label={`file ${ev.status}`}>
                    <div className="flex flex-col gap-0.5">
                      {ev.paths.map((path) => (
                        <code key={path} className="truncate font-mono text-xs text-muted-foreground">
                          {path}
                        </code>
                      ))}
                    </div>
                  </Row>
                );
              }
              if (ev.kind === "approval") {
                return (
                  <Row
                    key={ev.id}
                    icon={ShieldCheck}
                    label={`auto-approved ${ev.method.split("/").slice(-1)[0]}`}
                  >
                    <p className="text-xs text-muted-foreground">{ev.describe}</p>
                  </Row>
                );
              }
              if (ev.kind === "mcp") {
                return (
                  <Row
                    key={ev.id}
                    icon={Plug}
                    label={
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="truncate">{ev.server}</span>
                        <Badge variant="secondary">{ev.status}</Badge>
                      </span>
                    }
                  />
                );
              }
              // snapshot
              return (
                <Artifact key={ev.id}>
                  <ArtifactHeader>
                    <div className="flex items-center gap-2">
                      {ev.video ? (
                        <Video className="size-3.5 text-muted-foreground" />
                      ) : (
                        <Camera className="size-3.5 text-muted-foreground" />
                      )}
                      <ArtifactTitle>{ev.name}</ArtifactTitle>
                    </div>
                  </ArtifactHeader>
                  <ArtifactContent className={cn("p-2")}>
                    {ev.video ? (
                      // preload="metadata" so the panel doesn't pull whole
                      // recordings just to show a player for each one.
                      <video
                        src={ev.src}
                        controls
                        preload="metadata"
                        className="max-h-72 w-full rounded-md border border-border bg-black object-contain"
                      />
                    ) : (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={ev.src}
                        alt={ev.name}
                        className="max-h-72 w-full rounded-md border border-border object-contain"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                      />
                    )}
                  </ArtifactContent>
                </Artifact>
              );
            })
          )}
        </div>
      </ScrollArea>
      <Separator />
    </div>
  );
}
