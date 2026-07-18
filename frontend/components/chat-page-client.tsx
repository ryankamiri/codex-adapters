"use client";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatWorkspace } from "@/components/chat-workspace";
import { useThreads, type ImessageFeedThread } from "@/lib/threads";
import type { UIMessage } from "ai";

export function ChatPageClient({ initialImessageThreads }: { initialImessageThreads: ImessageFeedThread[] }) {
  const threads = useThreads(initialImessageThreads);
  const active = threads.threads.find((thread) => thread.id === threads.activeId) ?? null;
  const inbound = initialImessageThreads.find((thread) => thread.id === active?.id);
  const initialMessages: UIMessage[] | undefined = inbound
    ? [
        { id: `${inbound.id}:user`, role: "user", parts: [{ type: "text", text: inbound.prompt }] },
        ...(inbound.reply
          ? [{ id: `${inbound.id}:assistant`, role: "assistant" as const, parts: [{ type: "text" as const, text: inbound.reply }] }]
          : []),
      ]
    : undefined;

  return (
    <SidebarProvider className="h-dvh overflow-hidden">
      <AppSidebar
        threads={threads.threads}
        activeId={threads.activeId}
        onSelect={threads.select}
        onCreate={threads.create}
        onRename={threads.rename}
        onRemove={threads.remove}
        onTogglePin={threads.togglePin}
      />
      <SidebarInset className="h-dvh overflow-hidden">
        {threads.ready && active && (
          <ChatWorkspace
            key={active.id}
            threadId={active.id}
            title={active.title}
            initialMessages={initialMessages}
            onTitle={(title) => threads.rename(active.id, title)}
          />
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
