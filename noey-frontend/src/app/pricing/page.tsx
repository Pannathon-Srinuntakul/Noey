import type { Metadata } from "next";
import Link from "next/link";
import { BetaPriceNote } from "@/components/BetaPriceNote";
import { Breadcrumb } from "@/components/Breadcrumb";
import { CheckoutCanceledNotice } from "@/components/CheckoutCanceledNotice";
import { FaqList } from "@/components/FaqList";
import { JsonLd } from "@/components/JsonLd";
import { PlanComparisonTable } from "@/components/PlanComparisonTable";
import { PriceCards } from "@/components/PriceCards";
import { CtaBand } from "@/components/ds/CtaBand";
import { UsageMockup } from "@/components/mockups/UsageMockup";
import { Icon } from "@/components/mockups/app/ui";
import { PageHero } from "@/components/ds/PageHero";
import { ComputerOnly } from "@/components/ComputerOnly";
import { SectionHeader } from "@/components/ds/SectionHeader";
import { ClipsBasis, CutsCount, CutsNumber, CutsWord } from "@/components/pricing/CutsCount";
import { PlanRail } from "@/components/pricing/PlanRail";
import { pricingFaq } from "@/lib/faq";
import { MODES } from "@/lib/modes";
import { formatThaiDate } from "@/lib/format";
import {
  SOFTWARE_ID,
  breadcrumbNode,
  faqPageNode,
  jsonLdGraph,
  softwareApplicationNode,
  webPageNode,
} from "@/lib/jsonld";
import { BETA_PRICE_LINE } from "@/lib/beta";
import {
  APPROX_CUTS_PER_MONTH,
  APPROX_HIGH_CUTS_PER_MONTH,
  CLIPS_BASIS_SHORT,
  CUTS_APPROX_SHORT,
  CUTS_OVER_FOOTAGE_SHORT,
  CUTS_SHORT_OF_BUDGET,
  CUTS_NO_FINE,
  CLIP_MINUTES,
  PAID_TIERS,
  PLAN_COPY,
  PRECISION_NAMES,
  SPEECH_FOOTAGE_NOTE,
  VOLUME_VALUE_NOTE,
  clipsHeadline,
  displayPrice,
  fitTier,
  footageLadderSentence,
  formatBaht,
  isBetaPriced,
  lowestPaidPrice,
  type PriceTable,
} from "@/lib/plans";
import { pageMetadata } from "@/lib/seo";
import { getPriceTable } from "@/lib/server/prices";
import { PAGES } from "@/lib/site";
import "../../styles/pages/pricing.css";
import { keepThaiProse } from "@/components/ds/ThaiProse";

// ISR: prices follow GET /billing/plans, refreshed at most every 10 minutes.
export const revalidate = 600;

const TRAIL = [
  { name: PAGES.home.label, path: PAGES.home.path },
  { name: PAGES.pricing.label, path: PAGES.pricing.path },
];

function describe(table: PriceTable): string {
  const lowest = lowestPaidPrice(table);
  if (!lowest) return PAGES.pricing.description;
  const beta = isBetaPriced(table) ? ` ${BETA_PRICE_LINE}` : "";
  return `เทียบราคาทุกแพลนของ Noey Studio แพลนรายเดือนเริ่ม ${formatBaht(lowest.amountSatang)} บาท และมีเครดิตทดลองฟรี ดูจำนวนคลิปต่อเดือน ความยาวฟุตเทจ และพื้นที่เก็บงาน${beta}`;
}

export async function generateMetadata(): Promise<Metadata> {
  const table = await getPriceTable();
  const metadata = pageMetadata("pricing", { description: describe(table) });
  // Machine-readable twin of this page for AI agents.
  metadata.alternates = { ...metadata.alternates, types: { "text/markdown": "/pricing.md" } };
  return metadata;
}

/**
 * Answer-first: the free trial and how paying works open the page, in two
 * short quotable paragraphs; every plan's price and clip count is said in
 * one sentence under the cards (`PriceList`), where the cards have just
 * shown them — in the hero it was a wall of numbers above the same numbers.
 * The beta terms are said once, in the strip above the cards (BetaPriceNote).
 */
function answer(): string[] {
  return [
    `Noey Studio ให้เครดิตทดลองฟรีก้อนเดียวเมื่อสมัคร ตัดได้ ${clipsHeadline("free")} (${CLIPS_BASIS_SHORT}) ไม่ต้องผูกบัตร`,
    "ชำระด้วยบัตรเครดิตหรือเดบิต เปลี่ยนหรือยกเลิกแพลนได้เองจากหน้าบัญชี",
  ];
}

/**
 * Every monthly plan's price and clip count (the cards' text twin): one lead
 * line with the basis, then one short row per plan. The counts are marked like
 * the cards' (pricing/CutsCount), so the calculator above reprices them too.
 */
function PriceList({ table }: { table: PriceTable }) {
  const paid = PAID_TIERS.filter((tier) => displayPrice(table, tier) !== null);
  return (
    <div className="price-list">
      <p className="price-list__lead">
        {keepThaiProse(`ใช้หมดแล้วเลือกแพลนรายเดือนได้ ${paid.length} ระดับ ราคาต่อเดือนและจำนวนคลิปต่อเดือน`)}{" "}
        <span className="price-list__basis">
          (<ClipsBasis />)
        </span>
      </p>
      <ul className="price-list__items">
        {paid.map((tier) => {
          const high = APPROX_HIGH_CUTS_PER_MONTH[tier];
          return (
            <li key={tier} className="price-list__item">
              <span className="price-list__plan">{PLAN_COPY[tier].name}</span>
              <span className="num price-list__price">{`${displayPrice(table, tier)} บาท`}</span>
              <span className="price-list__cuts">
                <CutsCount tier={tier} over={CUTS_OVER_FOOTAGE_SHORT} short={CUTS_SHORT_OF_BUDGET}>
                  <CutsWord word="hedge" />{" "}
                  <span className="kt">
                    <CutsNumber className="num" value={APPROX_CUTS_PER_MONTH[tier]} /> <CutsWord word="unit" />
                  </span>
                </CutsCount>
                {/* The finer count on its own dimmed line; a plan without the
                    setting says so, so every row has the same two lines
                    (both hidden in the modes without the setting). */}
                {high ? (
                  <CutsCount tier={tier} precision="high" className="price-list__high">
                    {`ระดับ${PRECISION_NAMES.high}`}
                    <span className="kt">
                      {`${CUTS_APPROX_SHORT} `}
                      <CutsNumber className="num" value={high} /> คลิป
                    </span>
                  </CutsCount>
                ) : (
                  <span className="price-list__high" data-cuts-row="high">
                    {CUTS_NO_FINE}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The rules of the quota, one per row of the example card. The windows keep
 * their English names (lib/usage-limits.ts); under each, quietly, the name
 * the editor's own quota card gives it (web/src/lib/usageLimits.ts) — the
 * card drawn just above says "โควตารายเดือน", not "Monthly limit". One window
 * per account since 2026-09-30 (backend limits.py rule 1): the weekly and
 * 5-hour sub-windows no longer exist.
 */
const QUOTA_RULES: ReadonlyArray<{ key: string; editor?: string; text: string }> = [
  { key: "Monthly limit", editor: "โควตารายเดือน", text: "ทุกแพลนรายเดือน ได้โควตาใหม่ทุกรอบบิล ใช้หนักวันไหนก็ได้ ไม่มีเพดานรายสัปดาห์หรือรายชั่วโมง" },
  { key: "แพลนใหญ่", text: `${VOLUME_VALUE_NOTE} ตัวเลขบนการ์ดคิดให้แล้ว` },
  { key: "Trial credit", editor: "เครดิตทดลองใช้", text: `แพลนฟรี ได้เครดิตทดลองก้อนเดียวตอนสมัคร ตัดได้ ${clipsHeadline("free")} (${CLIPS_BASIS_SHORT}) ไม่รีเซ็ตรายเดือน` },
  { key: "บอกก่อนเริ่ม", text: "ระบบบอกก่อนเริ่มทุกครั้งว่างานนี้ใช้โควตาเท่าไหร่ จึงไม่มีการหักเกินโดยไม่รู้ตัว" },
  { key: "ไม่กินโควตา", text: "การแก้ไทม์ไลน์ การสลับช็อต และการเรนเดอร์ซ้ำ ทำได้ไม่จำกัด" },
  { key: "งานหนัก", text: "ฟุตเทจยาวและโหมดพากย์ใหม่ใช้ปริมาณมากกว่างานปกติ เพราะต้องถอดเสียงและวางแผนมากขึ้น" },
  { key: "ฟุตเทจต่อโปรเจกต์", text: `โหมดตัดฉากเด่นมีเพดานต่อแพลน — ${footageLadderSentence()} · ${SPEECH_FOOTAGE_NOTE} ภายในนั้นโควตาของแพลนเป็นตัวกำหนด` },
  {
    key: "ความละเอียด",
    text: "แพลนฟรี Lite และ Starter วิเคราะห์ที่ระดับปกติ ซึ่งให้ผลดีอยู่แล้ว ตั้งแต่ Pro ขึ้นไปเลือกระดับละเอียดได้ ซึ่งตัดถี่ขึ้นและจุดตัดแม่นขึ้น แลกกับการใช้โควตามากกว่า",
  },
];

export default async function PricingPage() {
  const table = await getPriceTable();
  const page = PAGES.pricing;
  const description = describe(table);
  const jsonLd = jsonLdGraph(
    webPageNode({ path: page.path, name: page.title, description, dateModified: page.updated, about: SOFTWARE_ID }),
    breadcrumbNode(TRAIL),
    softwareApplicationNode(table),
    faqPageNode(pricingFaq(isBetaPriced(table)), page.path),
  );
  const railPlans = PAID_TIERS.map((tier) => ({ tier, name: PLAN_COPY[tier].name }));
  // The calculator's answer at its default, marked in the HTML before any script runs.
  const defaultFit = fitTier(APPROX_CUTS_PER_MONTH.pro, CLIP_MINUTES.basis);
  // The three modes as the home page introduces them, with the editor's icons.
  const railModes = MODES.map((mode) => ({
    id: mode.id,
    name: mode.name,
    nameParts: mode.nameParts ?? [mode.name],
    fit: mode.fit,
    icon: <Icon name={mode.icon} size={18} strokeWidth={1.8} />,
  }));

  return (
    <main id="main" className="pricing-page">
      <PageHero
        className="phero--pricing"
        crumb={<Breadcrumb trail={TRAIL} />}
        title="เลือกตามปริมาณงาน"
        lead={answer().map((text) => (
          <p key={text.slice(0, 12)} className="pricing-answer">
            {keepThaiProse(text)}
          </p>
        ))}
        meta={
          <p className="stamp">
            อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time>
            <span className="stamp__sep">{"\u00a0· "}</span>
            <span className="kt stamp__more">ราคาเป็นเงินบาทต่อเดือน</span>
          </p>
        }
      />

      <section className="pricing-plans" aria-labelledby="pricing-plans-title">
        <div className="wrap">
          {/* The calculator opens like every other section: its marker, its
              timecode, its heading. */}
          <SectionHeader id="pricing-plans-title" marker timecode="00:00:24:00" title="คำนวณแพลนที่พอดี" size="h-2">
            <p>
              {keepThaiProse("เลือกโหมดที่ใช้และความยาวคลิปดิบของคุณ แล้วบอกว่าอยากได้กี่คลิปต่อเดือน ระบบชี้แพลนที่พอดีให้ และการ์ดทุกใบคิดตัวเลขใหม่ตามนั้น")}
            </p>
          </SectionHeader>
          <CheckoutCanceledNotice />
          <ComputerOnly className="computer-only--top" />
          <BetaPriceNote table={table} />
          <PlanRail plans={railPlans} modes={railModes} initial={APPROX_CUTS_PER_MONTH.pro}>
            <PriceCards table={table} variant="full" fit={defaultFit} />
          </PlanRail>
          <PriceList table={table} />
        </div>
      </section>

      <section className="sect quota" aria-labelledby="quota-title">
        <div className="wrap quota__grid">
          <SectionHeader id="quota-title" marker timecode="00:00:48:00" title="โควตาคิดยังไง" size="h-2">
            <p>
              {keepThaiProse("เรานับเป็นจำนวนคลิปที่ AI ตัดให้ต่อเดือน แต่ละคลิปใช้โควตาตามโหมดและความยาวฟุตเทจ ตัดช่วงเงียบใช้น้อยที่สุดเพราะถอดเสียงอย่างเดียว ตัดฉากเด่นและตัดไฮไลต์จากคลิปยาวมีขั้นที่ AI วางแผนตัดเพิ่มเข้ามา และทุกโหมด คลิปที่ยาวกว่าใช้โควตามากกว่า ตัวเลขบนการ์ดคิดจากโหมดและความยาวคลิปดิบที่ตั้งไว้ด้านบน ตั้งต้นที่โหมดตัดฉากเด่น คลิปดิบ 5 นาที และปัดลง แพลน Pro ขึ้นไปบอกทั้งจำนวนที่ระดับปกติและระดับละเอียด และหน้าตั้งค่าแสดงเป็นเปอร์เซ็นต์ของรอบที่เหลือ")}
            </p>
          </SectionHeader>
          <div className="quota-card">
            {/* The editor's own quota card with sample numbers, not anyone's real usage — labelled as such. */}
            <span className="mock-tag quota-card__tag">ตัวอย่างการแสดงผล</span>
            <UsageMockup />
            <ul className="rule-list">
              {QUOTA_RULES.map((rule) => (
                <li key={rule.key}>
                  <span className="num rule-list__key">
                    {rule.key}
                    {rule.editor ? <span className="rule-list__editor">{rule.editor}</span> : null}
                  </span>
                  <span>{keepThaiProse(rule.text)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="sect compare" aria-labelledby="compare-title">
        <div className="wrap">
          {/* What differs between plans, and what does not, said where the table shows it. */}
          <SectionHeader id="compare-title" marker timecode="00:01:12:00" title="ตารางเทียบแพลน" size="h-2">
            <p>
              {keepThaiProse("เครื่องมือเหมือนกันทุกแพลน สิ่งที่ต่างคือจำนวนคลิปที่ AI ตัดให้ต่อเดือน ความยาวฟุตเทจที่รับต่อโปรเจกต์ ความละเอียดการวิเคราะห์ และพื้นที่เก็บโปรเจกต์บนบัญชี งานที่กินกำลังมากที่สุดคือการถอดเสียงกับการวางแผนตัด จึงเป็นตัวกำหนดราคา ส่วนการแก้ในไทม์ไลน์และการเรนเดอร์ซ้ำ ไม่จำกัดทุกแพลน")}
            </p>
            <p className="pricing-muted">
              {keepThaiProse("ทุกแพลนได้ดราฟต์แรกจากการคัดช็อตเหมือนกัน แล้วยังต้องเกลาต่อเองในไทม์ไลน์ ระบบเหมาะกับคลิปสั้นที่โครงไม่ซับซ้อน ไม่ใช่งานโปรดักชันที่ต้องแทรกภาพหรือตัดซ้อนหลายชั้น")}
            </p>
          </SectionHeader>
          <PlanComparisonTable table={table} labelledBy="compare-title" footnote="live" fit={defaultFit} />
        </div>
      </section>

      <section className="sect pricing-faq" aria-labelledby="pricing-faq-title">
        <div className="wrap">
          <SectionHeader id="pricing-faq-title" marker timecode="00:01:40:00" title={"คำถามเรื่องราคา\u00a0(FAQ)"} size="h-2" />
          <FaqList items={pricingFaq(isBetaPriced(table))} compact />
        </div>
      </section>

      <CtaBand
        id="pricing-cta-title"
        compact
        title="ลองตัดคลิปแรกวันนี้"
        actions={
          <Link href="/signup" className="btn btn-primary btn-lg" data-magnetic="">
            เริ่มใช้ฟรี
          </Link>
        }
      >
        <p>{keepThaiProse("สมัครแล้วได้เครดิตทดลองฟรีทันที ไม่ต้องผูกบัตร ใช้หมดแล้วค่อยเลือกแพลนรายเดือน")}</p>
      </CtaBand>

      <JsonLd data={jsonLd} />
    </main>
  );
}
