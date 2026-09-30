import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Breadcrumb } from "@/components/Breadcrumb";
import { FaqList } from "@/components/FaqList";
import { FitLists } from "@/components/FitLists";
import { JsonLd } from "@/components/JsonLd";
import { ClipCard } from "@/components/ds/ClipCard";
import { CtaBand } from "@/components/ds/CtaBand";
import { PageHero } from "@/components/ds/PageHero";
import { SectionHeader } from "@/components/ds/SectionHeader";
import { SCOPE_FAQ } from "@/lib/faq";
import { formatThaiDate } from "@/lib/format";
import { SOFTWARE_ID, breadcrumbNode, faqPageNode, jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { SCOPE_FITS, SCOPE_MISFITS, SCOPE_STEPS, SCOPE_SUMMARY, SCOPE_YOUR_WORK } from "@/lib/scope";
import { markdownTwinPath, pageMetadata, withMarkdownTwin } from "@/lib/seo";
import { PAGES } from "@/lib/site";
import "../../styles/pages/scope.css";
import { keepThaiProse } from "@/components/ds/ThaiText";

export const metadata: Metadata = withMarkdownTwin(pageMetadata("scope"), markdownTwinPath("scope"));

const TRAIL = [
  { name: PAGES.home.label, path: PAGES.home.path },
  { name: PAGES.scope.label, path: PAGES.scope.path },
];

const GUIDE_LINKS = [
  { href: PAGES.guideCut.path, label: "ตัดคลิป TikTok ด้วย AI ยังไง", note: "ขั้นตอนตั้งแต่ลากไฟล์จนดาวน์โหลด" },
  { href: PAGES.guideSubtitles.path, label: "ใส่ซับไทยอัตโนมัติในคลิป", note: "ซับมาจากไหน และแก้คำที่ถอดผิดยังไง" },
  { href: PAGES.guideReview.path, label: "ตัดคลิปรีวิวสินค้าให้เร็วขึ้น", note: "ถ่ายยังไงให้ระบบคัดช็อตได้ดี" },
  { href: PAGES.guideLongform.path, label: "ตัดคลิปยาวเป็นคลิปสั้นหลายตัว", note: "โหมดไฮไลต์และเพดานความยาวต่อแพลน" },
  { href: PAGES.guideHelp.path, label: "หน้าช่วยเหลือ", note: "โหมด ไฟล์ที่รองรับ โควตา และการแก้ปัญหา" },
];

/** The "your work" items in the order the handoff track plays them. */
const YOUR_WORK = SCOPE_YOUR_WORK.flat();

/**
 * What the system does and what stays the user's job. Replaced /examples
 * (Website v2, 2026-09-22): an honest scope page instead of one sample clip.
 *
 * Signature: the handoff timeline. One long track — the system's three steps,
 * the diagonal cut where the draft is handed over, then the work that stays
 * yours — played past a fixed playhead as you scroll (desktop), or read top
 * to bottom (phones, reduced motion, no JavaScript).
 */
export default function ScopePage() {
  const page = PAGES.scope;
  const jsonLd = jsonLdGraph(
    webPageNode({ path: page.path, name: page.title, description: page.description, dateModified: page.updated, about: SOFTWARE_ID }),
    breadcrumbNode(TRAIL),
    faqPageNode(SCOPE_FAQ, page.path),
  );

  return (
    <main id="main" className="scope-page">
      <PageHero
        crumb={<Breadcrumb trail={TRAIL} />}
        title="ระบบคัดช็อตให้ แล้วคุณเกลาต่อ"
        lead={
          // Answer-first: the whole scope in one quotable paragraph.
          <p>
            {keepThaiProse("Noey Studio ไม่ใช่โปรแกรมตัดต่อที่ทำแทนทั้งกระบวนการ และไม่ใช่ปุ่มเดียวจบ สิ่งที่ระบบทำคือขั้นตอนที่ซ้ำและกินเวลาที่สุดของคลิปสั้น — ฟังฟุตเทจทั้งกอง หาว่าช่วงไหนพูดได้ดี ตัดช่วงที่ไม่เอาออก แล้วพิมพ์ซับตามที่พูด สามอย่างนี้ระบบทำให้เสร็จก่อนคุณจะเปิดไทม์ไลน์ครั้งแรก ที่เหลือคือการเกลา ซึ่งยังเป็นงานของคุณ")}
          </p>
        }
        meta={
          <p className="stamp">
            อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time>
          </p>
        }
        aside={
          // A map of the timeline below: the system's steps on one track, the
          // cut where the draft is handed over, your work on the next track.
          <div className="handoff-key" aria-hidden="true">
            <span className="handoff-key__ruler" />
            <span className="handoff-key__lane handoff-key__lane--ai">
              <span className="trk tc">AI</span>
              {SCOPE_STEPS.map((step, index) => (
                <i key={step.title}>
                  <span className="tc">{String(index + 1).padStart(2, "0")}</span>
                </i>
              ))}
            </span>
            <span className="handoff-key__cut" />
            <span className="handoff-key__lane handoff-key__lane--you">
              {YOUR_WORK.map((item, index) => (
                <i key={item.title}>
                  <span className="tc">{String(index + 4).padStart(2, "0")}</span>
                </i>
              ))}
              <span className="trk tc">คุณ</span>
            </span>
          </div>
        }
      />

      {/* ── The handoff timeline: the system's steps, the cut, your work ── */}
      <section className="handoff" aria-label="ระบบทำให้ถึงไหน และสิ่งที่คุณยังต้องทำเอง">
        <div className="handoff-scene" data-scene="1" data-scene-items="">
          <div className="handoff-scene__sticky">
            <div className="handoff__viewport">
              <div className="handoff__track" data-scene-track="">
                <section className="handoff__part handoff__part--ai" aria-labelledby="scope-steps-title">
                  <div className="handoff__title" data-scene-item="">
                    <SectionHeader id="scope-steps-title" track="AI" timecode="00:00:00:00" title="ระบบทำให้ถึงไหน" size="h-2" className="handoff__head">
                      <p>
                        {keepThaiProse("ระบบทำให้สามขั้น คือถอดเสียงฟุตเทจทุกไฟล์เป็นข้อความพร้อมเวลา คัดช่วงที่ใช้ได้แล้วเรียงเป็นร่างแรก และใส่ซับไทยตามที่พูด จบสามขั้นนี้คือสิ่งที่ส่งให้คุณ ไม่ใช่คลิปที่พร้อมลงทันทีทุกครั้ง")}
                      </p>
                    </SectionHeader>
                  </div>
                  <ol className="handoff__blocks">
                    {SCOPE_STEPS.map((step, index) => (
                      <li key={step.title} className="handoff__block handoff__block--ai" data-scene-item="" style={{ "--i": index } as CSSProperties}>
                        <span className="handoff__n num" aria-hidden="true">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <h3>{keepThaiProse(step.title)}</h3>
                        <p>{keepThaiProse(step.body)}</p>
                      </li>
                    ))}
                  </ol>
                </section>

                <div className="handoff__cut" data-scene-item="">
                  <svg className="handoff__cut-mark" viewBox="0 0 60 120" aria-hidden="true" focusable="false">
                    <path d="M14 104 L 26 62" />
                    <path d="M34 58 L 46 16" />
                  </svg>
                  <p className="handoff__note">จบสามขั้นนี้คือ &quot;ร่างแรก&quot; ที่ระบบส่งให้ ไม่ใช่คลิปที่พร้อมลงทันทีทุกครั้ง</p>
                </div>

                <section className="handoff__part handoff__part--you" aria-labelledby="scope-yours-title">
                  <div className="handoff__title" data-scene-item="">
                    <SectionHeader id="scope-yours-title" track="คุณ" timecode="00:00:18:00" title="สิ่งที่คุณยังต้องทำเอง" size="h-2" className="handoff__head">
                      <p>{keepThaiProse("ไทม์ไลน์เปิดให้แก้ทุกอย่างเสมอ และงานเหล่านี้คือส่วนที่ AI ตัดสินใจแทนไม่ได้")}</p>
                    </SectionHeader>
                  </div>
                  <ul className="handoff__blocks">
                    {YOUR_WORK.map((item, index) => (
                      <li key={item.title} className="handoff__block handoff__block--you" data-scene-item="" style={{ "--i": index } as CSSProperties}>
                        <span className="handoff__n num" aria-hidden="true">
                          {String(index + 4).padStart(2, "0")}
                        </span>
                        <h3>{keepThaiProse(item.title)}</h3>
                        <p>{keepThaiProse(item.body)}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </div>
            <div className="handoff__playhead" aria-hidden="true" />
            <div className="handoff__progress" aria-hidden="true">
              <span />
            </div>
          </div>
        </div>
      </section>

      {/* ── Fit / misfit: two tracks of equal weight ── */}
      <section className="sect scope-fit" aria-labelledby="scope-fit-title">
        <div className="wrap">
          <SectionHeader id="scope-fit-title" track="V1" timecode="00:00:36:00" title="เหมาะกับงานแบบไหน">
            <p>
              {keepThaiProse("เหมาะที่สุดกับคลิปสั้นที่โครงเรื่องไม่ซับซ้อนและเนื้อหาเดินด้วยคำพูด เช่น คลิปรีวิว คลิปพูดหน้ากล้อง และคลิปยาวที่อยากตัดเป็นคลิปสั้น ยังไม่เหมาะกับงานที่ต้องแทรกภาพประกอบตามบท ตัดซ้อนหลายชั้น หรือใช้กราฟิกและโมชันเยอะ")}
            </p>
          </SectionHeader>
          <FitLists fits={SCOPE_FITS} misfits={SCOPE_MISFITS} fitTitle="เหมาะ" misfitTitle="ยังไม่เหมาะ" headingLevel="h3" />
        </div>
      </section>

      {/* ── Time saved: said honestly, with the three-row summary ── */}
      <section className="sect scope-time" aria-labelledby="scope-time-title">
        <div className="wrap scope-time__grid">
          <SectionHeader id="scope-time-title" track="A1" timecode="00:00:52:12" title="ประหยัดเวลาได้เท่าไหร่">
            <p>
              {keepThaiProse("ขึ้นกับฟุตเทจและความละเอียดที่ต้องการ งานที่เคยใช้เวลาไล่ฟุตเทจและพิมพ์ซับเป็นชั่วโมง มักเหลือเวลาเกลาในไทม์ไลน์เป็นสิบนาที แต่ถ้าคลิปต้องแทรกภาพหรือคุมจังหวะละเอียด เวลาที่ประหยัดจะน้อยลงตามส่วน")}
            </p>
          </SectionHeader>
          <div className="summary" data-reveal="rise">
            <div className="card-kicker">สรุปสั้น</div>
            <ul className="summary__rows">
              {SCOPE_SUMMARY.map((row, index) => (
                <li key={row.label} className={`summary__row summary__row--${index}`}>
                  <span className="summary__bar" aria-hidden="true" />
                  <span className="summary__label num">{row.label}</span>
                  <span className="summary__text">{keepThaiProse(row.text)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="sect scope-faq" aria-labelledby="scope-faq-title">
        <div className="wrap wrap--narrow">
          <SectionHeader id="scope-faq-title" track="T1" timecode="00:01:10:00" title="คำถามที่พบบ่อยเรื่องขอบเขต (FAQ)" size="h-2" />
          <FaqList items={SCOPE_FAQ} compact />
        </div>
      </section>

      {/* ── Guides, one per job ── */}
      <section className="sect scope-guides" aria-labelledby="scope-guides-title">
        <div className="wrap">
          <SectionHeader id="scope-guides-title" track="R2" timecode="00:01:24:00" title="อ่านวิธีทำทีละงาน" size="h-2" />
          <ul className="link-grid" data-reveal="stagger">
            {GUIDE_LINKS.map((item, index) => (
              <li key={item.href}>
                <ClipCard title={item.label} titleAs="h3" href={item.href} track={`G${index + 1}`} seed={index + 11}>
                  <p>{keepThaiProse(item.note)}</p>
                </ClipCard>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <CtaBand
        id="scope-cta-title"
        compact
        title="ถ้างานของคุณอยู่ในกลุ่มที่เหมาะ ลองตัดคลิปแรกด้วยแพลนฟรีได้เลย"
        actions={
          <>
            <Link href="/signup" className="btn btn-primary btn-lg" data-magnetic="">
              เริ่มใช้ฟรี
            </Link>
            <Link href="/pricing" className="btn btn-secondary btn-lg">
              ดูราคา
            </Link>
          </>
        }
      />

      <JsonLd data={jsonLd} />
    </main>
  );
}
