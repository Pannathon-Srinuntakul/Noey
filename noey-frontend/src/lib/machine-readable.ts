/**
 * Plain-text surfaces for AI agents: /llms.txt (llmstxt.org format) and
 * /pricing.md. Both are generated from the same PriceTable, plan copy and FAQ
 * the HTML pages render, so an agent never reads a price the page does not
 * show. No AI vendor is named anywhere in this output (unit-tested).
 */
import { BETA_END_DATE_ISO, BETA_PRICE_AFTER_SHORT, BETA_PRICE_LINE } from "./beta";
import { pricingFaq } from "./faq";
import { ANSWERED_QUESTIONS, GUIDE_DOCS, GUIDE_ORDER, type GuideDoc } from "./guide";
import { SOFTWARE_DESCRIPTION } from "./jsonld";
import { SCOPE_FITS, SCOPE_MISFITS, SCOPE_STEPS, SCOPE_SUMMARY, SCOPE_YOUR_WORK } from "./scope";
import {
  COMPARISON_ROWS,
  FULL_PRICES_THB,
  PAID_TIERS,
  PLAN_COPY,
  TIERS,
  displayPrice,
  CLIPS_FOOTNOTE,
  VOLUME_VALUE_NOTE,
  clipsHeadlineFull,
  clipsLadderSentence,
  footageLadderSentence,
  formatBaht,
  isBetaPriced,
  precisionLabel,
  strikePrice,
  type PriceTable,
} from "./plans";
import { PAGES, SITE_NAME, absoluteUrl, publishedDate, type PageKey } from "./site";

/** Header every Markdown twin carries: what it is, where the HTML lives, when it changed. */
function markdownHeader(key: PageKey, title: string): string[] {
  return [
    `# ${title}`,
    "",
    `- หน้าเว็บ: ${absoluteUrl(PAGES[key].path)}`,
    `- เผยแพร่: ${publishedDate(key)} · อัปเดตล่าสุด: ${PAGES[key].updated}`,
    `- ผู้เขียน: ทีมงาน ${SITE_NAME}`,
    "",
  ];
}

function priceLine(table: PriceTable, tier: (typeof TIERS)[number]): string {
  const price = displayPrice(table, tier);
  if (tier === "free") return "0 บาท (เครดิตทดลองก้อนเดียว ไม่รีเซ็ตรายเดือน)";
  if (!price) return "ยังไม่เปิดขาย";
  const full = strikePrice(table, tier);
  return full ? `${price} บาท/เดือน (ราคาเบต้า ราคาปกติ ${full} บาท ถึง ${BETA_END_DATE_ISO})` : `${price} บาท/เดือน`;
}

export function buildPricingMarkdown(table: PriceTable, updatedIso: string): string {
  const lines: string[] = [];
  lines.push(`# ราคา ${SITE_NAME}`);
  lines.push("");
  lines.push(
    `> ${SITE_NAME} ให้เครดิตทดลองฟรีก้อนเดียวเมื่อสมัคร ไม่ต้องผูกบัตร และมีแพลนรายเดือน ${PAID_TIERS.map(
      (tier) => `${PLAN_COPY[tier].name} ${priceLine(table, tier)}`,
    ).join(" · ")} ทุกแพลนได้ไทม์ไลน์ ซับไทย และการเรนเดอร์แบบไม่จำกัดครั้ง ที่ต่างกันคือจำนวนคลิปที่ AI ตัดให้ต่อเดือน ความยาวฟุตเทจต่อโปรเจกต์ ความละเอียดการวิเคราะห์ จำนวนงานที่ทำพร้อมกันได้ และพื้นที่เก็บงาน`,
  );
  lines.push("");
  if (isBetaPriced(table)) {
    lines.push(`- ${BETA_PRICE_LINE} ${BETA_PRICE_AFTER_SHORT}`);
    lines.push(
      `- ราคาปกติต่อเดือน: ${PAID_TIERS.map((tier) => `${PLAN_COPY[tier].name} ${formatBaht(FULL_PRICES_THB[tier] * 100)} บาท`).join(" · ")}`,
    );
  }
  lines.push(`- หน้าเว็บ: ${absoluteUrl(PAGES.pricing.path)}`);
  lines.push(`- อัปเดตล่าสุด: ${updatedIso}`);
  lines.push("- สกุลเงิน: บาท (THB) ราคาต่อเดือน ชำระด้วยบัตรเครดิตหรือเดบิต ตัดอัตโนมัติทุกเดือน");
  lines.push(`- จำนวนคลิปต่อเดือนของแต่ละแพลน: ${clipsLadderSentence()}`);
  lines.push(`- วิธีนับ: ${CLIPS_FOOTNOTE}`);
  lines.push(`- ความคุ้ม: ${VOLUME_VALUE_NOTE}`);
  lines.push(`- สมัครใช้งาน: ${absoluteUrl(PAGES.signup.path)}`);
  lines.push("");

  for (const tier of TIERS) {
    const copy = PLAN_COPY[tier];
    lines.push(`## ${copy.name}`);
    lines.push("");
    lines.push(`- ราคา: ${priceLine(table, tier)}`);
    lines.push(`- สรุป: ${copy.pricingBlurb}`);
    lines.push(`- จำนวนคลิป: ${clipsHeadlineFull(tier)} (${CLIPS_FOOTNOTE})`);
    lines.push(`- ขีดจำกัดการใช้งาน: ${copy.limits.join(" + ")} · ทำงาน AI พร้อมกันได้ ${copy.concurrentJobs} งาน`);
    lines.push(`- ความละเอียดการวิเคราะห์: ${precisionLabel(tier)}`);
    for (const feature of copy.features) lines.push(`- ${feature}`);
    if (copy.recommended) lines.push("- แพลนที่แนะนำ");
    lines.push("");
  }

  lines.push("## ตารางเทียบแพลน");
  lines.push("");
  lines.push(`| ความสามารถ | ${TIERS.map((tier) => PLAN_COPY[tier].name).join(" | ")} |`);
  lines.push(`|---|${TIERS.map(() => "---").join("|")}|`);
  lines.push(`| ราคา (บาท/เดือน) | ${TIERS.map((tier) => displayPrice(table, tier) ?? "—").join(" | ")} |`);
  for (const row of COMPARISON_ROWS) {
    lines.push(`| ${row.label} | ${row.values.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## คำถามเรื่องราคา");
  lines.push("");
  for (const item of pricingFaq(isBetaPriced(table))) {
    lines.push(`### ${item.question}`);
    lines.push("");
    lines.push(item.answer);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Markdown twin of a guide page: the same answer, the same sections, the same
 * FAQ, in the order the page shows them. Built from `GUIDE_DOCS`, so the two
 * cannot drift.
 */
export function buildGuideMarkdown(doc: GuideDoc): string {
  const lines = markdownHeader(doc.key, doc.h1);
  lines.push(`> ${doc.answer}`);
  lines.push("");
  for (const section of doc.sections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    for (const paragraph of section.paragraphs) {
      lines.push(paragraph);
      lines.push("");
    }
    for (const bullet of section.bullets ?? []) lines.push(`- ${bullet}`);
    if (section.bullets?.length) lines.push("");
  }
  lines.push("## คำถามที่พบบ่อย");
  lines.push("");
  for (const item of doc.faq) {
    lines.push(`### ${item.question}`);
    lines.push("");
    lines.push(item.answer);
    lines.push("");
  }
  lines.push("## อ่านต่อ");
  lines.push("");
  for (const item of doc.related) lines.push(`- [${item.label}](${absoluteUrl(item.path)}): ${item.note}`);
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Markdown twin of /scope, from the same arrays the page renders. */
export function buildScopeMarkdown(): string {
  const lines = markdownHeader("scope", "ระบบคัดช็อตให้ แล้วคุณเกลาต่อ");
  lines.push(
    "> Noey Studio ทำขั้นตอนที่ซ้ำและกินเวลาที่สุดของคลิปสั้น คือฟังฟุตเทจทั้งกอง หาช่วงที่พูดได้ดี ตัดช่วงที่ไม่เอาออก และใส่ซับไทยตามที่พูด สามอย่างนี้เสร็จก่อนคุณเปิดไทม์ไลน์ครั้งแรก ส่วนการเกลาจังหวะและลำดับการเล่ายังเป็นงานของคุณ",
  );
  lines.push("");

  lines.push("## ระบบทำให้ถึงไหน");
  lines.push("");
  for (const step of SCOPE_STEPS) lines.push(`- **${step.title}** — ${step.body}`);
  lines.push("");

  lines.push("## สิ่งที่คุณยังต้องทำเอง");
  lines.push("");
  for (const column of SCOPE_YOUR_WORK) {
    for (const item of column) lines.push(`- **${item.title}** — ${item.body}`);
  }
  lines.push("");

  lines.push("## เหมาะกับงานแบบไหน");
  lines.push("");
  for (const fit of SCOPE_FITS) lines.push(`- เหมาะ: ${fit}`);
  for (const misfit of SCOPE_MISFITS) lines.push(`- ยังไม่เหมาะ: ${misfit}`);
  lines.push("");

  lines.push("## สรุปสั้น");
  lines.push("");
  for (const row of SCOPE_SUMMARY) lines.push(`- ${row.label}: ${row.text}`);
  lines.push("");

  lines.push("## อ่านต่อ");
  lines.push("");
  lines.push(`- [คู่มือใช้งาน](${absoluteUrl(PAGES.guide.path)}): คำตอบของคำถามที่ถามบ่อยทีละหน้า`);
  lines.push(`- [ช่วยเหลือ](${absoluteUrl(PAGES.guideHelp.path)}): โหมด ไฟล์ที่รองรับ โควตา และการแก้ปัญหา`);
  lines.push(`- [ราคา](${absoluteUrl(PAGES.pricing.path)}): เทียบทุกแพลนและเพดานของแต่ละแพลน`);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function buildLlmsTxt(table: PriceTable): string {
  const prices = TIERS.map((tier) => `${PLAN_COPY[tier].name} ${priceLine(table, tier)}`).join(" · ");
  const lines = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_NAME} คือ${SOFTWARE_DESCRIPTION} สำหรับครีเอเตอร์ แม่ค้าออนไลน์ และคนทำคลิปรีวิวสินค้าที่ถ่ายคลิปเอง ระบบถอดเสียงในคลิปเป็นข้อความ เลือกช่วงที่พูดได้ดี ต่อเป็นคลิปแนวตั้ง เขียนสคริปต์พากย์ และใส่ซับไทยให้ จากนั้นผู้ใช้แก้ต่อในไทม์ไลน์ได้ทุกช็อต`,
    "",
    `English summary: ${SITE_NAME} is a browser-based AI video editor for Thai-speaking creators and online sellers who shoot their own short videos. It transcribes Thai speech, picks the strongest takes, cuts a vertical 1080×1920 draft for TikTok, Reels or Shorts, writes a Thai voiceover script and adds Thai subtitles; every cut stays editable on a timeline. Free plan available, no card required.`,
    "",
    "- ภาษา: ไทย",
    "- ใช้งานผ่าน Chrome หรือ Edge เวอร์ชันใหม่บนคอมพิวเตอร์ ไม่ต้องติดตั้งโปรแกรม",
    "- ไฟล์ที่รับ: MP4 และ MOV จากมือถือและกล้องทั่วไป",
    "- ผลลัพธ์: วิดีโอแนวตั้ง 1080×1920 พร้อมลง TikTok, Reels หรือ Shorts",
    `- ราคา: ${prices}`,
    ...(isBetaPriced(table) ? [`- ${BETA_PRICE_LINE} ${BETA_PRICE_AFTER_SHORT}`] : []),
    "",
    "## ความสามารถหลัก",
    "",
    `- [AI ตัดคลิปให้อัตโนมัติ](${absoluteUrl("/#features")}): เก็บทุกฉากตามลำดับเดิม เก็บเฉพาะช่วงไฮไลต์ หรือเรียงภาพใหม่ตามสคริปต์พากย์`,
    `- [พากย์เสียง พร้อมสคริปต์จาก AI](${absoluteUrl("/#features")}): ระบบเขียนสคริปต์พากย์ภาษาไทยตามภาพที่ตัดไว้ ได้คลิปภาพพร้อมสคริปต์ให้คัดลอกไปอัดเสียงเอง`,
    `- [ซับไทยอัตโนมัติ](${absoluteUrl("/#features")}): ซับขึ้นตามเสียงพูดจริง เลือกฟอนต์ ขนาด และตำแหน่งได้`,
    `- [ไทม์ไลน์แก้มือ](${absoluteUrl("/#how")}): ย้าย ยืดหด ลบ ทำซ้ำ สลับช็อต และเรนเดอร์ซ้ำได้ไม่จำกัด`,
    "",
    "## ราคา",
    "",
    `- [ราคาและตารางเทียบแพลน](${absoluteUrl(PAGES.pricing.path)}): แพลนฟรีและแพลนรายเดือนทั้งหมด พร้อมคำถามเรื่องราคา`,
    `- [ราคาแบบ Markdown](${absoluteUrl("/pricing.md")}): ข้อมูลราคาเดียวกันในรูปแบบที่อ่านด้วยเครื่องได้ง่าย`,
    "",
    "## คำถามที่ระบบตอบได้",
    "",
    ...ANSWERED_QUESTIONS.map((item) => `- [${item.question}](${absoluteUrl(item.path)})`),
    "",
    "## คู่มือใช้งาน",
    "",
    `- [คู่มือทั้งหมด](${absoluteUrl(PAGES.guide.path)}): สารบัญของทุกหน้าคู่มือ พร้อมคำตอบย่อของแต่ละหน้า`,
    ...GUIDE_ORDER.map(
      (key) =>
        `- [${GUIDE_DOCS[key].h1}](${absoluteUrl(PAGES[key].path)}): ${PAGES[key].description} · Markdown: ${absoluteUrl(`${PAGES[key].path}.md`)}`,
    ),
    "",
    "## ข้อจำกัดที่ประกาศไว้",
    "",
    "- ระบบทำร่างแรกให้ ไม่ได้ตัดจบแทน จังหวะและลำดับการเล่ายังต้องเกลาเองในไทม์ไลน์",
    "- ไม่มีชั้นกราฟิก สติกเกอร์ ข้อความเคลื่อนไหว หรือเอฟเฟกต์ภาพ",
    "- ไม่แทรกภาพประกอบตามบท ไม่ตัดซ้อนหลายชั้น และไม่คุมจังหวะระดับเฟรมแทนผู้ใช้",
    "- ใช้ได้เฉพาะบนคอมพิวเตอร์ผ่าน Chrome หรือ Edge เวอร์ชันใหม่ ยังใช้บนมือถือไม่ได้",
    `- จำนวนคลิปที่ AI ตัดให้ต่อเดือน: ${clipsLadderSentence()}`,
    `- วิธีนับจำนวนคลิป: ${CLIPS_FOOTNOTE}`,
    `- ความยาวฟุตเทจรวมต่อโปรเจกต์: ${footageLadderSentence()} เพดานเดียวใช้กับทุกโหมด`,
    "- ความละเอียดการวิเคราะห์: แพลนฟรี Lite และ Starter วิเคราะห์ที่ระดับปกติ ส่วน Pro ขึ้นไปเลือกระดับละเอียดได้ ซึ่งตัดถี่ขึ้นและจุดตัดแม่นขึ้น แต่ใช้โควตามากกว่า",
    "- แพลนฟรีคือเครดิตทดลองก้อนเดียวเมื่อสมัคร ไม่รีเซ็ตรายเดือน ใช้หมดแล้วต้องอัปเกรด",
    "- การแปลงไฟล์อัตโนมัติเมื่อเบราว์เซอร์เปิดไฟล์ไม่ได้ มีตั้งแต่แพลน Starter ขึ้นไป เพลงประกอบมีตั้งแต่แพลน Lite ขึ้นไป",
    "- งาน AI ที่ทำพร้อมกันได้: ฟรีถึง Starter 1 งาน · Pro 2 · Studio 3 · Agency 4 · Max 5",
    "- โควตาแสดงเป็นเปอร์เซ็นต์ของรอบ ไม่ใช่ตัวเลขหน่วยภายใน การแก้ไทม์ไลน์และการเรนเดอร์ซ้ำไม่กินโควตา",
    "- ระบบบอกก่อนเริ่มทุกครั้งว่างานนั้นใช้โควตาเท่าไหร่ จึงไม่มีการหักเกินโดยไม่รู้ตัว",
    "- ไม่มีตัวเลขความเร็วหรือความแม่นที่วัดแล้วประกาศไว้ ณ ตอนนี้ หน้าเว็บจึงไม่อ้างตัวเลขเหล่านั้น",
    "",
    "## หน้าหลัก",
    "",
    `- [หน้าแรก](${absoluteUrl(PAGES.home.path)}): ภาพรวมเครื่องมือ วิธีใช้งาน และคำถามที่พบบ่อย`,
    `- [ทำอะไรได้บ้าง](${absoluteUrl(PAGES.scope.path)}): ขอบเขตของระบบ — ถอดเสียง คัดช็อต เรียงลำดับ ใส่ซับไทยเป็นร่างแรก แล้วคุณเกลาต่อ งานแบบไหนเหมาะและไม่เหมาะ · Markdown: ${absoluteUrl("/scope.md")}`,
    `- [เกี่ยวกับเรา](${absoluteUrl(PAGES.about.path)}): ที่มาของเครื่องมือ และช่องทางติดต่อทีมงาน`,
    `- [สมัครใช้งานฟรี](${absoluteUrl(PAGES.signup.path)}): สมัครแล้วได้เครดิตทดลองฟรีทันที ไม่ต้องผูกบัตร`,
    "",
    "## ติดตามการอัปเดต",
    "",
    `- [ฟีด Atom](${absoluteUrl("/feed.xml")}): ทุกหน้าที่เผยแพร่ เรียงตามวันที่อัปเดตล่าสุด`,
    `- [Sitemap](${absoluteUrl("/sitemap.xml")}): รายการหน้าทั้งหมดพร้อมวันที่แก้ไขล่าสุด`,
  ];
  return `${lines.join("\n")}\n`;
}
