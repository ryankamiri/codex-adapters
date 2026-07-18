"use client";

// OpenAI-style three-pane shell:
//   left   AppSidebar        thread history (localStorage)
//   middle ChatPane          clean conversation (text + reasoning)
//   right  WorkspacePanel    verbose agent activity + snapshots
// ChatWorkspace owns useChat and is keyed by the active thread so switching threads
// swaps the whole conversation.

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatWorkspace } from "@/components/chat-workspace";
import { useThreads } from "@/lib/threads";

export default function Page() {
  const threads = useThreads();
  const active = threads.threads.find((t) => t.id === threads.activeId) ?? null;

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
            onTitle={(title) => threads.rename(active.id, title)}
          />
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
