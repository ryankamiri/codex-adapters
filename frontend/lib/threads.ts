"use client";

// Naive thread persistence — the sidebar's history lives entirely in localStorage.
// A thread is just {id, title, timestamps, pinned}; its transcript is stored under a
// per-thread key. The backend routes turns by the same thread id (sent in the chat
// request body), keeping one Codex thread per ui thread. Good enough "for now": the
// visible history survives reloads without a database.

import { useCallback, useEffect, useState } from "react";
import type { UIMessage } from "ai";

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

const THREADS_KEY = "codex-threads";
const msgsKey = (id: string) => `codex-thread-msgs:${id}`;

function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `t_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function readThreads(): Thread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(THREADS_KEY);
    return raw ? (JSON.parse(raw) as Thread[]) : [];
  } catch {
    return [];
  }
}

function writeThreads(threads: Thread[]) {
  try {
    window.localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
  } catch {
    /* quota / private mode — history just won't persist */
  }
}

export function loadMessages(id: string): UIMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(msgsKey(id));
    return raw ? (JSON.parse(raw) as UIMessage[]) : [];
  } catch {
    return [];
  }
}

export function saveMessages(id: string, messages: UIMessage[]) {
  try {
    window.localStorage.setItem(msgsKey(id), JSON.stringify(messages));
  } catch {
    /* ignore */
  }
}

function deleteMessages(id: string) {
  try {
    window.localStorage.removeItem(msgsKey(id));
  } catch {
    /* ignore */
  }
}

export interface UseThreads {
  threads: Thread[];
  activeId: string | null;
  ready: boolean;
  create: () => string;
  select: (id: string) => void;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;
  togglePin: (id: string) => void;
}

export function useThreads(): UseThreads {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Hydrate after mount (localStorage is client-only). Seed one empty thread on
  // first ever visit so the UI always has an active thread.
  useEffect(() => {
    const existing = readThreads();
    if (existing.length === 0) {
      const seed: Thread = {
        id: newId(),
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      writeThreads([seed]);
      setThreads([seed]);
      setActiveId(seed.id);
    } else {
      setThreads(existing);
      setActiveId(existing[0].id);
    }
    setReady(true);
  }, []);

  const persist = useCallback((next: Thread[]) => {
    setThreads(next);
    writeThreads(next);
  }, []);

  const create = useCallback((): string => {
    // Reuse an existing pristine "New chat" instead of piling up empties.
    const pristine = threads.find((t) => t.title === "New chat" && loadMessages(t.id).length === 0);
    if (pristine) {
      setActiveId(pristine.id);
      return pristine.id;
    }
    const t: Thread = { id: newId(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now() };
    persist([t, ...threads]);
    setActiveId(t.id);
    return t.id;
  }, [threads, persist]);

  const select = useCallback((id: string) => setActiveId(id), []);

  const rename = useCallback(
    (id: string, title: string) => {
      persist(
        threads.map((t) =>
          t.id === id ? { ...t, title: title.trim() || t.title, updatedAt: Date.now() } : t,
        ),
      );
    },
    [threads, persist],
  );

  const remove = useCallback(
    (id: string) => {
      deleteMessages(id);
      const next = threads.filter((t) => t.id !== id);
      if (next.length === 0) {
        const seed: Thread = { id: newId(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now() };
        persist([seed]);
        setActiveId(seed.id);
        return;
      }
      persist(next);
      if (activeId === id) setActiveId(next[0].id);
    },
    [threads, activeId, persist],
  );

  const togglePin = useCallback(
    (id: string) => {
      persist(threads.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)));
    },
    [threads, persist],
  );

  return { threads, activeId, ready, create, select, rename, remove, togglePin };
}
