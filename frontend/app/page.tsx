import { ChatPageClient } from "@/components/chat-page-client";
import type { ImessageFeedThread } from "@/lib/threads";

export const dynamic = "force-dynamic";

const BACKEND = process.env.CODEX_BACKEND_URL ?? "http://127.0.0.1:4000";

export default async function Page() {
  let initialImessageThreads: ImessageFeedThread[] = [];
  try {
    const response = await fetch(`${BACKEND}/api/imessage/threads`, { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json()) as { threads?: ImessageFeedThread[] };
      if (Array.isArray(payload.threads)) initialImessageThreads = payload.threads;
    }
  } catch {
    // The regular chat UI remains available when the listener/backend is offline.
  }

  return <ChatPageClient initialImessageThreads={initialImessageThreads} />;
}
