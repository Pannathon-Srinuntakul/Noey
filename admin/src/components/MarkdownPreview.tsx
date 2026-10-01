"use client";

import { Fragment } from "react";
import { parseMarkdown, type Inline, type PostMedia } from "@/lib/blog";

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

const frame: React.CSSProperties = {
  display: "grid", placeItems: "center", gap: 6, margin: "4px 0 12px", padding: 16, borderRadius: 4, textAlign: "center",
  border: "1px dashed var(--color-divider)", background: "var(--color-neutral-100)", color: "var(--color-neutral-700)", fontSize: 13,
};

/**
 * `media`: the post's media list, for a visual's size and a clip's poster.
 * A visual is not framed here: the embed origin lets only the site frame it
 * (frame-ancestors) — the preview shows its place, size and a link instead.
 */
export function MarkdownPreview({ markdown, media = [] }: { markdown: string; media?: PostMedia[] }) {
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
          case "visual": {
            const v = media.find((m) => m.type === "visual" && m.id === b.id);
            return (
              <div key={i} style={{ ...frame, aspectRatio: v?.width && v?.height ? `${v.width} / ${v.height}` : "16 / 10" }}>
                <span style={{ fontWeight: 500 }}>ภาพประกอบ HTML{v?.animated ? " · เคลื่อนไหว" : ""}{v?.width ? ` · ${v.width}×${v.height}` : ""}</span>
                <span>{b.alt}</span>
                {v?.src ? <a href={v.src} target="_blank" rel="noopener noreferrer">เปิดดูภาพ</a> : <span style={{ color: "var(--color-neutral-500)" }}>ไม่พบภาพนี้</span>}
                {v?.caption ? <span style={{ color: "var(--color-neutral-600)" }}>คำบรรยาย: {v.caption}</span> : null}
              </div>
            );
          }
          case "video": {
            const v = media.find((m) => m.type === "video" && m.url === b.src);
            return (
              <div key={i} style={{ margin: "4px 0 12px" }}>
                {v?.poster_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the clip's poster from the blog store
                  <img src={v.poster_url} alt={b.alt} style={{ maxWidth: "100%", height: "auto", borderRadius: 4, display: "block" }} />
                ) : (
                  <div style={frame}>คลิปวิดีโอ</div>
                )}
                <p className="small" style={{ margin: "4px 0 0" }}>คลิปวิดีโอ (เล่นวนแบบปิดเสียงบนหน้าเว็บ): {b.alt} · <a href={b.src} target="_blank" rel="noopener noreferrer">เปิดคลิป</a></p>
              </div>
            );
          }
          case "ul": return <ul key={i} style={{ margin: "0 0 12px", paddingLeft: 22 }}>{b.items.map((it, j) => <li key={j}><Inlines parts={it} /></li>)}</ul>;
          case "ol": return <ol key={i} style={{ margin: "0 0 12px", paddingLeft: 22 }}>{b.items.map((it, j) => <li key={j}><Inlines parts={it} /></li>)}</ol>;
        }
      })}
    </div>
  );
}
