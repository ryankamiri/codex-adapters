"use client";

// Right column: the agent's "workspace", split into two tabs.
//
//   Activity — a chronological feed of every verbose event the app-server emits
//              (tool calls, shell commands, file changes, approvals) plus any
//              snapshot artifacts the tools produce, pulled out of the chat
//              message parts so the middle column can stay clean.
//   Servers  — the registered MCP servers and what each one can actually do.
//
// MCP startup chatter used to land in the feed as one row per server per state
// transition, which buried the actual work. Those transitions now drive the
// status on the Servers tab instead; only a server that FAILS still gets a feed
// row, because that's the case you need to notice while it happens.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { UIMessage } from "ai";
import {
  Camera,
  ChevronRight,
  FilePen,
  PanelRightClose,
  Plug,
  RefreshCw,
  ShieldCheck,
  Video,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
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

// Unhealthy values of codex's McpServerStartupState ("starting" | "ready" |
// "failed" | "cancelled").
const MCP_BAD = new Set(["failed", "cancelled"]);

interface Derived {
  events: WorkEvent[];
  /** server name -> latest startup state seen on the stream. */
  mcpState: Record<string, string>;
}

function deriveEvents(messages: UIMessage[]): Derived {
  const events: WorkEvent[] = [];
  const mcpState: Record<string, string> = {};
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
        // Feeds the Servers tab rather than the timeline — except failures,
        // which still deserve to interrupt you where you're already looking.
        const server = String(data.server ?? "");
        const status = String(data.status ?? "");
        mcpState[server] = status;
        if (MCP_BAD.has(status)) events.push({ id: key, kind: "mcp", server, status });
      }
    }
  }
  return { events, mcpState };
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

// ── Servers tab ──────────────────────────────────────────────────────────────

interface McpTool {
  name: string;
  description: string;
}
interface McpServer {
  name: string;
  title: string | null;
  tools: McpTool[];
}

function ServersTab({ mcpState }: { mcpState: Record<string, string> }) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (data: unknown) => {
    const list = (data as { servers?: McpServer[] })?.servers;
    setServers(Array.isArray(list) ? list : []);
  };

  const load = useCallback(async () => {
    setBusy(true);
    try {
      apply(await (await fetch("/api/mcp/servers")).json());
    } catch {
      setServers([]);
    } finally {
      setBusy(false);
    }
  }, []);

  // Re-reads MCP config on the app-server, so a newly added adapter shows up
  // without restarting anything. Same response shape as the plain list.
  const reload = useCallback(async () => {
    setBusy(true);
    try {
      apply(await (await fetch("/api/mcp/reload", { method: "POST" })).json());
    } catch {
      /* keep whatever is already on screen */
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {servers === null ? "Loading…" : `${servers.length} connected`}
        </span>
        <Button variant="ghost" size="sm" onClick={reload} disabled={busy}>
          {busy ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
          Reload
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {servers !== null && servers.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Plug />
              </EmptyMedia>
              <EmptyTitle>No MCP servers</EmptyTitle>
              <EmptyDescription>
                Add an adapter to ~/.codex/config.toml, then hit Reload.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-1">
            {(servers ?? []).map((server) => {
              const state = mcpState[server.name];
              const failed = MCP_BAD.has(state ?? "") || server.tools.length === 0;
              return (
                <Collapsible key={server.name}>
                  <Item
                    variant="outline"
                    size="sm"
                    className="text-left"
                    render={<CollapsibleTrigger />}
                  >
                    <ItemMedia variant="icon">
                      <Plug className={cn(failed && "text-destructive")} />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="truncate">{server.name}</ItemTitle>
                      {/* serverInfo usually just repeats the server name — only
                          worth a subtitle when it actually says something else. */}
                      {server.title && server.title !== server.name && (
                        <ItemDescription>{server.title}</ItemDescription>
                      )}
                    </ItemContent>
                    <ItemActions className="shrink-0">
                      <Badge variant={failed ? "destructive" : "secondary"}>
                        {server.tools.length === 0
                          ? (state ?? "no tools")
                          : `${server.tools.length} tools`}
                      </Badge>
                      <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[panel-open]/item:rotate-90" />
                    </ItemActions>
                  </Item>
                  <CollapsibleContent>
                    <ItemGroup className="gap-0 py-1 pl-4">
                      {server.tools.map((tool) => (
                        <Item key={tool.name} size="xs">
                          <ItemContent>
                            <ItemTitle className="font-mono text-xs">{tool.name}</ItemTitle>
                            {tool.description && (
                              <ItemDescription className="line-clamp-2">
                                {tool.description}
                              </ItemDescription>
                            )}
                          </ItemContent>
                        </Item>
                      ))}
                    </ItemGroup>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </ItemGroup>
        )}
      </div>
    </div>
  );
}

// ── Activity tab ─────────────────────────────────────────────────────────────

function ActivityTab({ events }: { events: WorkEvent[] }) {
  if (events.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Wrench />
          </EmptyMedia>
          <EmptyTitle>No activity yet</EmptyTitle>
          <EmptyDescription>
            Tool calls, commands, and snapshots from the agent will appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  // Conversation is the same stick-to-bottom container the chat pane uses, so the
  // feed follows new events while they stream but stops following the moment you
  // scroll up to read something — the button scrolls you back down.
  return (
    <Conversation className="h-full">
      <ConversationContent className="gap-2 p-3">
        {events.map((ev) => {
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
                    <Badge variant="destructive">{ev.status}</Badge>
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
        })}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
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
  const { events, mcpState } = useMemo(() => deriveEvents(messages), [messages]);

  return (
    <Tabs defaultValue="activity" className="h-full gap-0 bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
        <TabsList variant="line">
          <TabsTrigger value="activity">
            Activity
            {events.length > 0 && <Badge variant="secondary">{events.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="servers">Servers</TabsTrigger>
        </TabsList>
        {onClose && (
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Hide workspace">
            <PanelRightClose />
          </Button>
        )}
      </div>

      <TabsContent value="activity" className="min-h-0">
        <ActivityTab events={events} />
      </TabsContent>
      <TabsContent value="servers" className="min-h-0">
        <ServersTab mcpState={mcpState} />
      </TabsContent>
    </Tabs>
  );
}
