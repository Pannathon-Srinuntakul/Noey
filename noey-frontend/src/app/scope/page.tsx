import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumb } from "@/components/Breadcrumb";
import { FitLists } from "@/components/FitLists";
import { JsonLd } from "@/components/JsonLd";
import { SOFTWARE_ID, breadcrumbNode, jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { SCOPE_FITS, SCOPE_MISFITS, SCOPE_STEPS, SCOPE_SUMMARY, SCOPE_YOUR_WORK } from "@/lib/scope";
import { pageMetadata } from "@/lib/seo";
import { PAGES } from "@/lib/site";

export const metadata: Metadata = pageMetadata("scope");

const TRAIL = [
  { name: PAGES.home.label, path: PAGES.home.path },
  { name: PAGES.scope.label, path: PAGES.scope.path },
];

/**
 * What the system does and what stays the user's job. Replaced /examples
 * (Website v2, 2026-09-22): an honest scope page instead of one sample clip.
 */
export default function ScopePage() {
  const page = PAGES.scope;
  const jsonLd = jsonLdGraph(
    webPageNode({ path: page.path, name: page.title, description: page.description, dateModified: page.updated, about: SOFTWARE_ID }),
    breadcrumbNode(TRAIL),
  );

  return (
    <main id="main" className="container page scope">
      <Breadcrumb trail={TRAIL} />
      <p className="eyebrow">ทำอะไรได้บ้าง</p>
      <h1 className="page-title scope__title">ระบบคัดช็อตให้ แล้วคุณเกลาต่อ</h1>
      {/* Answer-first: the whole scope in one quotable paragraph. */}
      <p className="lead-columns">
        Noey Studio ไม่ใช่โปรแกรมตัดต่อที่ทำแทนทั้งกระบวนการ และไม่ใช่ปุ่มเดียวจบ สิ่งที่ระบบทำคือขั้นตอนที่ซ้ำและกินเวลาที่สุดของคลิปสั้น —
        ฟังฟุตเทจทั้งกอง หาว่าช่วงไหนพูดได้ดี ตัดช่วงที่ไม่เอาออก แล้วพิมพ์ซับตามที่พูด สามอย่างนี้ระบบทำให้เสร็จก่อนคุณจะเปิดไทม์ไลน์ครั้งแรก
        ที่เหลือคือการเกลา ซึ่งยังเป็นงานของคุณ
      </p>
      <div className="scope__rule" aria-hidden="true" />

      <section className="scope__section scope__section--first" aria-labelledby="scope-steps-title">
        <h2 id="scope-steps-title" className="scope__h2">
          ระบบทำให้ถึงไหน
        </h2>
        <ol className="scope-steps">
          {SCOPE_STEPS.map((step, index) => (
            <li key={step.title} className="scope-steps__item">
              <div className="num scope-steps__n">{String(index + 1).padStart(2, "0")}</div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="scope__note">จบสามขั้นนี้คือ &quot;ร่างแรก&quot; ที่ระบบส่งให้ ไม่ใช่คลิปที่พร้อมลงทันทีทุกครั้ง</p>
      </section>

      <section className="scope__section" aria-labelledby="scope-yours-title">
        <h2 id="scope-yours-title" className="scope__h2" style={{ marginBottom: 12 }}>
          สิ่งที่คุณยังต้องทำเอง
        </h2>
        <p className="scope__intro">ไทม์ไลน์เปิดให้แก้ทุกอย่างเสมอ และงานเหล่านี้คือส่วนที่ AI ตัดสินใจแทนไม่ได้</p>
        <div className="scope-yours">
          {SCOPE_YOUR_WORK.map((column, index) => (
            <ul key={index} className="ruled-list ruled-list--loose">
              {column.map((item) => (
                <li key={item.title}>
                  <strong>{item.title}</strong>
                  <br />
                  {item.body}
                </li>
              ))}
            </ul>
          ))}
        </div>
      </section>

      <section className="scope__section" aria-labelledby="scope-fit-title">
        <h2 id="scope-fit-title" className="scope__h2">
          เหมาะกับงานแบบไหน
        </h2>
        <FitLists fits={SCOPE_FITS} misfits={SCOPE_MISFITS} fitTitle="เหมาะ" misfitTitle="ยังไม่เหมาะ" headingLevel="h3" />
      </section>

      <section className="scope__section scope-time" aria-labelledby="scope-time-title">
        <div>
          <h2 id="scope-time-title" className="scope__h2" style={{ marginBottom: 14 }}>
            ประหยัดเวลาได้เท่าไหร่
          </h2>
          <p className="scope__intro" style={{ margin: 0 }}>
            ขึ้นกับฟุตเทจและความละเอียดที่ต้องการ งานที่เคยใช้เวลาไล่ฟุตเทจและพิมพ์ซับเป็นชั่วโมง มักเหลือเวลาเกลาในไทม์ไลน์เป็นสิบนาที
            แต่ถ้าคลิปต้องแทรกภาพหรือคุมจังหวะละเอียด เวลาที่ประหยัดจะน้อยลงตามส่วน
          </p>
        </div>
        <div className="card scope-summary">
          <div className="card-kicker">สรุปสั้น</div>
          <ul className="rule-list">
            {SCOPE_SUMMARY.map((row) => (
              <li key={row.label}>
                <span className="num">{row.label}</span>
                <span>{row.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="bottom-cta">
        <p>ถ้างานของคุณอยู่ในกลุ่มที่เหมาะ ลองตัดคลิปแรกด้วยแพลนฟรีได้เลย</p>
        <div className="cta-row" style={{ marginTop: 0 }}>
          <Link href="/signup" className="btn btn-primary btn-lg">
            เริ่มใช้ฟรี
          </Link>
          <Link href="/pricing" className="btn btn-secondary btn-lg">
            ดูราคา
          </Link>
        </div>
      </div>

      <JsonLd data={jsonLd} />
    </main>
  );
}
