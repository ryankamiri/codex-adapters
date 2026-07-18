"use client";

// Single-pane chat shell: ChatShell owns useChat and is keyed by the active thread
// so switching threads swaps the whole conversation.

import { ChatShell } from "@/components/chat-shell";
import { useThreads } from "@/lib/threads";

export default function Page() {
  const threads = useThreads();
  const active = threads.threads.find((t) => t.id === threads.activeId) ?? null;

  return (
    <div className="h-dvh overflow-hidden">
      {threads.ready && active && (
        <ChatShell
          key={active.id}
          threadId={active.id}
          title={active.title}
          onTitle={(title) => threads.rename(active.id, title)}
        />
      )}
    </div>
  );
}
