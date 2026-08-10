"use client";

import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { MermaidBlock } from "./MermaidBlock";

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="prose-chat text-[15px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          table: (props) => (
            <div className="my-2 overflow-x-auto rounded-lg border border-border-app">
              <table {...props} className="!my-0 min-w-full" />
            </div>
          ),
          pre: (props) => {
            // Fenced code → rich block with copy/collapse/highlighting.
            const child = props.children as {
              props?: { className?: string; children?: ReactNode };
            };
            const className = child?.props?.className ?? "";
            const language = /language-(\w+)/.exec(className)?.[1];
            const code = extractText(child?.props?.children).replace(/\n$/, "");
            if (language === "mermaid") return <MermaidBlock code={code} />;
            return <CodeBlock code={code} language={language} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
