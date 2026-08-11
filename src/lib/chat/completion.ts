import fs from "fs";
import path from "path";
import { getDb, uid, UPLOADS_DIR } from "../db";
import { resolveModel, type ReasoningTier } from "../models";
import { getNumSetting, getSetting } from "../settings";
import { recordMetric } from "../metrics";
import { searchLocal, hasLocalChunks } from "../rag/local";
import { graphHasData, queryAppGraph } from "../rails-graph";
import {
  generateFile,
  type FileSpec,
} from "../filegen";
import { answerWithoutTools, providerConfigured, runAnthropic } from "./providers";

export type Attachment = {
  kind: "image" | "document";
  name: string;
  path?: string; // relative to UPLOADS_DIR, for images
  documentId?: string;
  mime?: string;
};

export type StreamEvent =
  | { type: "created"; userMessageId: string; assistantMessageId: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | { type: "file"; file: { name: string; url: string } }
  | {
      type: "citations";
      items: {
        name: string;
        documentId?: string;
        path?: string | null;
        url?: string | null;
        snippets?: string[];
      }[];
    }
  | {
      type: "done";
      threadTitle?: string;
      meta?: { model: string; backend: string; scope?: number; fallback?: boolean };
    }
  | { type: "error"; message: string };

type Emit = (e: StreamEvent) => void;

function imageToB64(relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(UPLOADS_DIR, relPath)).toString("base64");
  } catch {
    return null;
  }
}

export async function runCompletion(opts: {
  threadId: string;
  userId: string;
  orgId: string;
  message: string;
  reasoning: ReasoningTier;
  webSearch: boolean;
  model?: string; // per-thread override; tier still controls reasoning depth
  resourceIds?: string[]; // facet scope: restrict retrieval to these resources
  attachments: Attachment[];
  emit: Emit;
  signal?: AbortSignal;
}) {
  const db = getDb();
  const thread = db
    .prepare("SELECT * FROM threads WHERE id = ? AND user_id = ?")
    .get(opts.threadId, opts.userId) as { id: string; title: string } | undefined;
  if (!thread) throw new Error("Thread not found");

  const userMessageId = uid();
  const assistantMessageId = uid();
  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, attachments) VALUES (?, ?, 'user', ?, ?)"
  ).run(userMessageId, opts.threadId, opts.message, JSON.stringify(opts.attachments));
  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, status) VALUES (?, ?, 'assistant', '', 'streaming')"
  ).run(assistantMessageId, opts.threadId);
  opts.emit({ type: "created", userMessageId, assistantMessageId });

  const resolved = resolveModel(opts.orgId, opts.reasoning);
  const model = opts.model?.trim() || resolved.model;
  const effort = resolved.effort;
  const hasChunks = await hasLocalChunks(opts.orgId, opts.threadId, opts.userId);

  // Lite retrieves from the local vector index only — there is no hosted
  // vector store to switch to.
  const backend = "local";
  try {
    const filters = JSON.parse(
      (db.prepare("SELECT filters FROM threads WHERE id = ?").get(opts.threadId) as {
        filters: string;
      }).filters || "{}"
    );
    if (opts.model?.trim()) filters.model = opts.model.trim();
    else delete filters.model;
    if (opts.resourceIds?.length) filters.resourceIds = opts.resourceIds;
    else delete filters.resourceIds;
    db.prepare("UPDATE threads SET filters = ? WHERE id = ?").run(
      JSON.stringify(filters),
      opts.threadId
    );
  } catch {
    /* filters persistence is best-effort */
  }

  const localCitations = new Map<
    string,
    {
      name: string;
      documentId?: string;
      path?: string | null;
      url?: string | null;
      snippets?: string[];
    }
  >();
  const addCitation = (
    name: string,
    documentId: string | undefined,
    filePath: string | null | undefined,
    snippet?: string,
    url?: string | null
  ) => {
    const existing = localCitations.get(name) ?? {
      name,
      documentId,
      path: filePath ?? null,
      url: url ?? null,
      snippets: [],
    };
    if (url && !existing.url) existing.url = url;
    if (snippet && (existing.snippets?.length ?? 0) < 2) {
      existing.snippets = [...(existing.snippets ?? []), snippet.slice(0, 700)];
    }
    localCitations.set(name, existing);
  };

  let fullText = "";
  let status: "done" | "stopped" | "error" = "done";
  let errorMessage: string | null = null;
  let usedFallback = false;
  const generatedFiles: { name: string; url: string }[] = [];

  const executeSharedTool = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<string> => {
    if (name === "generate_file") {
      try {
        const file = await generateFile(
          opts.orgId,
          opts.threadId,
          args as unknown as FileSpec
        );
        generatedFiles.push({ name: file.name, url: file.url });
        opts.emit({ type: "file", file: { name: file.name, url: file.url } });
        return JSON.stringify({
          created: file.name,
          note: "Attached to your answer — the user can download it.",
        });
      } catch (e) {
        return JSON.stringify({ error: (e as Error).message });
      }
    }
    if (name === "query_app_graph") {
      return JSON.stringify(
        queryAppGraph(opts.orgId, {
          action: String(args.action ?? "overview"),
          name: args.name ? String(args.name) : undefined,
          kind: args.kind ? String(args.kind) : undefined,
        })
      );
    }
    const query = String(args.query ?? "");
    const results = await searchLocal(opts.orgId, query, {
      threadId: opts.threadId,
      userId: opts.userId,
      k: getNumSetting(opts.orgId, "retrieval_k") || 8,
      resourceIds: opts.resourceIds,
    });
    for (const r of results) {
      addCitation(r.sourceLabel, r.documentId, r.path, r.content, r.url);
    }
    return JSON.stringify(
      results.map((r) => ({
        source: r.sourceLabel,
        ...(r.url ? { url: r.url } : {}),
        content: r.content,
      }))
    );
  };

  // Plain RAG: retrieve ourselves and answer in one toolless call. The agentic
  // loop is better when it works, but this always produces a grounded answer
  // instead of an error.
  const ragFallback = async (): Promise<boolean> => {
    try {
      const k = (getNumSetting(opts.orgId, "retrieval_k") || 8) * 2;
      const results = await searchLocal(opts.orgId, opts.message, {
        threadId: opts.threadId,
        userId: opts.userId,
        k,
        resourceIds: opts.resourceIds,
      });
      for (const r of results) {
        addCitation(r.sourceLabel, r.documentId, r.path, r.content, r.url);
      }
      const context = results
        .map(
          (r, i) =>
            `[${i + 1}] ${r.sourceLabel}${r.path ? ` — ${r.path}` : ""}\n${r.content}`
        )
        .join("\n\n---\n\n");

      opts.emit({ type: "tool", name: "knowledge_base" });
      usedFallback = true;
      const text = await answerWithoutTools({
        orgId: opts.orgId,
        model,
        tier: effort,
        systemPrompt:
          getSetting(opts.orgId, "system_prompt") +
          "\n\nAnswer from the CONTEXT below and the evidence in the user's message. Cite sources by name. If the context is insufficient, say what is missing rather than guessing.",
        userText: `CONTEXT FROM THE KNOWLEDGE BASE:\n\n${context}\n\n---\n\n${opts.message}`,
        signal: opts.signal,
      });
      if (!text) return false;
      fullText += text;
      opts.emit({ type: "delta", text });
      return true;
    } catch {
      return false;
    }
  };

  try {
    const configError = providerConfigured();
    if (configError) throw new Error(configError);

    const history = db
      .prepare(
        `SELECT role, content FROM messages
         WHERE thread_id = ? AND id NOT IN (?, ?) AND content != ''
         ORDER BY created_at, rowid`
      )
      .all(opts.threadId, userMessageId, assistantMessageId) as {
      role: "user" | "assistant";
      content: string;
    }[];

    const images = opts.attachments
      .filter((a) => a.kind === "image" && a.path)
      .map((a) => ({ mime: a.mime || "image/png", dataB64: imageToB64(a.path!) }))
      .filter((i): i is { mime: string; dataB64: string } => Boolean(i.dataB64));

    const docNames = opts.attachments
      .filter((a) => a.kind === "document")
      .map((a) => a.name);
    const userText =
      docNames.length > 0
        ? `${opts.message}\n\n[Attached files: ${docNames.join(", ")}]`
        : opts.message;

    await runAnthropic({
      orgId: opts.orgId,
      model,
      tier: effort,
      systemPrompt:
        getSetting(opts.orgId, "system_prompt") +
        (opts.webSearch
          ? "\n\nThe user enabled web search for this message — use the web search tool whenever current or external information would improve the answer."
          : ""),
      webSearch: opts.webSearch,
      history,
      userText,
      images,
      enableKbTool: hasChunks,
      enableGraphTool: graphHasData(opts.orgId),
      executeTool: executeSharedTool,
      emitDelta: (text) => {
        fullText += text;
        opts.emit({ type: "delta", text });
      },
      emitTool: (name) => opts.emit({ type: "tool", name }),
      signal: opts.signal,
    });
    recordMetric(opts.orgId, "chat_requests", 1, model);

    // The model finished without producing anything (tool budget exhausted or
    // an empty turn) — fall back to plain retrieval rather than a blank answer.
    if (!fullText.trim() && hasChunks) await ragFallback();
  } catch (e) {
    if (opts.signal?.aborted) {
      status = "stopped";
    } else {
      status = "error";
      errorMessage = (e as Error).message;
      const recovered = hasChunks ? await ragFallback() : false;
      if (recovered) {
        status = "done";
        errorMessage = null;
      } else {
        opts.emit({ type: "error", message: errorMessage });
      }
    }
  }

  const citations = Array.from(localCitations.values()).slice(0, 12);
  if (citations.length > 0) opts.emit({ type: "citations", items: citations });

  if (generatedFiles.length > 0) {
    db.prepare("UPDATE messages SET attachments = ? WHERE id = ?").run(
      JSON.stringify(generatedFiles.map((f) => ({ kind: "generated", ...f }))),
      assistantMessageId
    );
  }
  const responseMeta = {
    model,
    backend,
    ...(usedFallback ? { fallback: true } : {}),
    ...(opts.resourceIds?.length ? { scope: opts.resourceIds.length } : {}),
  };
  db.prepare(
    "UPDATE messages SET content = ?, citations = ?, status = ?, meta = ? WHERE id = ?"
  ).run(
    fullText,
    JSON.stringify(citations),
    status,
    JSON.stringify(responseMeta),
    assistantMessageId
  );
  db.prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?").run(
    opts.threadId
  );

  let threadTitle: string | undefined;
  if (thread.title === "New chat") {
    threadTitle = opts.message.slice(0, 60) + (opts.message.length > 60 ? "…" : "");
    db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(threadTitle, opts.threadId);
  }
  if (status !== "error") opts.emit({ type: "done", threadTitle, meta: responseMeta });
}
