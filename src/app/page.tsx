"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import ChatWorkspace from "@/components/chat/ChatWorkspace";

function ChatPage() {
  const searchParams = useSearchParams();
  const threadId = searchParams.get("t");
  // NOT keyed by threadId: sending the first message of a new chat replaces
  // the URL with ?t=<id>, and a key change there would unmount the workspace
  // mid-stream — destroying the optimistic messages and the SSE reader.
  // ChatWorkspace reloads history itself when threadId changes.
  return <ChatWorkspace threadId={threadId} />;
}

export default function Home() {
  return (
    <Suspense>
      <ChatPage />
    </Suspense>
  );
}
