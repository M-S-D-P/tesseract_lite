"use client";

import { useState } from "react";
import { useTheme } from "next-themes";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";

for (const [name, lang] of Object.entries({
  tsx, typescript, javascript, python, ruby, json, bash, sql, yaml, markup, css, go, java,
})) {
  SyntaxHighlighter.registerLanguage(name, lang);
}

const ALIASES: Record<string, string> = {
  ts: "typescript", js: "javascript", jsx: "javascript", py: "python",
  rb: "ruby", erb: "markup", html: "markup", xml: "markup", sh: "bash",
  zsh: "bash", shell: "bash", yml: "yaml", golang: "go",
};

export function languageForPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", json: "json", sh: "bash", bash: "bash",
    sql: "sql", yml: "yaml", yaml: "yaml", html: "markup", erb: "markup",
    xml: "markup", css: "css", go: "go", java: "java", md: "markup",
  };
  return map[ext] ?? "markup";
}

const COLLAPSE_LINES = 24;

export function CodeBlock({
  code,
  language,
  filename,
  startCollapsed,
}: {
  code: string;
  language?: string;
  filename?: string;
  startCollapsed?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n").length;
  const collapsible = lines > COLLAPSE_LINES;
  const [collapsed, setCollapsed] = useState(startCollapsed ?? collapsible);

  const lang = ALIASES[language ?? ""] ?? language ?? "markup";
  const shown =
    collapsed && collapsible ? code.split("\n").slice(0, COLLAPSE_LINES).join("\n") : code;

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group/code my-2 overflow-hidden rounded-lg border border-border-app">
      <div className="flex items-center justify-between bg-surface-2 px-3 py-1.5">
        <span className="truncate font-mono text-[11px] text-muted">
          {filename ?? lang}
        </span>
        <div className="flex items-center gap-1">
          {collapsible && (
            <button
              onClick={() => setCollapsed((v) => !v)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-foreground cursor-pointer"
            >
              {collapsed ? (
                <>
                  <ChevronDown className="size-3" /> Expand ({lines} lines)
                </>
              ) : (
                <>
                  <ChevronUp className="size-3" /> Collapse
                </>
              )}
            </button>
          )}
          <button
            onClick={copy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-foreground cursor-pointer"
          >
            {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <SyntaxHighlighter
        language={lang}
        style={resolvedTheme === "dark" ? oneDark : oneLight}
        customStyle={{ margin: 0, fontSize: "12.5px", background: "var(--surface)" }}
        showLineNumbers={lines > 4}
        lineNumberStyle={{ color: "var(--muted)", opacity: 0.5, minWidth: "2.2em" }}
      >
        {shown}
      </SyntaxHighlighter>
      {collapsed && collapsible && (
        <button
          onClick={() => setCollapsed(false)}
          className="w-full border-t border-border-app bg-surface-2 py-1 text-[11px] text-muted hover:text-foreground cursor-pointer"
        >
          … {lines - COLLAPSE_LINES} more lines
        </button>
      )}
    </div>
  );
}
