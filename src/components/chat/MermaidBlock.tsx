"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Code, Download, Image as ImageIcon } from "lucide-react";
import { CodeBlock } from "./CodeBlock";

let mermaidId = 0;

// Renders ```mermaid fences as live diagrams (sequence, flowchart, ER, …) —
// the ChatGPT-style visual, but as a crisp interactive SVG with downloads.
export function MermaidBlock({ code }: { code: string }) {
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    // Debounce: while streaming, partial diagrams fail to parse — wait for
    // the code to stabilize before rendering.
    const t = setTimeout(async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: resolvedTheme === "dark" ? "dark" : "default",
          securityLevel: "strict",
          // Never inject mermaid's bomb error SVG into the page body.
          suppressErrorRendering: true,
          // Labels must be real <text>, not <foreignObject>. Chrome taints a
          // canvas when it draws an SVG containing foreignObject, which makes
          // PNG export throw "Tainted canvases may not be exported".
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          class: { htmlLabels: false },
        });
        const id = `mmd-${++mermaidId}`;
        const { svg } = await mermaid.render(id, code);
        if (!cancelled) setSvg(svg);
      } catch {
        // Older mermaid paths can still leave an orphan error node — scrub it.
        document.querySelectorAll("[id^='dmmd-'], [id^='mmd-']").forEach((el) => {
          if (!el.closest("[data-mermaid-host]")) el.remove();
        });
        if (!cancelled) {
          setSvg(null);
          setFailed(true);
        }
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [code, resolvedTheme]);

  const downloadSvg = () => {
    if (!svg) return;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "diagram.svg";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadPng = () => {
    const el = containerRef.current?.querySelector("svg");
    if (!el || !svg) return;
    const rect = el.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    // Rasterize the rendered SVG with explicit dimensions, from a data URL —
    // same-origin, so nothing taints the canvas.
    const clone = el.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    const serialized = new XMLSerializer().serializeToString(clone);
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;

    const img = new Image();
    img.onload = () => {
      try {
        const scale = 2;
        const canvas = document.createElement("canvas");
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = resolvedTheme === "dark" ? "#18181d" : "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((png) => {
          if (!png) return downloadSvg();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(png);
          a.download = "diagram.png";
          a.click();
          URL.revokeObjectURL(a.href);
        });
      } catch {
        // Some diagrams still can't be rasterized in-browser; the vector
        // export always works, so fall back rather than throwing.
        downloadSvg();
      }
    };
    img.onerror = () => downloadSvg();
    img.src = url;
  };

  // Parse failure (or still streaming): show the code fence instead.
  if (failed || !svg) {
    return <CodeBlock code={code} language="mermaid" filename="mermaid" startCollapsed={false} />;
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border-app">
      <div className="flex items-center justify-between bg-surface-2 px-3 py-1.5">
        <span className="font-mono text-[11px] text-muted">diagram</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowCode((v) => !v)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-foreground cursor-pointer"
          >
            <Code className="size-3" /> {showCode ? "Diagram" : "Code"}
          </button>
          <button
            onClick={downloadSvg}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-foreground cursor-pointer"
          >
            <Download className="size-3" /> SVG
          </button>
          <button
            onClick={downloadPng}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-foreground cursor-pointer"
          >
            <ImageIcon className="size-3" /> PNG
          </button>
        </div>
      </div>
      {showCode ? (
        <pre className="overflow-x-auto bg-surface p-3 text-xs">{code}</pre>
      ) : (
        <div
          ref={containerRef}
          className="flex justify-center overflow-x-auto bg-surface p-4 [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}
