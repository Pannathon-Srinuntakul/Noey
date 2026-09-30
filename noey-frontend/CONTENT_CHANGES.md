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

## 7. Article stamp: the separator binds to the date

Old: `อัปเดตล่าสุด <date> · เขียนโดย <author>` as one run of text.

New: the same words, but the " · " is joined to the date with a no-break
space and "เขียนโดย <author>" is kept on one line, so a narrow screen breaks
after the dot instead of stranding "Noey Studio" or starting a line with "·".
The source no longer holds the literal "· เขียนโดย" in one piece; what a
reader sees is unchanged.

## 8. Plan picker: no "แนะนำ" on the plan already held

Old: in the account's plan dialog the recommended plan carried "แนะนำ" even
when it was the user's current plan, e.g.
"Pro · 990499 บาท/เดือน · แพลนปัจจุบันแนะนำ".

New: the current plan reads "Pro · 990 499 บาท/เดือน · แพลนปัจจุบัน"; "แนะนำ"
still marks the recommended plan for everyone on another plan.

Why: the tag suggests a move. On the plan already held it suggested nothing
and read as a mistake (flagged by both design reviews).

## 9. /pricing: two notes moved from the hero to the comparison table

Old: the hero held three paragraphs — the price summary, "เครื่องมือเหมือนกัน
ทุกแพลน …" and "ทุกแพลนได้ร่างแรกจากการคัดช็อตเหมือนกัน …".

New: the hero keeps the price summary (the answer-first paragraph); the other
two, word for word, open the "ตารางเทียบแพลน" section they explain.

Why: on a phone the plans started some 1,500px down, behind twenty-odd lines
of prose that the cards and the table repeat.

## 10. Sign-up: the consent hint sits under the consent box

Old: "ติ๊กยอมรับเงื่อนไขก่อนจึงจะสมัครได้" and, once ticked, "ยังไม่ต้องกรอกบัตร
ในขั้นนี้ เริ่มที่แพลนฟรีได้เลย" shared one line under the submit button.

New: the first shows right under the terms box while it is unticked; the
second stays under the button once it is ticked. Same words.

Why: the buttons are locked by the box, so the reason belongs at the box; it
was about 480px away, below the fold on a phone.

## 11. /pricing: the quota illustration is the editor's own quota card

The example meters under "โควตาคิดยังไง" were a drawing with English labels.
The owner asked for every picture of the app to be the app (MOCKUP_FIX_PROMPT.md),
so the illustration is now the settings page's quota card
(`web/src/components/settings/UsageCard.tsx`) with the same sample
percentages. Its window names are the app's.

| Old | New | Why |
| --- | --- | --- |
| "5-hour limit" | "โควตารอบ 5 ชั่วโมง" | the app's label for the 5-hour window (`LIMIT_LABELS` in `web/src/lib/usageLimits.ts`) |
| "Weekly limit" | "โควตารายสัปดาห์" | the app's label for the weekly window |

"ใช้ไป 38%" and "ใช้ไป 21%" stay. The card also shows what the real one shows
around them: "แผน Pro", "ทำพร้อมกันได้ 2 งาน", "เปลี่ยนแผน", each window's
reset line, "ที่เก็บไฟล์", "ลบโปรเจกต์เก่าเพื่อคืนพื้นที่ได้" and
"แก้ไทม์ไลน์ สลับช็อต และเรนเดอร์ซ้ำ ไม่กินโควตา". It is still labelled
"ตัวอย่างการแสดงผล", and the drawing is hidden from assistive technology like
every other illustration. The plan comparison table keeps its own labels.

## 12. Where it runs: a computer only, and no desktop app

The owner confirmed on 2026-10-01 what customers can use today: the web
editor, on a computer. It does not run on phones, and customers are not given
the desktop app. The copy said phones were "not recommended" and mentioned
"the app on your computer"; both now say what is true.

| Old | New | Why |
| --- | --- | --- |
| "ไม่ต้อง เปิดผ่าน Chrome หรือ Edge เวอร์ชันใหม่บนคอมพิวเตอร์ได้เลย ตอนนี้ยังแนะนำให้ใช้บนคอม เพราะการเรนเดอร์ใช้กำลังเครื่องพอสมควร" | "… ตอนนี้ใช้ได้เฉพาะบนคอม เพราะการเรนเดอร์ใช้กำลังเครื่องพอสมควร" | FAQ: computer only |
| "ทำไมยังไม่แนะนำให้ใช้บนมือถือ" | "ทำไมยังใช้บนมือถือไม่ได้" | FAQ question |
| "เพราะการเรนเดอร์วิดีโอทำงานบนเครื่องของผู้ใช้ผ่านเบราว์เซอร์ ซึ่งกินกำลังเครื่องพอสมควร บนคอมพิวเตอร์ที่รัน Chrome หรือ Edge เวอร์ชันใหม่จึงได้ประสบการณ์ที่นิ่งกว่า" | "… ตอนนี้จึงใช้ได้เฉพาะบนคอมพิวเตอร์ที่รัน Chrome หรือ Edge เวอร์ชันใหม่" | FAQ answer |
| "ระบบใช้งานบนคอมพิวเตอร์ผ่าน Chrome หรือ Edge เวอร์ชันใหม่ ไม่ต้องติดตั้งโปรแกรม แต่ยังไม่แนะนำให้ใช้บนมือถือ เพราะการเรนเดอร์ใช้กำลังเครื่องพอสมควร ไฟล์ที่รับคือ MP4 และ MOV จากมือถือและกล้องทั่วไป" | "… แต่ยังใช้บนมือถือไม่ได้ …" | guide |
| "ยังไม่แนะนำ ระบบออกแบบให้ใช้บนคอมพิวเตอร์ผ่าน Chrome หรือ Edge เวอร์ชันใหม่ เพราะการเรนเดอร์ใช้กำลังเครื่องพอสมควร" | "ยังไม่ได้ ตอนนี้ใช้ได้เฉพาะบนคอมพิวเตอร์ผ่าน Chrome หรือ Edge เวอร์ชันใหม่ …" | guide FAQ "ใช้บนมือถือได้ไหม" |
| "- ใช้บนคอมพิวเตอร์ผ่าน Chrome หรือ Edge เวอร์ชันใหม่ ยังไม่แนะนำให้ใช้บนมือถือ" | "- ใช้ได้เฉพาะบนคอมพิวเตอร์ผ่าน Chrome หรือ Edge เวอร์ชันใหม่ ยังใช้บนมือถือไม่ได้" | llms.txt limits |
| "ไฟล์ที่อยู่ในเครื่องของคุณเอง เช่น โปรเจกต์ในเบราว์เซอร์ของห้องตัดต่อหรือในแอปบนคอมพิวเตอร์ ยังอยู่ในเครื่องนั้น ลบเองได้ตามต้องการ" | "… เช่น โปรเจกต์ในเบราว์เซอร์ของห้องตัดต่อ ยังอยู่ในเครื่องนั้น …" | /account-deleted: no desktop app |
| "ไฟล์ที่อยู่ในเครื่องของคุณเอง (ในเบราว์เซอร์ของห้องตัดต่อ หรือในแอปบนคอมพิวเตอร์) ระบบลบให้ไม่ได้ ลบเองได้จากเครื่องนั้น" | "ไฟล์ที่อยู่ในเครื่องของคุณเอง (ในเบราว์เซอร์ของห้องตัดต่อ) ระบบลบให้ไม่ได้ ลบเองได้จากเครื่องนั้น" | delete-account panel |
| "สมัครแล้วได้เครดิตทดลองฟรี · ไม่ต้องผูกบัตร · ใช้บนคอมผ่าน Chrome หรือ Edge" | "… · ใช้ได้เฉพาะบนคอมผ่าน Chrome หรือ Edge" | home hero fine print |
| "ใช้บนคอมพิวเตอร์ผ่าน Chrome หรือ Edge เวอร์ชันใหม่ ไม่ต้องติดตั้งโปรแกรม" | "ใช้ได้เฉพาะบนคอมพิวเตอร์ผ่าน Chrome หรือ Edge เวอร์ชันใหม่ ไม่ต้องติดตั้งโปรแกรม" | /signup, what the free plan includes |

The owner also asked that visitors be told plainly. On a phone or a touch
tablet, a note says so where a visitor would start — under the home page's
"เริ่มใช้ฟรี", above the sign-up and log-in forms, and above the plans on
/pricing (`components/ComputerOnly.tsx`; hidden on computers, where the copy
around it already says it): "ห้องตัดต่อใช้ได้เฉพาะบนคอมพิวเตอร์ ผ่าน Chrome
หรือ Edge ยังใช้บนมือถือหรือแท็บเล็ตไม่ได้".

"MP4 และ MOV จากมือถือและกล้องทั่วไป" (files shot on a phone) and
"รับวิดีโอจากมือถือ" (sending clips from a phone to the editor on the computer)
stay: both are true on the web build.

## 13. Voiceover: the web editor hands over a script, it does not record

The editor customers use (the web build) does not record: its in-app recorder
is hidden on the web (`canRecordVoiceover = !isBrowser` in
`web/src/lib/platformFeatures.ts`, since 2026-09-09). A ตัดฉากเด่น run with
an AI script gives a picture-only cut plus the script, which the project page
offers to copy ("คัดลอก") for dubbing elsewhere. The owner approved these
rewordings on 2026-10-01.

| Old | New | Where |
| --- | --- | --- |
| "ระบบเขียนสคริปต์พากย์ภาษาไทยให้ตามภาพที่มี แบ่งเป็นประโยคสั้น ๆ ให้อ่านทีละบรรทัด อัดเสียงในเบราว์เซอร์ อัดใหม่เฉพาะประโยคที่ไม่พอใจได้ แล้วระบบวางเสียงให้ตรงช็อต" | "ระบบเขียนสคริปต์พากย์ภาษาไทยให้ตามภาพที่ตัดไว้ แบ่งเป็นประโยคสั้น ๆ ตามช็อต ได้คลิปภาพพร้อมสคริปต์ กดคัดลอกไปอัดเสียงเองได้ทันที" | home, feature "พากย์เสียง พร้อมสคริปต์จาก AI" |
| "ความสามารถหลักมีสามอย่าง คือตัดคลิปอัตโนมัติจากสิ่งที่พูดจริง เขียนสคริปต์พากย์ภาษาไทยพร้อมให้อัดเสียงในเบราว์เซอร์ และใส่ซับไทยตามเสียงพูด ทั้งสามอย่างทำงานในเบราว์เซอร์โดยไม่ต้องติดตั้งโปรแกรม" | "… เขียนสคริปต์พากย์ภาษาไทยให้เอาไปอัดเสียงได้ทันที …" | home, summary paragraph |
| "): ระบบเขียนสคริปต์พากย์ภาษาไทยตามภาพ อัดเสียงในเบราว์เซอร์ แล้ววางเสียงให้ตรงช็อต" | "): ระบบเขียนสคริปต์พากย์ภาษาไทยตามภาพที่ตัดไว้ ได้คลิปภาพพร้อมสคริปต์ให้คัดลอกไปอัดเสียงเอง" | llms.txt feature list (the text after the feature's link) |
| "ถ้าเลือกพากย์ใหม่ ระบบเขียนสคริปต์ภาษาไทยให้ตามภาพที่มี แบ่งเป็นประโยคสั้น ๆ ให้อ่านทีละบรรทัด คุณอัดเสียงในเบราว์เซอร์ อัดใหม่เฉพาะประโยคที่ไม่พอใจได้ แล้วระบบวางเสียงให้ตรงกับช็อต สคริปต์แก้ข้อความได้ก่อนอัดเสมอ ถ้าคำไหนไม่ใช่คำที่คุณใช้จริงก็พิมพ์ทับได้" | "ถ้าเลือกพากย์ใหม่ ระบบเขียนสคริปต์ภาษาไทยให้ตามภาพที่ตัดไว้ แบ่งเป็นประโยคสั้น ๆ ตามช็อต ได้คลิปภาพพร้อมสคริปต์ กดคัดลอกไปอัดเสียงเองได้ทันที สคริปต์แก้ข้อความได้ก่อนอัดเสมอ" | guide |
| "โปรเจกต์ การสร้างงานใหม่ ไทม์ไลน์ และการอัดเสียงพากย์ อยู่ในห้องตัดต่อบนเว็บทั้งหมด ไม่ต้องติดตั้งโปรแกรม บัญชีเดียวกันนี้เข้าใช้ได้เลย" | "โปรเจกต์ การสร้างงานใหม่ และไทม์ไลน์ อยู่ในห้องตัดต่อบนเว็บทั้งหมด …" | /account |

## 14. /pricing: the opening answer in three paragraphs

The answer under "เลือกตามปริมาณงาน" was one eight-line paragraph. It is now
three — the free trial, the monthly plans, how paying works — with the same
words; the only change is where the paragraphs break, so two runs of the
old source no longer exist in one piece: "ไม่ต้องผูกบัตร ใช้หมดแล้วเลือกแพลนรายเดือนได้"
and ") ชำระด้วยบัตรเครดิตหรือเดบิต เปลี่ยนหรือยกเลิกแพลนได้เองจากหน้าบัญชี".

## Text added (not replacing anything)

Only labels, no claims:

- "ภาพจำลองการทำงาน" / "ภาพจำลอง" on every UI illustration (hero editor,
  sign-in stage, step illustrations, the three feature pictures and the six
  micro-demos on the home page, the 404 timeline, the example quota meters on
  /pricing, which also keep "ตัวอย่างการแสดงผล").
- /pricing ends on the same closing band as the home page, with the home
  page's own words ("ลองตัดคลิปแรกวันนี้", "สมัครแล้วได้เครดิตทดลองฟรีทันที …")
  and the site's usual "เริ่มใช้ฟรี" button.
- Editor furniture drawn as decoration and hidden from assistive technology:
  track labels (V1, A1, R1…, L1…, Q01…, CH1…), timecodes, file names in the
  guide bin ("ai-cut-tiktok.mov" …), "BIN", "MSG", "END".
- The editor illustrations (hero, sign-in stage, the three steps, the
  feature pictures and strips) are the app's own screens: every label in them
  is copied from the editor's code (`web/src`), and they show an example
  project — a serum review cut from five clips, with the script lines
  "ทุกเช้าต้องมีเซรั่มขวดนี้", "เนื้อบางเบา ไม่เหนอะหนะ", "หยดเดียวก็ทั่วหน้า",
  "ขวดเล็กมีหลอดหยด พกใส่กระเป๋าได้", "กดตะกร้าด้านล่างได้เลย" and the
  captions the editor derives from them. All inside figures labelled
  "ภาพจำลอง…"; the pictures are hidden from assistive technology.
- The hero's editor and the third step's timeline can be used (scrub, pick a
  scene): the playhead slider is named "หัวเล่น" with the time as its value
  ("0:04.2 จาก 0:14"), each scene button "ฉาก N · ยาว X.XX วิ", and the notes
  on hover or focus reuse the home page's own words — "แก้ทับได้ทุกช็อต",
  "พากย์เสียง พร้อมสคริปต์จาก AI", "ใส่เพลงประกอบ", "ซับไทยอัตโนมัติ",
  "AI ตัดคลิปให้อัตโนมัติ".
- /about: once the contact form has sent, the form gives way to its
  confirmation and a "ส่งอีกข้อความ" button (the empty form with a gold send
  button invited sending the same message again).
- /pricing: the clips slider label "ใช้ประมาณกี่คลิปต่อเดือน"; its readout is
  built from `plans.ts` only (`clipsHeadline`, `FREE_CLIPS_CAPTION`) with
  `CLIPS_FOOTNOTE` under it.

No testimonials, client logos, ratings or measured-looking numbers were
added. The running timecode beside "งานที่กินเวลาที่สุด ไม่ใช่การถ่าย แต่เป็นการตัด"
on the home page is decoration (`aria-hidden`): it counts up from zero while
the section is on screen, like an editor's clock, and states no measured
time.
