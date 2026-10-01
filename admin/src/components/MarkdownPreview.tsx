"use client";

import { Fragment } from "react";
import { parseMarkdown, type Inline } from "@/lib/blog";

/**
 * A preview of an article body: Markdown is parsed into blocks (lib/blog.ts)
 * and rendered as React elements — never as injected HTML, so nothing an AI
 * wrote can run here. Approximates the site's rendering; it is not the site.
 */
function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === "strong") return <strong key={i}>{p.text}</strong>;
        if (p.kind === "code") return <code key={i} style={{ fontSize: "0.92em", background: "var(--color-neutral-100)", padding: "0 3px", borderRadius: 3 }}>{p.text}</code>;
        if (p.kind === "link") return <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">{p.text}</a>;
        return <Fragment key={i}>{p.text}</Fragment>;
      })}
    </>
  );
}

export function MarkdownPreview({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown);
  return (
    <div style={{ fontSize: 14.5, lineHeight: 1.7 }}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h2": return <h2 key={i} style={{ fontSize: 19, fontWeight: 500, margin: "22px 0 8px" }}><Inlines parts={b.inline} /></h2>;
          case "h3": return <h3 key={i} style={{ fontSize: 16.5, fontWeight: 500, margin: "18px 0 6px" }}><Inlines parts={b.inline} /></h3>;
          case "h4": return <h4 key={i} style={{ fontSize: 15, fontWeight: 500, margin: "14px 0 6px" }}><Inlines parts={b.inline} /></h4>;
          case "p": return <p key={i} style={{ margin: "0 0 12px" }}><Inlines parts={b.inline} /></p>;
          case "quote": return <blockquote key={i} style={{ margin: "0 0 12px", paddingLeft: 12, borderLeft: "3px solid var(--color-divider)", color: "var(--color-neutral-700)" }}><Inlines parts={b.inline} /></blockquote>;
          case "code": return <pre key={i} style={{ margin: "0 0 12px", padding: 12, background: "var(--color-neutral-100)", borderRadius: 4, overflowX: "auto", fontSize: 12.5 }}>{b.text}</pre>;
          // eslint-disable-next-line @next/next/no-img-element -- remote, already-optimised WebP from the blog store
          case "img": return <img key={i} src={b.src} alt={b.alt} style={{ maxWidth: "100%", height: "auto", borderRadius: 4, margin: "4px 0 12px" }} />;
          case "ul": return <ul key={i} style={{ margin: "0 0 12px", paddingLeft: 22 }}>{b.items.map((it, j) => <li key={j}><Inlines parts={it} /></li>)}</ul>;
          case "ol": return <ol key={i} style={{ margin: "0 0 12px", paddingLeft: 22 }}>{b.items.map((it, j) => <li key={j}><Inlines parts={it} /></li>)}</ol>;
        }
      })}
    </div>
  );
}
