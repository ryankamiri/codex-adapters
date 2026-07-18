"use client";

// Owns the useChat instance for one thread and renders the chat pane full-width.
// Mounted with key={threadId} by the page, so switching threads remounts this with
// a fresh chat that hydrates from localStorage.

import { useEffect, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { ChatPane } from "./chat-pane";
import { loadMessages, saveMessages } from "@/lib/threads";
import { useModelPicker } from "@/lib/models";

interface ChatShellProps {
  threadId: string;
  title: string;
  onTitle: (title: string) => void;
}

export function ChatShell({ threadId, title, onTitle }: ChatShellProps) {
  const { models, model, setModel } = useModelPicker();

  // threadId is baked into the transport body (this component is keyed by threadId
  // upstream, so it never goes stale) — the backend routes the turn to that thread.
  const { messages, sendMessage, status, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat", body: { threadId } }),
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

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-1 h-5" />
        <span className="truncate text-sm font-medium">{title}</span>
      </header>
      {/* ChatPane is h-full, so it needs a bounded flex child to size against. */}
      <div className="min-h-0 flex-1">
        <ChatPane
          messages={uiMessages}
          status={status}
          onSend={onSend}
          onStop={onStop}
          models={models}
          model={model}
          setModel={setModel}
        />
      </div>
    </div>
  );
}
