"use client";

// Owns the useChat instance for one thread and lays out the two right-hand panes:
// the clean chat (middle) and the verbose workspace timeline (right), split by a
// draggable handle. Mounted with key={threadId} by the page, so switching threads
// remounts this with a fresh chat that hydrates from localStorage.

import { useEffect, useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { PanelRight, RefreshCw } from "lucide-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { ChatPane } from "./chat-pane";
import { WorkspacePanel } from "./workspace-panel";
import { loadMessages, saveMessages } from "@/lib/threads";
import { useModelPicker } from "@/lib/models";

interface ChatWorkspaceProps {
  threadId: string;
  title: string;
  onTitle: (title: string) => void;
}

export function ChatWorkspace({ threadId, title, onTitle }: ChatWorkspaceProps) {
  const [showWorkspace, setShowWorkspace] = useState(true);
  const { models, model, setModel } = useModelPicker();

  // threadId is baked into the transport body (this component is keyed by threadId
  // upstream, so it never goes stale) — the backend routes the turn to that thread.
  //
  // Send ONLY the latest user message, not the whole transcript. Codex holds the
  // conversation server-side on the thread, and the backend reads just the last
  // user message (see latestUserText in backend/src/server.ts) — so uploading the
  // full history every turn was pure waste, and with verbose tool output (a single
  // minecraft scan_surroundings is a large JSON blob) it grew past Fastify's body
  // limit and the request started failing with HTTP 413.
  const { messages, sendMessage, status, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: { threadId },
      // `body` here is already the transport body merged with the per-call body,
      // so spreading it keeps both threadId and the model picker's selection.
      prepareSendMessagesRequest: ({ messages: msgs, body }) => {
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        return { body: { ...body, messages: lastUser ? [lastUser] : [] } };
      },
    }),
  });

  // De-duplicate by message id (last wins). Guards against a rare duplicate slipping
  // into useChat's state and colliding React keys; also heals any stored dupes.
  const uiMessages = useMemo(() => {
    const byId = new Map<string, (typeof messages)[number]>();
    for (const m of messages) byId.set(m.id, m);
    return byId.size === messages.length ? messages : [...byId.values()];
  }, [messages]);

  // Hydrate from storage on mount (this component is keyed by threadId upstream).
  useEffect(() => {
    const stored = loadMessages(threadId);
    if (stored.length) setMessages(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Persist on change. Guarded so the initial empty render never clobbers storage.
  useEffect(() => {
    if (uiMessages.length) saveMessages(threadId, uiMessages);
  }, [threadId, uiMessages]);

  const onSend = (text: string) => {
    if (title === "New chat" || !title.trim()) {
      onTitle(text.length > 48 ? `${text.slice(0, 48)}…` : text);
    }
    // model is sent per-call so a change mid-thread takes effect immediately.
    sendMessage({ text }, model ? { body: { model } } : undefined);
  };

  const onStop = () => {
    stop(); // abort the client stream
    // ...and interrupt the codex turn server-side so the agent actually stops.
    fetch("/api/interrupt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId }),
    }).catch(() => {});
  };

  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpCount, setMcpCount] = useState<number | null>(null);
  const reloadMcp = async () => {
    setMcpLoading(true);
    try {
      const res = await fetch("/api/mcp/reload", { method: "POST" });
      const data = await res.json();
      setMcpCount(Array.isArray(data.servers) ? data.servers.length : null);
    } catch {
      /* ignore */
    } finally {
      setMcpLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-1 h-5" />
        <span className="truncate text-sm font-medium">{title}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={reloadMcp}
            disabled={mcpLoading}
            title="Reload MCP servers (pick up newly added adapters without restarting)"
          >
            {mcpLoading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            {mcpCount !== null ? `${mcpCount} MCP` : "Reload MCP"}
          </Button>
          {!showWorkspace && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowWorkspace(true)}
              aria-label="Show workspace"
            >
              <PanelRight />
            </Button>
          )}
        </div>
      </header>

      {/* Sizes are STRINGS = percentages in react-resizable-panels v4 (bare numbers
          would be pixels). Keyed by showWorkspace so the layout resets cleanly when
          the right panel is toggled. */}
      <ResizablePanelGroup
        key={showWorkspace ? "split" : "solo"}
        id="chat-workspace"
        orientation="horizontal"
        className="flex-1"
      >
        <ResizablePanel id="chat" defaultSize={showWorkspace ? "78" : "100"} minSize="35">
          <ChatPane
            messages={uiMessages}
            status={status}
            onSend={onSend}
            onStop={onStop}
            models={models}
            model={model}
            setModel={setModel}
          />
        </ResizablePanel>
        {showWorkspace && (
          <>
            <ResizableHandle withHandle className="w-1 bg-transparent transition-colors hover:bg-border" />
            <ResizablePanel id="workspace" defaultSize="22" minSize="22" maxSize="60">
              <WorkspacePanel messages={uiMessages} onClose={() => setShowWorkspace(false)} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
