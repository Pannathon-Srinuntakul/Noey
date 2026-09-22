import type { Metadata } from "next";
import { Breadcrumb } from "@/components/Breadcrumb";
import { CheckoutCanceledNotice } from "@/components/CheckoutCanceledNotice";
import { FaqList } from "@/components/FaqList";
import { JsonLd } from "@/components/JsonLd";
import { PlanComparisonTable } from "@/components/PlanComparisonTable";
import { PriceCards } from "@/components/PriceCards";
import { PRICING_FAQ } from "@/lib/faq";
import { formatThaiDate } from "@/lib/format";
import {
  SOFTWARE_ID,
  breadcrumbNode,
  faqPageNode,
  jsonLdGraph,
  softwareApplicationNode,
  webPageNode,
} from "@/lib/jsonld";
import {
  PAID_TIERS,
  PLAN_COPY,
  displayPrice,
  formatBaht,
  lowestPaidPrice,
  type PriceTable,
} from "@/lib/plans";
import { pageMetadata } from "@/lib/seo";
import { getPriceTable } from "@/lib/server/prices";
import { PAGES } from "@/lib/site";

// ISR: prices follow GET /billing/plans, refreshed at most every 10 minutes.
export const revalidate = 600;

const TRAIL = [
  { name: PAGES.home.label, path: PAGES.home.path },
  { name: PAGES.pricing.label, path: PAGES.pricing.path },
];

function describe(table: PriceTable): string {
  const lowest = lowestPaidPrice(table);
  if (!lowest) return PAGES.pricing.description;
  return `เทียบราคาทุกแพลนของ Noey Studio แพลนฟรี 0 บาท ไม่ต้องผูกบัตร และแพลนรายเดือนเริ่ม ${formatBaht(lowest.amountSatang)} บาท ดูโควตางาน AI ความยาวฟุตเทจ และพื้นที่เก็บงาน`;
}

export async function generateMetadata(): Promise<Metadata> {
  const table = await getPriceTable();
  const metadata = pageMetadata("pricing", { description: describe(table) });
  // Machine-readable twin of this page for AI agents.
  metadata.alternates = { ...metadata.alternates, types: { "text/markdown": "/pricing.md" } };
  return metadata;
}

/** Answer-first block: the prices themselves, in one quotable paragraph. */
function answer(table: PriceTable): string {
  const paid = PAID_TIERS.flatMap((tier) => {
    const price = displayPrice(table, tier);
    return price ? [`${PLAN_COPY[tier].name} ${price} บาท`] : [];
  });
  const list = paid.length > 1 ? `${paid.slice(0, -1).join(", ")} และ ${paid[paid.length - 1]}` : paid.join("");
  return `Noey Studio มีแพลนฟรี 0 บาทที่ใช้ได้ต่อเนื่องโดยไม่ต้องผูกบัตร และแพลนรายเดือน ${paid.length} ระดับ ได้แก่ ${list} ต่อเดือน ชำระด้วยบัตรเครดิตหรือเดบิต เปลี่ยนหรือยกเลิกแพลนได้เองจากหน้าบัญชี`;
}

export default async function PricingPage() {
  const table = await getPriceTable();
  const page = PAGES.pricing;
  const description = describe(table);
  const jsonLd = jsonLdGraph(
    webPageNode({ path: page.path, name: page.title, description, dateModified: page.updated, about: SOFTWARE_ID }),
    breadcrumbNode(TRAIL),
    softwareApplicationNode(table),
    faqPageNode(PRICING_FAQ, page.path),
  );

  return (
    <main id="main" className="container page">
      <div className="pricing-head">
        <Breadcrumb trail={TRAIL} />
        <h1 className="page-title">เลือกตามปริมาณงาน</h1>
        <p className="pricing-lead" style={{ marginBottom: 12 }}>
          {answer(table)}
        </p>
        <p className="pricing-lead" style={{ marginBottom: 12 }}>
          เครื่องมือเหมือนกันทุกแพลน สิ่งที่ต่างคือปริมาณงาน AI ต่อรอบ ความยาวฟุตเทจที่รับต่อโปรเจกต์ และพื้นที่เก็บโปรเจกต์บนบัญชี
          งานที่กินกำลังมากที่สุดคือการถอดเสียงกับการวางแผนตัด จึงเป็นตัวกำหนดราคา ส่วนการแก้ในไทม์ไลน์และการเรนเดอร์ซ้ำ ไม่จำกัดทุกแพลน
        </p>
        <p className="pricing-lead pricing-lead--muted">
          ทุกแพลนได้ร่างแรกจากการคัดช็อตเหมือนกัน แล้วยังต้องเกลาต่อเองในไทม์ไลน์ ระบบเหมาะกับคลิปสั้นที่โครงไม่ซับซ้อน
          ไม่ใช่งานโปรดักชันที่ต้องแทรกภาพหรือตัดซ้อนหลายชั้น
        </p>
        <p className="updated">
          อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time> · ราคาเป็นเงินบาทต่อเดือน
        </p>
      </div>

      <CheckoutCanceledNotice />
      <PriceCards table={table} variant="full" />

      <section className="quota-explain" aria-labelledby="quota-title">
        <div>
          <h2 id="quota-title" className="subsection-title">
            โควตาคิดยังไง
          </h2>
          <p>
            เราไม่นับเป็นจำนวนคลิป เพราะคลิป 15 วินาทีกับคลิป 3 นาทีใช้กำลังไม่เท่ากัน สิ่งที่นับคือปริมาณงานที่ AI ทำให้
            ทั้งการถอดเสียงและการวางแผนตัด แสดงเป็นเปอร์เซ็นต์ของขีดจำกัดในหน้าตั้งค่า แพลนที่สูงขึ้นได้ปริมาณมากขึ้นตามจำนวนเท่าที่บอกไว้
          </p>
        </div>
        <div className="card" style={{ padding: 28 }}>
          {/* Illustration of the settings screen, not anyone's real usage — labelled as such. */}
          <span className="tag tag-neutral example-tag">ตัวอย่างการแสดงผล</span>
          <div className="meter-row" style={{ marginTop: 4 }}>
            <span>5-hour limit</span>
            <span className="num">ใช้ไป 38%</span>
          </div>
          <div className="meter" aria-hidden="true">
            <div className="meter__fill" style={{ width: "38%" }} />
          </div>
          <div className="meter-row" style={{ marginTop: 14 }}>
            <span>Weekly limit</span>
            <span className="num">ใช้ไป 21%</span>
          </div>
          <div className="meter" aria-hidden="true">
            <div className="meter__fill" style={{ width: "21%" }} />
          </div>
          <ul className="rule-list">
            <li>
              <span className="num">Weekly limit</span>
              <span>ทุกแพลนรายเดือน นับ 7 วันจากงานแรกของรอบ ใช้ได้เมื่อไหร่ก็ได้ในสัปดาห์</span>
            </li>
            <li>
              <span className="num">5-hour limit</span>
              <span>Pro ขึ้นไป อีกชั้นหนึ่งกันการใช้งานหนักต่อเนื่อง รีเซ็ต 5 ชั่วโมงหลังงานแรกของรอบ</span>
            </li>
            <li>
              <span className="num">Monthly limit</span>
              <span>แพลนฟรี ได้โควตาก้อนเดียวต่อเดือน</span>
            </li>
            <li>
              <span className="num">ไม่กินโควตา</span>
              <span>การแก้ไทม์ไลน์ การสลับช็อต และการเรนเดอร์ซ้ำ ทำได้ไม่จำกัด</span>
            </li>
            <li>
              <span className="num">งานหนัก</span>
              <span>ฟุตเทจยาวและโหมดพากย์ใหม่ใช้ปริมาณมากกว่างานปกติ เพราะต้องถอดเสียงและวางแผนมากขึ้น</span>
            </li>
          </ul>
        </div>
      </section>

      <section aria-labelledby="compare-title">
        <h2 id="compare-title" className="subsection-title compare-title">
          ตารางเทียบแพลน
        </h2>
        <PlanComparisonTable table={table} labelledBy="compare-title" />
      </section>

      <section style={{ marginTop: 56, maxWidth: 760 }} aria-labelledby="pricing-faq-title">
        <h2 id="pricing-faq-title" className="subsection-title" style={{ marginBottom: 18 }}>
          คำถามเรื่องราคา (FAQ)
        </h2>
        <FaqList items={PRICING_FAQ} compact />
      </section>

      <JsonLd data={jsonLd} />
    </main>
  );
}
