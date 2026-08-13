"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  Square,
  Paperclip,
  Globe,
  BrainCircuit,
  Cloud,
  Database,
  Sparkles,
  FileText,
  Image as ImageIcon,
  X,
  BookOpenText,
  FolderGit2,
  BookOpen,
  FolderUp,
  History,
  Plus,
  Trash2,
  Quote,
  PanelRightClose,
} from "lucide-react";
import { Badge, Button, Spinner, cx, threadsChanged } from "../ui";
import TopBar from "../TopBar";
import { Markdown } from "./Markdown";
import { type Citation } from "./SourceViewer";
import { CodeBlock, languageForPath } from "./CodeBlock";

type Attachment = {
  kind: "image" | "document" | "generated";
  name: string;
  path?: string;
  documentId?: string;
  mime?: string;
  url?: string;
};

type ResponseMeta = {
  model?: string;
  backend?: string;
  scope?: number;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  citations?: Citation[];
  status?: string;
  meta?: ResponseMeta;
};

type Facet = {
  id: string;
  name: string;
  type: string;
  status: string;
  sync: { total: number; openai_synced: number; local_synced: number };
};

type Thread = { id: string; title: string; updated_at: string };

type Tier = "low" | "medium" | "high";
const TIER_LABELS: Record<Tier, string> = { low: "Fast", medium: "Balanced", high: "Deep" };

const FACET_ICONS: Record<string, typeof FolderGit2> = {
  github: FolderGit2,
  confluence: BookOpen,
  folder: FolderUp,
  file: FileText,
};

export default function ChatWorkspace({ threadId }: { threadId: string | null }) {
  const router = useRouter();

  // --- conversation state
  const [messages, setMessages] = useState<Message[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [input, setInput] = useState("");
  const [reasoning, setReasoning] = useState<Tier>("medium");
  const [webSearch, setWebSearch] = useState(false);
  const [model, setModel] = useState<string>("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelGroups, setModelGroups] = useState<{ provider: string; models: string[] }[]>([]);
  const [modelQuery, setModelQuery] = useState("");
  const [tierMenuOpen, setTierMenuOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  // The history fetch is async; auto-send must not race it or the optimistic
  // messages get overwritten by the (empty) server list mid-stream.
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // Thread ids created by this component for a message already on screen.
  const selfCreatedRef = useRef<string | null>(null);
  // A handed-off question must fire once, not on every re-render.
  const autoAskedRef = useRef(false);

  // --- facets rail
  const [facets, setFacets] = useState<Facet[]>([]);
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [brainStats, setBrainStats] = useState<{ chunks: number; entities: number } | null>(null);

  // --- evidence rail
  const [evidence, setEvidence] = useState<Citation | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    const res = await fetch("/api/threads");
    if (res.ok) setThreads((await res.json()).threads);
  }, []);

  useEffect(() => {
    loadThreads();
    const onChange = () => loadThreads();
    window.addEventListener("tesseract:threads-changed", onChange);
    return () => window.removeEventListener("tesseract:threads-changed", onChange);
  }, [loadThreads]);

  useEffect(() => {
    fetch("/api/models").then(async (r) => {
      if (r.ok) setModelGroups((await r.json()).groups ?? []);
    });
    fetch("/api/resources").then(async (r) => {
      if (r.ok) {
        const d = await r.json();
        setFacets(d.resources ?? []);
      }
    });
    fetch("/api/metrics").then(async (r) => {
      if (r.ok) {
        const d = await r.json();
        setBrainStats({ chunks: d.sources?.chunks ?? 0, entities: d.graph?.entities ?? 0 });
      }
    });
  }, [router]);

  // Load history when the thread changes — except when the id arrived because
  // WE just created the thread for the message currently streaming.
  useEffect(() => {
    if (threadId && selfCreatedRef.current === threadId) {
      selfCreatedRef.current = null;
      setHistoryLoaded(true);
      return;
    }
    setHistoryLoaded(false);
    setMessages([]);
    setPendingAttachments([]);
    setEvidence(null);
    if (!threadId) {
      setHistoryLoaded(true);
      return;
    }
    fetch(`/api/threads/${threadId}`).then(async (res) => {
      if (!res.ok) return setHistoryLoaded(true);
      const data = await res.json();
      try {
        const filters = JSON.parse(data.thread?.filters || "{}");
        if (typeof filters.model === "string") setModel(filters.model);
        if (Array.isArray(filters.resourceIds)) setScopeIds(filters.resourceIds);
      } catch {
        /* ignore */
      }
      setMessages(
        data.messages.map(
          (m: Message & { attachments: string; citations: string; meta: string }) => ({
            ...m,
            attachments: JSON.parse(m.attachments || "[]"),
            citations: JSON.parse(m.citations || "[]"),
            meta: (() => {
              try {
                return JSON.parse(m.meta || "{}");
              } catch {
                return {};
              }
            })(),
          })
        )
      );
      setHistoryLoaded(true);
    });
  }, [threadId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  // /live hands off a question here: it creates the thread server-side with the
  // runtime evidence already composed, then navigates. We send it exactly once.
  useEffect(() => {
    if (!threadId || autoAskedRef.current || streaming) return;
    const raw = sessionStorage.getItem("tesseract:autoAsk");
    if (!raw) return;
    try {
      const pending = JSON.parse(raw) as { threadId: string; message: string };
      if (pending.threadId !== threadId) return;
      sessionStorage.removeItem("tesseract:autoAsk");
      autoAskedRef.current = true;
      setInput(pending.message);
      // Let the composer state settle before firing.
      setTimeout(() => sendRef.current?.(pending.message), 60);
    } catch {
      sessionStorage.removeItem("tesseract:autoAsk");
    }
  }, [threadId, streaming]);

  const ensureThread = useCallback(async (): Promise<string> => {
    if (threadId) return threadId;
    const res = await fetch("/api/threads", { method: "POST" });
    const { id } = await res.json();
    threadsChanged();
    // Marks the id as ours so the history effect below leaves the in-flight
    // conversation alone when the URL updates.
    selfCreatedRef.current = id;
    router.replace(`/?t=${id}`);
    return id;
  }, [threadId, router]);

  const newChat = async () => {
    const res = await fetch("/api/threads", { method: "POST" });
    if (res.ok) {
      const { id } = await res.json();
      threadsChanged();
      setThreadMenuOpen(false);
      router.push(`/?t=${id}`);
    }
  };

  const deleteThread = async (id: string) => {
    await fetch(`/api/threads/${id}`, { method: "DELETE" });
    threadsChanged();
    if (threadId === id) router.push("/");
  };

  const attachFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const tid = await ensureThread();
      const form = new FormData();
      for (const f of Array.from(files)) form.append("files", f);
      const res = await fetch(`/api/threads/${tid}/attachments`, { method: "POST", body: form });
      if (res.ok) {
        const data = await res.json();
        setPendingAttachments((prev) => [...prev, ...data.attachments]);
      } else {
        alert((await res.json()).error ?? "Upload failed");
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const sendRef = useRef<((override?: string) => void) | null>(null);

  const send = async (override?: string): Promise<void> => {
    const text = (override ?? input).trim();
    if (!text || streaming || uploading) return;
    setInput("");
    const attachments = pendingAttachments;
    setPendingAttachments([]);
    setStreaming(true);
    setToolStatus(null);

    const tid = await ensureThread();
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", content: text, attachments },
      { id: `a-${Date.now()}`, role: "assistant", content: "", status: "streaming" },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/threads/${tid}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          reasoning,
          webSearch,
          model: model || undefined,
          resourceIds: scopeIds.length > 0 ? scopeIds : undefined,
          attachments,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const err = res.headers.get("content-type")?.includes("json")
          ? (await res.json()).error
          : `Request failed (${res.status})`;
        throw new Error(err);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (event.type === "created") {
            setMessages((prev) => {
              const next = [...prev];
              if (next.length >= 2) {
                next[next.length - 2] = { ...next[next.length - 2], id: event.userMessageId };
                next[next.length - 1] = { ...next[next.length - 1], id: event.assistantMessageId };
              }
              return next;
            });
          } else if (event.type === "delta") {
            setToolStatus(null);
            setMessages((prev) => {
              if (prev.length === 0) return prev;
              const next = [...prev];
              const last = next[next.length - 1];
              next[next.length - 1] = { ...last, content: (last.content ?? "") + event.text };
              return next;
            });
          } else if (event.type === "tool") {
            setToolStatus(event.name);
          } else if (event.type === "file") {
            setMessages((prev) => {
              if (prev.length === 0) return prev;
              const next = [...prev];
              const last = next[next.length - 1];
              next[next.length - 1] = {
                ...last,
                attachments: [
                  ...(last.attachments ?? []),
                  { kind: "generated", name: event.file.name, url: event.file.url },
                ],
              };
              return next;
            });
          } else if (event.type === "citations") {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              next[next.length - 1] = { ...last, citations: event.items };
              return next;
            });
          } else if (event.type === "done") {
            if (event.threadTitle) threadsChanged();
            if (event.meta) {
              setMessages((prev) => {
                if (prev.length === 0) return prev;
                const next = [...prev];
                next[next.length - 1] = { ...next[next.length - 1], meta: event.meta };
                return next;
              });
            }
          } else if (event.type === "error") {
            setMessages((prev) => {
              if (prev.length === 0) return prev;
              const next = [...prev];
              const last = next[next.length - 1];
              next[next.length - 1] = {
                ...last,
                content: (last.content ?? "") + `\n\n> ⚠️ ${event.message}`,
              };
              return next;
            });
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = {
            ...last,
            content: last.content || `> ⚠️ ${(e as Error).message}`,
          };
          return next;
        });
      }
    } finally {
      setStreaming(false);
      setToolStatus(null);
      abortRef.current = null;
      setMessages((prev) =>
        prev.map((m) => (m.status === "streaming" ? { ...m, status: "done" } : m))
      );
    }
  };
  sendRef.current = send;

  const stop = () => abortRef.current?.abort();
  const empty = messages.length === 0;
  const currentThread = threads.find((t) => t.id === threadId);

  return (
    <div className="flex h-dvh flex-col">
      {/* ===== Top bar (shared shell) ===== */}
      <TopBar
        center={
          <div className="relative">
            <button
              onClick={() => setThreadMenuOpen((v) => !v)}
              className="flex max-w-md items-center gap-2 rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2 cursor-pointer"
            >
              <History className="size-3.5 text-muted" />
              <span className="truncate">{currentThread?.title ?? "New session"}</span>
            </button>
            {threadMenuOpen && (
              <div className="absolute left-1/2 top-10 z-30 flex max-h-96 w-80 -translate-x-1/2 flex-col rounded-xl border border-border-app bg-surface shadow-xl">
                <button
                  onClick={newChat}
                  className="flex items-center gap-2 border-b border-border-app px-3 py-2.5 text-sm font-medium text-accent hover:bg-surface-2 cursor-pointer"
                >
                  <Plus className="size-4" /> New session
                </button>
                <div className="min-h-0 flex-1 overflow-y-auto p-1">
                  {threads.map((t) => (
                    <div
                      key={t.id}
                      className={cx(
                        "group flex items-center rounded-lg text-sm",
                        threadId === t.id ? "bg-surface-2" : "hover:bg-surface-2"
                      )}
                    >
                      <Link
                        href={`/?t=${t.id}`}
                        onClick={() => setThreadMenuOpen(false)}
                        className="min-w-0 flex-1 truncate px-2.5 py-1.5"
                      >
                        {t.title}
                      </Link>
                      <button
                        onClick={() => deleteThread(t.id)}
                        className="mr-1 hidden rounded p-1 text-muted hover:text-danger group-hover:block cursor-pointer"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  {threads.length === 0 && (
                    <p className="px-3 py-4 text-center text-xs text-muted">No sessions yet</p>
                  )}
                </div>
              </div>
            )}
          </div>
        }
      />

      {/* ===== Workspace: facets | conversation | evidence ===== */}
      <div className="flex min-h-0 flex-1">
        {/* --- Facets rail --- */}
        <aside className="glass z-10 hidden w-72 shrink-0 flex-col border-r border-border-app lg:flex">
          <div className="flex items-center justify-between px-4 pb-1 pt-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Facets
            </span>
            <Link href="/facets" className="text-[11px] text-accent hover:underline">
              + Add
            </Link>
          </div>
          <p className="px-4 pb-2 text-[11px] text-muted">
            {scopeIds.length === 0
              ? "Answering from all facets"
              : `Scoped to ${scopeIds.length} facet${scopeIds.length === 1 ? "" : "s"}`}
            {scopeIds.length > 0 && (
              <button
                onClick={() => setScopeIds([])}
                className="ml-1.5 text-accent hover:underline cursor-pointer"
              >
                reset
              </button>
            )}
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {facets.map((f) => {
              const Icon = FACET_ICONS[f.type] ?? FileText;
              const inSync = f.sync && f.sync.openai_synced === f.sync.total && f.sync.local_synced === f.sync.total;
              const active = scopeIds.length === 0 || scopeIds.includes(f.id);
              return (
                <label
                  key={f.id}
                  className={cx(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-surface-2",
                    !active && "opacity-45"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={scopeIds.length === 0 ? true : scopeIds.includes(f.id)}
                    onChange={() => {
                      setScopeIds((prev) => {
                        // From "all" state, unchecking selects everything else.
                        if (prev.length === 0) {
                          return facets.filter((x) => x.id !== f.id).map((x) => x.id);
                        }
                        const next = prev.includes(f.id)
                          ? prev.filter((x) => x !== f.id)
                          : [...prev, f.id];
                        return next.length === facets.length ? [] : next;
                      });
                    }}
                    className="accent-[var(--accent)]"
                  />
                  <Icon className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span
                    className={cx(
                      "size-1.5 shrink-0 rounded-full",
                      f.status === "ready" && inSync
                        ? "bg-emerald-500"
                        : f.status === "error"
                          ? "bg-red-500"
                          : "bg-amber-500 animate-pulse"
                    )}
                    title={f.status}
                  />
                </label>
              );
            })}
            {facets.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted">
                No facets yet.{" "}
                <Link href="/facets" className="text-accent hover:underline">
                  Connect one
                </Link>
              </div>
            )}
          </div>
          {brainStats && (
            <div className="border-t border-border-app px-4 py-2.5 text-[11px] text-muted">
              {brainStats.chunks.toLocaleString()} chunks ·{" "}
              {brainStats.entities.toLocaleString()} graph entities
            </div>
          )}
        </aside>

        {/* --- Conversation column --- */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            {empty ? (
              <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
                <span className="tesseract-mark size-16" aria-hidden />
                <div>
                  <h1 className="text-2xl font-bold tracking-tight">
                    Ask the <span className="brand-text">brain</span>
                  </h1>
                  <p className="mx-auto mt-2 max-w-md text-sm text-muted">
                    Every answer is grounded in your facets, with inspectable
                    evidence — select facets on the left to narrow the scope.
                  </p>
                </div>
                <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-3">
                  {[
                    "How does authentication work in our codebase?",
                    "Summarize the runbook from Confluence",
                    "Draw a sequence diagram of the login flow",
                  ].map((q) => (
                    <button
                      key={q}
                      onClick={() => setInput(q)}
                      className="rounded-xl border border-border-app bg-surface/70 px-3 py-2.5 text-left text-xs text-foreground/80 hover:border-accent/50 hover:bg-surface cursor-pointer"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
                {messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    toolStatus={toolStatus}
                    onOpenSource={setEvidence}
                  />
                ))}
              </div>
            )}
          </div>

          {/* --- Query console --- */}
          <div className="px-4 pb-4">
            <div className="console-glow glass mx-auto max-w-3xl rounded-2xl border border-border-app shadow-lg transition-[box-shadow,border-color]">
              {pendingAttachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                  {pendingAttachments.map((a, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-xs"
                    >
                      {a.kind === "image" ? (
                        <ImageIcon className="size-3.5 text-muted" />
                      ) : (
                        <FileText className="size-3.5 text-muted" />
                      )}
                      <span className="max-w-40 truncate">{a.name}</span>
                      <button
                        onClick={() =>
                          setPendingAttachments((prev) => prev.filter((_, j) => j !== i))
                        }
                        className="text-muted hover:text-danger cursor-pointer"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={Math.min(6, Math.max(1, input.split("\n").length))}
                placeholder={
                  scopeIds.length > 0
                    ? `Ask across ${scopeIds.length} selected facet${scopeIds.length === 1 ? "" : "s"}…`
                    : "Ask across all facets…"
                }
                className="w-full resize-none bg-transparent px-4 pt-3 text-[15px] outline-none placeholder:text-muted"
              />
              <div className="flex items-center gap-1 px-2.5 pb-2.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => attachFiles(e.target.files)}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-foreground cursor-pointer disabled:opacity-50"
                >
                  {uploading ? <Spinner className="size-4" /> : <Paperclip className="size-4" />}
                </button>

                {/* model picker */}
                <div className="relative">
                  <button
                    onClick={() => setModelMenuOpen((v) => !v)}
                    className="flex max-w-44 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium cursor-pointer text-muted hover:bg-surface-2 hover:text-foreground"
                    title="Model — Auto follows the reasoning tier's configured model"
                  >
                    <Sparkles className="size-4 shrink-0" />
                    <span className="truncate">{model || "Auto"}</span>
                  </button>
                  {modelMenuOpen && (
                    <div className="absolute bottom-10 left-0 z-10 flex max-h-96 w-72 flex-col rounded-xl border border-border-app bg-surface shadow-lg">
                      <input
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                        placeholder="Search models…"
                        autoFocus
                        className="m-2 rounded-lg border border-border-app bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
                      />
                      <div className="min-h-0 flex-1 overflow-y-auto p-1 pt-0">
                        <button
                          onClick={() => {
                            setModel("");
                            setModelMenuOpen(false);
                          }}
                          className={cx(
                            "flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm cursor-pointer",
                            model === "" ? "bg-accent-soft" : "hover:bg-surface-2"
                          )}
                        >
                          Auto — use tier default
                        </button>
                        {modelGroups.map((g) => {
                          const filtered = g.models.filter((m) =>
                            m.toLowerCase().includes(modelQuery.toLowerCase())
                          );
                          if (filtered.length === 0) return null;
                          return (
                            <div key={g.provider}>
                              <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
                                {g.provider}
                              </div>
                              {filtered.slice(0, 30).map((m) => (
                                <button
                                  key={m}
                                  onClick={() => {
                                    setModel(m);
                                    setModelMenuOpen(false);
                                  }}
                                  className={cx(
                                    "flex w-full items-center rounded-lg px-2.5 py-1.5 text-left font-mono text-xs cursor-pointer",
                                    model === m ? "bg-accent-soft" : "hover:bg-surface-2"
                                  )}
                                >
                                  {m}
                                </button>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* reasoning tier */}
                <div className="relative">
                  <button
                    onClick={() => setTierMenuOpen((v) => !v)}
                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium cursor-pointer text-muted hover:bg-surface-2 hover:text-foreground"
                  >
                    <BrainCircuit className="size-4" />
                    {TIER_LABELS[reasoning]}
                  </button>
                  {tierMenuOpen && (
                    <div className="absolute bottom-10 left-0 z-10 w-44 rounded-xl border border-border-app bg-surface p-1 shadow-lg">
                      {(Object.keys(TIER_LABELS) as Tier[]).map((t) => (
                        <button
                          key={t}
                          onClick={() => {
                            setReasoning(t);
                            setTierMenuOpen(false);
                          }}
                          className={cx(
                            "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm cursor-pointer",
                            t === reasoning ? "bg-accent-soft" : "hover:bg-surface-2"
                          )}
                        >
                          {TIER_LABELS[t]}
                          <span className="text-[10px] uppercase text-muted">{t}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* web */}
                <button
                  onClick={() => setWebSearch((v) => !v)}
                  className={cx(
                    "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium cursor-pointer",
                    webSearch
                      ? "bg-accent-soft text-accent-hover dark:text-accent"
                      : "text-muted hover:bg-surface-2 hover:text-foreground"
                  )}
                >
                  <Globe className="size-4" /> Web
                </button>

                <div className="flex-1" />
                {streaming ? (
                  <Button onClick={stop} variant="outline" size="sm">
                    <Square className="size-3.5 fill-current" /> Stop
                  </Button>
                ) : (
                  <Button
                    onClick={() => send()}
                    size="sm"
                    disabled={!input.trim() || uploading}
                    className="brand-gradient rounded-full border-0 p-2 text-white"
                  >
                    <ArrowUp className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* --- Evidence rail --- */}
        {evidence && (
          <EvidencePanel citation={evidence} onClose={() => setEvidence(null)} />
        )}
      </div>
    </div>
  );
}


// Waiting state inside the answer card. A grounded answer can take 20+ seconds
// — a 16px spinner reads as "frozen", so this shows what is happening and how
// long it has been happening for.
function ThinkingIndicator({ toolStatus }: { toolStatus?: string | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, []);

  let label = "Thinking…";
  let Icon: typeof BookOpenText | null = null;
  if (toolStatus === "knowledge_base") {
    label = "Searching facets…";
    Icon = BookOpenText;
  } else if (toolStatus === "web_search") {
    label = "Searching the web…";
    Icon = Globe;
  } else if (toolStatus === "app_graph") {
    label = "Querying the app graph…";
  } else if (toolStatus === "generate_file") {
    label = "Generating file…";
  } else if (toolStatus?.startsWith("mcp:")) {
    label = `Calling ${toolStatus.slice(4)}…`;
  } else if (elapsed >= 8) {
    label = "Reading sources…";
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5 text-sm text-muted">
        <span className="flex gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 rounded-full bg-accent"
              style={{ animation: `thinking-dot 1.2s ${i * 0.16}s infinite ease-in-out` }}
            />
          ))}
        </span>
        {Icon && <Icon className="size-3.5" />}
        <span>{label}</span>
        {elapsed >= 3 && (
          <span className="tabular-nums text-xs text-muted/70">{elapsed}s</span>
        )}
      </div>
      <div className="flex flex-col gap-2" aria-hidden>
        {[100, 92, 74].map((w, i) => (
          <span
            key={i}
            className="h-2.5 rounded bg-surface-2"
            style={{ width: `${w}%`, animation: `thinking-shimmer 1.6s ${i * 0.2}s infinite` }}
          />
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  toolStatus,
  onOpenSource,
}: {
  message: Message;
  toolStatus?: string | null;
  onOpenSource: (c: Citation) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          {message.attachments && message.attachments.length > 0 && (
            <div className="mb-1 flex flex-wrap justify-end gap-1">
              {message.attachments.map((a, i) => (
                <Badge key={i} tone="neutral">
                  {a.kind === "image" ? "🖼 " : "📄 "}
                  {a.name}
                </Badge>
              ))}
            </div>
          )}
          <div className="rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[15px] whitespace-pre-wrap">
            {message.content}
          </div>
        </div>
      </div>
    );
  }
  const isRealId = !message.id.startsWith("a-") && !message.id.startsWith("u-");
  const doneWithContent = message.content && message.status !== "streaming";
  const meta = message.meta;
  return (
    <div className="group/msg flex flex-col gap-1.5">
      <div className="brief-card">
        <div className="brief-head">
          <span className="tesseract-mark size-3 shrink-0" aria-hidden />
          <span className="font-mono">{meta?.model ?? "tesseract"}</span>
          {meta?.scope ? (
            <span className="rounded bg-surface px-1.5 py-0.5">
              scoped · {meta.scope} facet{meta.scope === 1 ? "" : "s"}
            </span>
          ) : null}
          <span className="flex-1" />
          {doneWithContent && (
            <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100">
              <button
                onClick={() => navigator.clipboard.writeText(message.content)}
                className="rounded px-1.5 py-0.5 hover:bg-surface hover:text-foreground cursor-pointer"
              >
                Copy
              </button>
              {isRealId && (
                <>
                  <a
                    href={`/api/messages/${message.id}/export?format=pdf`}
                    className="rounded px-1.5 py-0.5 hover:bg-surface hover:text-foreground"
                  >
                    PDF
                  </a>
                  <a
                    href={`/api/messages/${message.id}/export?format=docx`}
                    className="rounded px-1.5 py-0.5 hover:bg-surface hover:text-foreground"
                  >
                    DOCX
                  </a>
                </>
              )}
            </span>
          )}
        </div>
        <div className="px-4 py-3">
          {message.content ? (
            <Markdown content={message.content} />
          ) : message.status === "streaming" ? (
            <ThinkingIndicator toolStatus={toolStatus} />
          ) : null}
        </div>
        {message.attachments?.some((a) => a.kind === "generated") && (
          <div className="flex flex-wrap gap-2 border-t border-border-app px-3 py-2.5">
            {message.attachments
              .filter((a) => a.kind === "generated")
              .map((a, i) => (
                <a
                  key={i}
                  href={a.url}
                  className="inline-flex items-center gap-2 rounded-lg border border-border-app bg-surface px-3 py-2 text-xs font-medium hover:border-accent"
                  title={`Download ${a.name}`}
                >
                  <span className="brand-gradient flex size-7 items-center justify-center rounded-md text-white">
                    <FileText className="size-3.5" />
                  </span>
                  <span>
                    <span className="block max-w-52 truncate">{a.name}</span>
                    <span className="block text-[10px] text-muted">
                      Click to download
                    </span>
                  </span>
                </a>
              ))}
          </div>
        )}
        {message.citations && message.citations.length > 0 && (
          <div className="border-t border-border-app bg-surface-2/40 px-3 py-2">
            <div className="flex flex-wrap gap-1.5">
              {message.citations.map((c, i) => (
                <button
                  key={i}
                  onClick={() => onOpenSource(c)}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border-app bg-surface px-2 py-1 font-mono text-[11px] text-foreground/85 hover:border-accent hover:text-foreground cursor-pointer"
                  title={`Inspect ${c.name}`}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent-hover dark:text-accent">
                    {i + 1}
                  </span>
                  <span className="truncate">{c.name}</span>
                  {c.url && <span className="shrink-0 text-accent">↗</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Docked evidence panel — the right rail replacing the modal viewer.
function EvidencePanel({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const [data, setData] = useState<{
    name: string;
    resourceName?: string | null;
    content: string | null;
    truncated?: boolean;
    lines?: number;
    note?: string;
  } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setData(null);
    setError("");
    if (!citation.documentId) {
      setError("No stored document for this source.");
      return;
    }
    const qs = citation.path ? `?path=${encodeURIComponent(citation.path)}` : "";
    fetch(`/api/documents/${citation.documentId}${qs}`).then(async (r) => {
      if (r.ok) setData(await r.json());
      else setError((await r.json()).error ?? "Could not load source");
    });
  }, [citation]);

  const downloadUrl = citation.documentId
    ? `/api/documents/${citation.documentId}/download${
        citation.path ? `?path=${encodeURIComponent(citation.path)}` : ""
      }`
    : null;

  return (
    <aside className="glass z-10 flex w-[28rem] shrink-0 flex-col border-l border-border-app">
      <div className="flex items-start justify-between gap-2 border-b border-border-app px-4 py-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Evidence
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <FileText className="size-3.5 shrink-0 text-accent" />
            <span className="truncate font-mono text-xs font-medium">
              {citation.path ?? citation.name}
            </span>
          </div>
          {data?.resourceName && (
            <div className="mt-1 flex items-center gap-1.5">
              <Badge tone="accent">{data.resourceName}</Badge>
              {data.lines != null && <Badge>{data.lines} lines</Badge>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center">
          {citation.url && (
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg p-1.5 text-accent hover:bg-surface-2"
              title="Open in Confluence"
            >
              ↗
            </a>
          )}
          {downloadUrl && (
            <a
              href={downloadUrl}
              className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-foreground"
              title="Download"
            >
              ⬇
            </a>
          )}
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-foreground cursor-pointer"
          >
            <PanelRightClose className="size-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {citation.snippets && citation.snippets.length > 0 && (
          <section className="mb-4">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              <Quote className="size-3" /> What the model saw
            </div>
            {citation.snippets.map((snip, i) => (
              <blockquote
                key={i}
                className="mb-2 whitespace-pre-wrap rounded-lg border-l-2 border-accent bg-accent-soft/40 px-3 py-2 font-mono text-[11.5px] leading-relaxed"
              >
                {snip}
              </blockquote>
            ))}
          </section>
        )}
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Full source
        </div>
        {!data && !error && (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        {data && data.content === null && (
          <p className="text-sm text-muted">{data.note ?? "Content unavailable."}</p>
        )}
        {data?.content && (
          <>
            <CodeBlock
              code={data.content}
              language={languageForPath(citation.path ?? data.name)}
              filename={citation.path ?? data.name}
              startCollapsed={false}
            />
            {data.truncated && (
              <p className="mt-1 text-xs text-muted">
                Preview truncated — download for the full file.
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
