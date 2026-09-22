/**
 * Plain-text surfaces for AI agents: /llms.txt (llmstxt.org format) and
 * /pricing.md. Both are generated from the same PriceTable, plan copy and FAQ
 * the HTML pages render, so an agent never reads a price the page does not
 * show. No AI vendor is named anywhere in this output (unit-tested).
 */
import { PRICING_FAQ } from "./faq";
import { SOFTWARE_DESCRIPTION } from "./jsonld";
import {
  COMPARISON_ROWS,
  PAID_TIERS,
  PLAN_COPY,
  TIERS,
  displayPrice,
  multiplierCaption,
  multiplierLabel,
  type PriceTable,
} from "./plans";
import { PAGES, SITE_NAME, absoluteUrl } from "./site";

function priceLine(table: PriceTable, tier: (typeof TIERS)[number]): string {
  const price = displayPrice(table, tier);
  if (tier === "free") return "0 บาท";
  return price ? `${price} บาท/เดือน` : "ยังไม่เปิดขาย";
}

export function buildPricingMarkdown(table: PriceTable, updatedIso: string): string {
  const lines: string[] = [];
  lines.push(`# ราคา ${SITE_NAME}`);
  lines.push("");
  lines.push(
    `> ${SITE_NAME} มีแพลนฟรี 0 บาท ใช้ได้ต่อเนื่องไม่ต้องผูกบัตร และแพลนรายเดือน ${PAID_TIERS.map(
      (tier) => `${PLAN_COPY[tier].name} ${priceLine(table, tier)}`,
    ).join(" · ")} ทุกแพลนได้ไทม์ไลน์ ซับไทย และการเรนเดอร์แบบไม่จำกัดครั้ง ที่ต่างกันคือปริมาณการใช้งาน AI (บอกเป็นจำนวนเท่าของแพลน Lite ตั้งแต่ 1x ถึง 35x) ความยาวคลิปต่อโปรเจกต์ จำนวนงานที่ทำพร้อมกันได้ และพื้นที่เก็บงาน`,
  );
  lines.push("");
  lines.push(`- หน้าเว็บ: ${absoluteUrl(PAGES.pricing.path)}`);
  lines.push(`- อัปเดตล่าสุด: ${updatedIso}`);
  lines.push("- สกุลเงิน: บาท (THB) ราคาต่อเดือน ชำระด้วยบัตรเครดิตหรือเดบิต ตัดอัตโนมัติทุกเดือน");
  lines.push(`- สมัครใช้งาน: ${absoluteUrl(PAGES.signup.path)}`);
  lines.push("");

  for (const tier of TIERS) {
    const copy = PLAN_COPY[tier];
    lines.push(`## ${copy.name}`);
    lines.push("");
    lines.push(`- ราคา: ${priceLine(table, tier)}`);
    lines.push(`- สรุป: ${copy.pricingBlurb}`);
    lines.push(`- ปริมาณการใช้งาน: ${multiplierLabel(tier) ?? "ทดลองใช้"} (${multiplierCaption(tier)})`);
    lines.push(`- ขีดจำกัดการใช้งาน: ${copy.limits.join(" + ")} · ทำงาน AI พร้อมกันได้ ${copy.concurrentJobs} งาน`);
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
  for (const item of PRICING_FAQ) {
    lines.push(`### ${item.question}`);
    lines.push("");
    lines.push(item.answer);
    lines.push("");
  }
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
    "",
    "## ความสามารถหลัก",
    "",
    `- [AI ตัดคลิปให้อัตโนมัติ](${absoluteUrl("/#features")}): เก็บทุกฉากตามลำดับเดิม เก็บเฉพาะช่วงไฮไลต์ หรือเรียงภาพใหม่ตามสคริปต์พากย์`,
    `- [พากย์เสียง พร้อมสคริปต์จาก AI](${absoluteUrl("/#features")}): ระบบเขียนสคริปต์พากย์ภาษาไทยตามภาพ อัดเสียงในเบราว์เซอร์ แล้ววางเสียงให้ตรงช็อต`,
    `- [ซับไทยอัตโนมัติ](${absoluteUrl("/#features")}): ซับขึ้นตามเสียงพูดจริง เลือกฟอนต์ ขนาด และตำแหน่งได้`,
    `- [ไทม์ไลน์แก้มือ](${absoluteUrl("/#how")}): ย้าย ยืดหด ลบ ทำซ้ำ สลับช็อต และเรนเดอร์ซ้ำได้ไม่จำกัด`,
    "",
    "## ราคา",
    "",
    `- [ราคาและตารางเทียบแพลน](${absoluteUrl(PAGES.pricing.path)}): แพลนฟรีและแพลนรายเดือนทั้งหมด พร้อมคำถามเรื่องราคา`,
    `- [ราคาแบบ Markdown](${absoluteUrl("/pricing.md")}): ข้อมูลราคาเดียวกันในรูปแบบที่อ่านด้วยเครื่องได้ง่าย`,
    "",
    "## หน้าหลัก",
    "",
    `- [หน้าแรก](${absoluteUrl(PAGES.home.path)}): ภาพรวมเครื่องมือ วิธีใช้งาน และคำถามที่พบบ่อย`,
    `- [ทำอะไรได้บ้าง](${absoluteUrl(PAGES.scope.path)}): ขอบเขตของระบบ — ถอดเสียง คัดช็อต เรียงลำดับ ใส่ซับไทยเป็นร่างแรก แล้วคุณเกลาต่อ งานแบบไหนเหมาะและไม่เหมาะ`,
    `- [เกี่ยวกับเรา](${absoluteUrl(PAGES.about.path)}): ที่มาของเครื่องมือ และช่องทางติดต่อทีมงาน`,
    `- [สมัครใช้งานฟรี](${absoluteUrl(PAGES.signup.path)}): สมัครแล้วเริ่มที่แพลนฟรีได้ทันที ไม่ต้องผูกบัตร`,
  ];
  return `${lines.join("\n")}\n`;
}
