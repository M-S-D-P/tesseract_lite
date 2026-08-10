"use client";

import { useEffect, useState } from "react";
import { Download, ExternalLink, FileText, X, Quote } from "lucide-react";
import { Badge, Spinner } from "../ui";
import { CodeBlock, languageForPath } from "./CodeBlock";

export type Citation = {
  name: string;
  documentId?: string;
  path?: string | null;
  url?: string | null;
  snippets?: string[];
};

// Slide-over that proves grounding: shows the retrieved snippets the model
// actually saw, plus the cited file's full content with expand/download.
export function SourceViewer({
  citation,
  onClose,
}: {
  citation: Citation;
  onClose: () => void;
}) {
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-2xl flex-col border-l border-border-app bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border-app px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FileText className="size-4 shrink-0 text-accent" />
              <span className="truncate font-mono text-sm font-medium">
                {citation.path ?? citation.name}
              </span>
            </div>
            {data?.resourceName && (
              <div className="mt-1">
                <Badge tone="accent">{data.resourceName}</Badge>{" "}
                {data.lines != null && <Badge>{data.lines} lines</Badge>}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {citation.url && (
              <a
                href={citation.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-accent hover:bg-surface-2"
                title="Open in Confluence"
              >
                <ExternalLink className="size-3.5" /> Open page
              </a>
            )}
            {downloadUrl && (
              <a
                href={downloadUrl}
                className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-foreground"
                title="Download source file"
              >
                <Download className="size-4" />
              </a>
            )}
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-foreground cursor-pointer"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {citation.snippets && citation.snippets.length > 0 && (
            <section className="mb-4">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                <Quote className="size-3" /> Retrieved passages (what the model saw)
              </div>
              {citation.snippets.map((snip, i) => (
                <blockquote
                  key={i}
                  className="mb-2 whitespace-pre-wrap rounded-lg border-l-2 border-accent bg-accent-soft/40 px-3 py-2 font-mono text-[12px] leading-relaxed"
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
      </div>
    </div>
  );
}
