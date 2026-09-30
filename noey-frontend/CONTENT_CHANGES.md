# Content changes — "The Cutting Room" redesign

Every change to what a visitor can read, made during the redesign on branch
`redesign/cutting-room`. The rule was: no sentence, FAQ, state or error
message disappears. Where a line had to change shape, it is recorded here as
**old → new → why**.

`scripts/content-parity.mjs` checks this automatically:

- (a/b) every Thai string in `src/` at the commit the redesign started from
  (`d3e3408`, 1,243 strings) must still exist in `src/` or be quoted in this
  file;
- (c) every line a visitor could read on 75 page states of the old production
  build (`.redesign-baseline/`) must still be readable on the new one
  (`.redesign-current/`), or be quoted here.

No wording was rewritten. The changes below are separators, placement and
labels.

## 1. Notes under related links lost their leading dash

In the old pages a link and its note sat on one line, separated by an em
dash. The note now sits under the link title inside a clip card, so the dash
has nothing to separate. Wording unchanged.

| Page | Old | New | Why |
| --- | --- | --- | --- |
| /guide | "— ขอบเขตของระบบ ทำอะไรได้ และอะไรที่ยังทำไม่ได้" | "ขอบเขตของระบบ ทำอะไรได้ และอะไรที่ยังทำไม่ได้" | note is its own line in the card |
| /guide | "— ตารางเทียบทั้งเจ็ดแพลน โควตา และเพดานฟุตเทจ" | "ตารางเทียบทั้งเจ็ดแพลน โควตา และเพดานฟุตเทจ" | same |
| /guide | "— ที่มาของเครื่องมือ และช่องทางติดต่อทีมงาน" | "ที่มาของเครื่องมือ และช่องทางติดต่อทีมงาน" | same |
| /guide | "— ทดลองกับฟุตเทจของคุณเองด้วยแพลนฟรี" | "ทดลองกับฟุตเทจของคุณเองด้วยแพลนฟรี" | same |
| /scope | "— ขั้นตอนตั้งแต่ลากไฟล์จนดาวน์โหลด" | "ขั้นตอนตั้งแต่ลากไฟล์จนดาวน์โหลด" | same |
| /scope | "— ซับมาจากไหน และแก้คำที่ถอดผิดยังไง" | "ซับมาจากไหน และแก้คำที่ถอดผิดยังไง" | same |
| /scope | "— ถ่ายยังไงให้ระบบคัดช็อตได้ดี" | "ถ่ายยังไงให้ระบบคัดช็อตได้ดี" | same |
| /scope | "— โหมดไฮไลต์และเพดานความยาวต่อแพลน" | "โหมดไฮไลต์และเพดานความยาวต่อแพลน" | same |
| /scope | "— โหมด ไฟล์ที่รองรับ โควตา และการแก้ปัญหา" | "โหมด ไฟล์ที่รองรับ โควตา และการแก้ปัญหา" | same |
| /terms, /privacy | "— เอกสารอีกฉบับที่ใช้ร่วมกับหน้านี้" | "เอกสารอีกฉบับที่ใช้ร่วมกับหน้านี้" | same |
| /terms, /privacy | "— โหมดการตัด ไฟล์ที่รองรับ โควตา และการแก้ปัญหา" | "โหมดการตัด ไฟล์ที่รองรับ โควตา และการแก้ปัญหา" | same |
| /terms, /privacy | "— ราคา ขีดจำกัดของแต่ละแพลน และการยกเลิก" | "ราคา ขีดจำกัดของแต่ละแพลน และการยกเลิก" | same |
| /terms, /privacy | "— ขอบเขตของระบบ สิ่งที่ทำได้และทำไม่ได้" | "ขอบเขตของระบบ สิ่งที่ทำได้และทำไม่ได้" | same |

## 2. Breadcrumb separator: "›" → a drawn splice mark

The separator between crumbs is now a small drawn diagonal — the splice from
the logo — instead of the "›" character. It is decoration (`aria-hidden`
SVG), so the text a page shows between two crumbs is now nothing instead of
"›". Every crumb's text is unchanged, and so is the BreadcrumbList JSON-LD.

| Old line (as read on the page) | New (crumbs, separator drawn) |
| --- | --- |
| "หน้าแรก›เกี่ยวกับเรา" | หน้าแรก ⁄ เกี่ยวกับเรา |
| "หน้าแรก›ราคา" | หน้าแรก ⁄ ราคา |
| "หน้าแรก›ทำอะไรได้บ้าง" | หน้าแรก ⁄ ทำอะไรได้บ้าง |
| "หน้าแรก›เงื่อนไขการใช้งาน" | หน้าแรก ⁄ เงื่อนไขการใช้งาน |
| "หน้าแรก›ความเป็นส่วนตัว" | หน้าแรก ⁄ ความเป็นส่วนตัว |
| "หน้าแรก›คู่มือใช้งาน" | หน้าแรก ⁄ คู่มือใช้งาน |
| "หน้าแรก›คู่มือใช้งาน›ตัดคลิป TikTok ด้วย AI" | หน้าแรก ⁄ คู่มือใช้งาน ⁄ ตัดคลิป TikTok ด้วย AI |
| "หน้าแรก›คู่มือใช้งาน›ใส่ซับไทยอัตโนมัติ" | หน้าแรก ⁄ คู่มือใช้งาน ⁄ ใส่ซับไทยอัตโนมัติ |
| "หน้าแรก›คู่มือใช้งาน›ตัดคลิปรีวิวสินค้า" | หน้าแรก ⁄ คู่มือใช้งาน ⁄ ตัดคลิปรีวิวสินค้า |
| "หน้าแรก›คู่มือใช้งาน›ตัดคลิปยาวเป็นคลิปสั้น" | หน้าแรก ⁄ คู่มือใช้งาน ⁄ ตัดคลิปยาวเป็นคลิปสั้น |
| "หน้าแรก›คู่มือใช้งาน›เลือกเครื่องมือ AI ตัดต่อ" | หน้าแรก ⁄ คู่มือใช้งาน ⁄ เลือกเครื่องมือ AI ตัดต่อ |
| "หน้าแรก›คู่มือใช้งาน›ช่วยเหลือ" | หน้าแรก ⁄ คู่มือใช้งาน ⁄ ช่วยเหลือ |

## 3. Header (signed in): "บัญชีของฉัน" and "ออกจากระบบ" moved into the account menu

Old: the signed-in header showed a "บัญชีของฉัน" link and an "ออกจากระบบ"
button side by side.

New: the header shows a chip with the visitor's name ("คุณ…"; "บัญชีของฉัน"
when no name is known). The chip opens the account menu, which holds the
same "บัญชีของฉัน" link and the same "ออกจากระบบ" button (still a
server-rendered form, so signing out works before JavaScript loads). The
phone menu sheet keeps both as before.

Why: the header is a floating editor toolbar with one primary action
("เปิดห้องตัดต่อ"); two account controls next to it competed with it. The text
is unchanged and one click away; it is only out of view while the menu is
closed (so the page crawl, which reads visible text, no longer sees it on
first paint).

## 4. Home: step illustrations are labelled as mock-ups, not screenshots

| Old | New | Why |
| --- | --- | --- |
| "ภาพหน้าจอ: ลากไฟล์เข้าโปรเจกต์" | "ภาพจำลอง · ลากไฟล์เข้าโปรเจกต์" | The empty screenshot placeholders are now coded illustrations of the editor. They are not screenshots, and every UI illustration on the site must say "ภาพจำลอง" (redesign rule 4). |
| "ภาพหน้าจอ: เลือกโหมดและความยาว" | "ภาพจำลอง · เลือกโหมดและความยาว" | same |
| "ภาพหน้าจอ: หน้าพรีวิวและไทม์ไลน์" | "ภาพจำลอง · หน้าพรีวิวและไทม์ไลน์" | same |

`placeholderLabel` stays in `src/lib/media.ts` for when real screenshots are
dropped in; `mockLabel` carries the step names used by the illustrations.

## 5. Checkout: one "การชำระเงิน" label instead of two

Old: `/checkout/success` showed the eyebrow "การชำระเงิน" above the title and
the same "การชำระเงิน" again as a kicker inside the card (waiting, confirmed
and "slow" states).

New: the title "ขอบคุณที่อัปเกรดแพลน" and every state's heading and text sit on
one status card; "การชำระเงิน" is shown once, as the card's eyebrow.

Why: the card and the page header became one element; the second copy of the
same word labelled nothing new.

## 6. Theme toggle glyph

Old: the toggle's visible glyph was the character "☾" (and a sun character in
dark mode). New: drawn icons. The button's accessible names ("สลับเป็นโหมดมืด",
"สลับเป็นโหมดสว่าง") are unchanged.

## Text added (not replacing anything)

Only labels, no claims:

- "ภาพจำลองการทำงาน" / "ภาพจำลอง" on every UI illustration (hero editor,
  sign-in stage, step illustrations, micro-demos, the example quota meters on
  /pricing, which also keep "ตัวอย่างการแสดงผล").
- Editor furniture drawn as decoration and hidden from assistive technology:
  track labels (V1, A1, R1…, L1…, Q01…, CH1…), timecodes, file names in the
  guide bin ("ai-cut-tiktok.mov" …), "BIN", "MSG", "END".
- The sample transcript and subtitles inside the editor illustration
  ("สวัสดีค่ะ วันนี้มารีวิวเซรั่มขวดนี้" …) — an example project, inside the
  figure labelled "ภาพจำลองการทำงาน".
- /pricing: the clips slider label "ใช้ประมาณกี่คลิปต่อเดือน"; its readout is
  built from `plans.ts` only (`clipsHeadline`, `FREE_CLIPS_CAPTION`) with
  `CLIPS_FOOTNOTE` under it.

No testimonials, client logos, ratings or measured-looking numbers were
added. The running timecode beside "งานที่กินเวลาที่สุด ไม่ใช่การถ่าย แต่เป็นการตัด"
on the home page is decoration (`aria-hidden`): it counts up from zero while
the section is on screen, like an editor's clock, and states no measured
time.
