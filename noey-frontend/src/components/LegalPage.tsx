import type { ReactNode } from "react";
import { formatThaiDate } from "@/lib/format";
import { breadcrumbNode, jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { LEGAL_PAGES_ARE_DRAFTS, PAGES, type PageKey } from "@/lib/site";
import { Breadcrumb } from "./Breadcrumb";
import { JsonLd } from "./JsonLd";

/** Shared frame for /terms and /privacy, with the unmissable draft banner. */
export function LegalPage({ pageKey, title, children }: { pageKey: Extract<PageKey, "terms" | "privacy">; title: string; children: ReactNode }) {
  const page = PAGES[pageKey];
  const trail = [
    { name: PAGES.home.label, path: PAGES.home.path },
    { name: page.label, path: page.path },
  ];
  return (
    <main id="main" className="container page">
      <article className="legal">
        <Breadcrumb trail={trail} />
        <h1 className="page-title">{title}</h1>
        {LEGAL_PAGES_ARE_DRAFTS ? (
          <div className="notice notice--warn draft-banner" role="note">
            <p>
              <strong>ฉบับร่าง — ยังไม่มีผลบังคับใช้</strong>
            </p>
            <p>
              เอกสารนี้เป็นร่างตั้งต้นที่รอเจ้าของบริการและที่ปรึกษากฎหมายตรวจทาน ข้อความในวงเล็บเหลี่ยม [ ] คือส่วนที่ยังต้องเติม
              เนื้อหาอาจเปลี่ยนก่อนประกาศใช้จริง
            </p>
          </div>
        ) : null}
        <p className="updated" style={{ marginTop: 0 }}>
          ปรับปรุงล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time>
        </p>
        {children}
      </article>
      <JsonLd
        data={jsonLdGraph(
          webPageNode({ path: page.path, name: page.title, description: page.description, dateModified: page.updated }),
          breadcrumbNode(trail),
        )}
      />
    </main>
  );
}

/** Marks text the owner still has to fill in. */
export function Fill({ children }: { children: ReactNode }) {
  return <span className="placeholder">[{children}]</span>;
}
