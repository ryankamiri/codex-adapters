"use client";

// Left column: thread history. New chat, a Pinned group, and Recents — each row is
// a SidebarMenuButton with a hover action menu (pin / rename / delete). Backed by
// the naive localStorage store in lib/threads.

import {
  Hexagon,
  MessageSquare,
  MoreHorizontal,
  PencilLine,
  Pin,
  PinOff,
  SquarePen,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { Thread } from "@/lib/threads";

interface AppSidebarProps {
  threads: Thread[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onRemove: (id: string) => void;
  onTogglePin: (id: string) => void;
}

function ThreadRow({
  thread,
  active,
  onSelect,
  onRename,
  onRemove,
  onTogglePin,
}: {
  thread: Thread;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onRemove: (id: string) => void;
  onTogglePin: (id: string) => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} onClick={() => onSelect(thread.id)}>
        <MessageSquare />
        <span className="truncate">{thread.title}</span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger render={<SidebarMenuAction showOnHover aria-label="Thread options" />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => onTogglePin(thread.id)}>
              {thread.pinned ? <PinOff /> : <Pin />}
              {thread.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const next = window.prompt("Rename thread", thread.title);
                if (next && next.trim()) onRename(thread.id, next.trim());
              }}
            >
              <PencilLine />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => onRemove(thread.id)}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

export function AppSidebar({
  threads,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onRemove,
  onTogglePin,
}: AppSidebarProps) {
  const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;
  const pinned = threads.filter((t) => t.pinned).sort(byRecency);
  const recents = threads.filter((t) => !t.pinned).sort(byRecency);

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" onClick={() => onSelect(activeId ?? threads[0]?.id)}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <Hexagon className="size-4" />
              </div>
              <div className="flex flex-col gap-0.5 leading-none">
                <span className="font-semibold">Relay</span>
                <span className="text-xs text-muted-foreground">Agent workspace</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onCreate}>
              <SquarePen />
              New chat
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {pinned.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Pinned</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pinned.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    active={thread.id === activeId}
                    onSelect={onSelect}
                    onRename={onRename}
                    onRemove={onRemove}
                    onTogglePin={onTogglePin}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <SidebarGroupLabel>Recents</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {recents.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  active={thread.id === activeId}
                  onSelect={onSelect}
                  onRename={onRename}
                  onRemove={onRemove}
                  onTogglePin={onTogglePin}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
