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

## 7. Article and /pricing stamps: the separator binds to the date

Old: `อัปเดตล่าสุด <date> · เขียนโดย <author>` as one run of text, and on
/pricing `อัปเดตล่าสุด <date> · ราคาเป็นเงินบาทต่อเดือน`.

New: the same words, but the " · " is joined to the date with a no-break
space and the part after it ("เขียนโดย <author>", "ราคาเป็นเงินบาทต่อเดือน")
is kept on one line, so a narrow screen breaks after the dot instead of
stranding "Noey Studio" or "ต่อเดือน", or starting a line with "·". The source
no longer holds the literals "· เขียนโดย" and "· ราคาเป็นเงินบาทต่อเดือน" in
one piece; what a reader sees is unchanged.

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

## 15. /about: the form is "in this page", not "beside"

Old: "…ส่งข้อความหาเราได้จากแบบฟอร์มข้าง ๆ บอกชื่อโปรเจกต์…" (the full sentence:
"ถ้าติดปัญหาหรืออยากให้ระบบทำอะไรเพิ่ม ส่งข้อความหาเราได้จากแบบฟอร์มข้าง ๆ บอกชื่อโปรเจกต์ โหมดที่ใช้ และสิ่งที่เกิดขึ้น จะช่วยให้ตรวจสอบได้เร็วขึ้นมาก คำถามที่ถูกถามซ้ำหลายครั้งมักจบลงในหน้าคู่มือหรือหน้าช่วยเหลือ เพื่อให้คนถัดไปหาคำตอบได้เองโดยไม่ต้องรอ").

New: "แบบฟอร์มในหน้านี้". The form sits beside the story only on wide screens;
below 1100px it follows the story, where "ข้าง ๆ" pointed at nothing.

## 16. Status cards: the eyebrow names the task

Old: "บัญชีของฉัน" over /reset-password and /account-deleted.

New: "รหัสผ่าน" on /reset-password (the visitor is not signed in there) and
"ลบบัญชี" on /account-deleted (the account no longer exists).

## 17. Legal pages: typography only

- Terms §12: the straight quotes around "ตามสภาพที่เป็น" and "เท่าที่มีให้ใช้ได้"
  are typographic quotes (“ ”). Old: `บริการให้ "ตามสภาพที่เป็น" และ "เท่าที่มีให้ใช้ได้"`.
- The related card for /pricing: "ราคา ขีดจำกัดของแต่ละแพลน และการยกเลิก" →
  "ขีดจำกัดของแต่ละแพลน และการยกเลิก" (the card's title already says ราคา).
- Privacy §01 and §02: the items they list are drawn as a list; the words are
  unchanged.

## 18. Status pages: password, checkout, the eyebrow on the title strip

- /reset-password: the button "ตั้งรหัสผ่านใหม่" → "บันทึกรหัสผ่านใหม่" (the
  page's title already says ตั้งรหัสผ่านใหม่; it said it three times). The
  line under the title "ตั้งรหัสผ่านใหม่อย่างน้อย 8 ตัวอักษร เสร็จแล้วระบบจะพา
  เข้าสู่ระบบให้ทันที" → "บันทึกแล้วระบบจะพาเข้าสู่ระบบให้ทันที", and "อย่างน้อย
  8 ตัวอักษร" moved from the first field's placeholder to a hint under it.
- /login's forgot-password dialog: title "ตั้งรหัสผ่านใหม่" → "ลืมรหัสผ่าน" (it
  only emails a link — the error on /account already calls it “ลืมรหัสผ่าน”);
  its "ปิด" button is gone (the dialog has its ✕ and Escape).
- /checkout/success, confirmed: "อัปเกรดเป็นแพลน Pro แล้ว" → "แพลน Pro
  เริ่มใช้งานแล้ว" (under the title "ขอบคุณที่อัปเกรดแพลน", it repeated
  อัปเกรด…แพลน).
- Every status card: the eyebrow ("การชำระเงิน", "ยืนยันอีเมล", "รหัสผ่าน",
  "ลบบัญชี") moved from above the title onto the card's title strip.
- The beta notice: the "เบต้า" chip beside its title is gone (the title
  begins "ช่วงเบต้า"); the dialog opens with a panel title strip instead —
  "BETA" and "ถึง 31 ธ.ค. 2026" (the beta's own end date, `BETA_END_LABEL`),
  decoration hidden from assistive technology.

## 19. Account: one name per place, one label per field, one date format

- /account's tab: "ห้องตัดต่อ" → "บัญชีของฉัน", with the person icon instead of
  the scissors. The header's account menu, the footer and the page's own
  title already call /account "บัญชีของฉัน"; "ห้องตัดต่อ" is the editor's name
  (its card on that tab and its button keep it).
- On a phone the four tabs sit side by side under short names: "บัญชี",
  "โควตา", "แพลน", "โปรไฟล์" (the full names, cut at the screen's edge, were
  "แพลนแล…" and a stray "ลิมิต"). From 481px wide the full names are shown.
- /account/profile, change password: "รหัสผ่านเดิม" → "รหัสผ่านปัจจุบัน", the name
  the email form and the delete dialog already use for the same password.
  The email form's password field gets a hint, "ใส่รหัสผ่านเพื่อยืนยันการเปลี่ยนอีเมล".
- /account/billing, payment card: the "รอบบิลถัดไป" / "ใช้แพลนได้ถึง" row is
  shown only when the plan card's status line does not already give that
  date ("ต่ออายุอัตโนมัติ …", "ยกเลิกแล้ว ใช้ได้ถึง …"), and not at all when
  there is no date (it printed "—").
- /account/billing dates: "13 ตุลาคม 2569" → "13 ต.ค. 2026" — short month,
  Common Era year, the calendar of the beta strip and the plan dialog on the
  same screen ("31 ธ.ค. 2026").
- /account/billing notices pointed at a button that does not exist (the
  button on a free account reads "เลือกแพลน"; this was wrong before the
  redesign too):
  - "การชำระเงินของแพลนล่าสุดไม่สำเร็จ บัญชีจึงกลับมาใช้แพลนฟรี เลือกแพลนใหม่ได้จากปุ่มอัปเกรดแพลน"
    → "…เลือกแพลนใหม่ได้จากปุ่ม “เลือกแพลน”"
  - "สมัครบัญชีเรียบร้อยแล้ว ตอนนี้ใช้แพลนฟรีอยู่ กด “อัปเกรดแพลน” เพื่อไปหน้าชำระเงินของแพลน"
    → "…กด “เลือกแพลน” เพื่อไปหน้าชำระเงินของแพลน"

## 20. Home, /scope, /pricing: the final review

- /pricing, the opening answer: the hero keeps the free trial and how paying
  works ("Noey Studio ให้เครดิตทดลองฟรีก้อนเดียวเมื่อสมัคร …", "ชำระด้วยบัตรเครดิต
  หรือเดบิต เปลี่ยนหรือยกเลิกแพลนได้เองจากหน้าบัญชี"). The sentence listing every
  plan's price and clip count ("ใช้หมดแล้วเลือกแพลนรายเดือนได้ 6 ระดับ ได้แก่ …")
  moved, word for word, to just under the plan cards — in the hero it was a
  wall of numbers above the same numbers. The beta clause that ended the
  third paragraph, "ราคาที่แสดงคือราคาเบต้า ลด 50% หมดวันที่ 31 ธ.ค. 2026
  รอบบิลถัดจากนั้นคิดราคาปกติทุกบัญชี รวมคนที่สมัครไว้แล้ว", is gone from the hero:
  the strip right above the cards says the same terms
  ("ราคาเบต้า ลด 50% ถึง 31 ธ.ค. 2026 · หลังจากนั้นรอบบิลถัดไปคิดราคาปกติทุกบัญชี
  รวมคนที่สมัครไว้แล้ว"), and so do the FAQ and the table's note.
- Each discounted plan card (home and /pricing): the line
  "เบต้า · ลด 50% ถึง 31 ธ.ค. 2026 จากนั้นคิดราคาปกติ" → a chip, "เบต้า −50%",
  beside the struck regular price. The terms are said in full once, in the
  strip above the cards; the line repeated them six times on /pricing.
- /pricing, under the cards: the "แพลนเพิ่มเติม" heading with nothing under it
  became a legend — the same tag the three cards carry, then its meaning
  (the note itself is unchanged).
- Home: the section eyebrows "ความสามารถหลัก", "วิธีใช้งาน", "ขอบเขตของระบบ"
  and "ราคา" are gone. Every section on home, /scope and /pricing now opens
  the same way — a marker and its time on the page's timeline — where home's
  four had a gold label and the other eleven none.
- Home, the closing band: "สมัครใช้งาน" → "เริ่มใช้ฟรี", the label of the same
  link everywhere else on the site.
- Home, the hero's fine print: where the computer-only note shows (phones,
  tablets), its last part, "ใช้ได้เฉพาะบนคอมผ่าน Chrome หรือ Edge", is not
  repeated under the note.

## 21. Sign-in pages and /about: the final review

- /reset-password with a broken link: the card's title "ตั้งรหัสผ่านใหม่" →
  "ลิงก์นี้ใช้ไม่ได้แล้ว" (it repeated the form's title over a dead link);
  "ตั้งรหัสผ่านใหม่" moved to the card's title strip.
- /signup: the password field's placeholder "อย่างน้อย 8 ตัวอักษร" became a
  hint under the field (as on /reset-password; a placeholder vanishes while
  typing). A taken email is said once, in full, under the email field —
  "อีเมลนี้มีบัญชีอยู่แล้ว เข้าสู่ระบบด้วยอีเมลนี้ได้เลย" — instead of the short
  form there and the long one again above the button.
- /about, the fifth principle: "…รายละเอียดเรื่องข้อมูลกับสิทธิในผลงานอยู่ในหน้า
  ความเป็นส่วนตัวและเงื่อนไขการใช้งาน" — same words, the two pages it names are
  now links. Old source string: "ดาวน์โหลดไฟล์ที่เรนเดอร์แล้วได้ตลอด และรายละเอียดเรื่องข้อมูลกับสิทธิในผลงานอยู่ในหน้าความเป็นส่วนตัวและเงื่อนไขการใช้งาน".
- Sign-in forms (/login, /signup, the forgot-password dialog,
  /reset-password): empty or short fields are answered by the forms' own Thai
  messages (the server's checks) instead of the browser's English bubbles,
  and a failed submit keeps what was typed.

## 22. Account: the final review

- /account/billing, the plan card is drawn from /pricing's card for the same
  plan, with its words from `plans.ts`: the reel number ("P3"), the
  "เบต้า −50%" chip beside the struck price, the clips line ("ตัดได้ราว 22 คลิป
  / เดือน", "~คลิปดิบ 5 นาที") and /pricing's feature bullets instead of the
  account-only ones. So, for Pro: "เก็บโปรเจกต์ไม่จำกัดจำนวน · 10 GB" →
  "จำนวนโปรเจกต์ไม่จำกัด ภายใน 10 GB", and "ทำงาน AI พร้อมกันได้ 2 งาน" is
  listed as on /pricing. The free plan shows its price, "0 บาท", as on /pricing.
- /account/billing, the plan picker: every row states the same three facts —
  clips a month, footage per project, storage — where each row had its own
  summary (Pro's was "ตัดได้ราว 22 คลิป/เดือน · วิเคราะห์ระดับละเอียด · 10 GB",
  Studio's "ตัดได้ราว 45 คลิป/เดือน · ทำงานพร้อมกัน 3 งาน · 30 GB"), so the plans
  compare down the list; the held plan's " · แพลนปัจจุบัน" became a tag,
  "แพลนปัจจุบัน"; each row carries its reel number. The beta line above the
  rows keeps its words, with the "เบต้า" badge of the strip on /pricing.
- /account/profile, change password: "อย่างน้อย 8 ตัวอักษร" moved from the new
  password's placeholder to a hint under it (as on /signup and
  /reset-password).
- /account/quota: "ทำงาน AI พร้อมกันได้ N งาน" moved from the windows' card to
  the jobs' card (the same words).

## 23. The owner's wording pass (2026-10-01)

Asked for by the owner, point by point; every change below is theirs.

**Terms**

- Everywhere: "ร่างแรก" → "ดราฟต์แรก" — the Thai word read too formal; the
  loanword is what creators say. The same for the one bare "ร่าง" (/guide/thai-subtitles):
  "สิ่งที่ยังต้องระวังคือการสลับภาษาทั้งประโยคไปมาในคลิปเดียว ข้อความที่ได้อาจสะกดคำอังกฤษไม่ตรงรูปที่คุณต้องการ ให้ถือว่าเป็นร่างที่ต้องอ่านทวนก่อนเรนเดอร์เสมอ"
  → "…ให้ถือว่าเป็นดราฟต์ที่ต้องอ่านทวนก่อนเรนเดอร์เสมอ".
- "ทั้งกอง" ("the whole pile" of footage) read as unclear: it is now "ทุกไฟล์" or
  "ทุกคลิป", sentence by sentence (listed below).

**Claims the product does not make**

- The silence mode cuts pauses; nothing in the pipeline finds a stumble, a
  misspoken line or a sentence said twice. Removed wherever the site said or
  implied it:
  - /scope, step 2: "เลือกช่วงที่เนื้อหาต่อกันได้ ตัดช่วงเงียบและช่วงพูดพลาดออก แล้วเรียงเป็นร่างแรก"
    → "เลือกช่วงที่เนื้อหาต่อกันได้ ตัดช่วงเงียบออก แล้วเรียงเป็นดราฟต์แรก".
  - Home, the problem: "ครีเอเตอร์ส่วนใหญ่ถ่ายคลิปหนึ่งตัวจบภายในไม่กี่นาที แต่ใช้เวลาอีกหลายเท่าไปกับการไล่ดูฟุตเทจ หาช่วงที่พูดรู้เรื่อง ตัดช่วงที่พูดผิดออก พิมพ์ซับ แล้วจัดจังหวะใหม่อีกรอบ ยิ่งลงคลิปถี่ เวลาส่วนนี้ยิ่งกลืนทั้งวัน"
    → "…หาช่วงที่พูดรู้เรื่อง ตัดช่วงเงียบออก พิมพ์ซับ…".
  - /about, chapter 3: "เครื่องมือนี้ถูกใช้กับงานจริงทุกวันก่อนจะเปิดให้คนอื่นใช้ สิ่งที่อยู่ในระบบวันนี้จึงมาจากปัญหาที่เจอเองซ้ำ ๆ เช่น การไล่ฟุตเทจหลายไฟล์เพื่อหาเทกที่ใช้ได้ การพิมพ์ซับทีละบรรทัด และการอัดเสียงพากย์ใหม่เฉพาะประโยคที่พูดพลาด ฟีเจอร์ที่ไม่ได้แก้ปัญหาซ้ำแบบนั้น เราเลือกที่จะยังไม่ทำ"
    → "…เช่น การไล่ฟุตเทจหลายไฟล์เพื่อหาเทกที่ใช้ได้ และการพิมพ์ซับทีละบรรทัด ฟีเจอร์ที่…" (the web editor does not record either, §13).
  - The editor's own wizard prints "ตัดช่วงพูดติดหรือพูดซ้ำออก" under the
    silence mode; the site's drawing of that screen leaves the line
    unpainted (it keeps its place), and the claim should be fixed in the
    editor itself.
- ตัดฉากเด่น does not use the clips' own sound — a new voiceover (an AI
  script or your own) or music only:
  - Home, step 2: "เลือกโหมด ความยาวที่ต้องการ และจะใช้เสียงในคลิปเดิมหรือพากย์ใหม่ จากนั้นกดปุ่มเดียวแล้วรอผล"
    → "เลือกหนึ่งในสามโหมดให้ตรงกับคลิป แล้วตั้งค่าของโหมดนั้น จากนั้นกดปุ่มเดียวแล้วรอผล".
  - Home, the steps' intro: "ขั้นตอนใช้งานมีสามขั้น คือลากฟุตเทจเข้ามา เลือกโหมดและความยาวที่ต้องการ แล้วดูผล เกลาในไทม์ไลน์ และดาวน์โหลดไฟล์ วิดีโอแนวตั้ง 1080×1920 การแก้และเรนเดอร์ซ้ำทำได้ไม่จำกัดครั้งโดยไม่กินโควตา"
    → "…เลือกโหมดที่ตรงกับคลิป แล้วดูผล…".
  - /guide/ai-cut-tiktok, step two: "ขั้นที่สองคือบอกว่าอยากได้คลิปแบบไหน เลือกโหมดการตัด ความยาวที่ต้องการ และเลือกว่าจะใช้เสียงในคลิปเดิม พากย์ใหม่ด้วยเสียงตัวเอง หรือใส่เพลงประกอบแทน จากนั้นกดเริ่มแล้วรอ ระบบถอดเสียงทั้งกองฟุตเทจก่อน แล้วค่อยเลือกช่วงจากสิ่งที่พูดจริง ไม่ใช่สุ่มตัดตามเวลา"
    → "ขั้นที่สองคือบอกว่าอยากได้คลิปแบบไหน เลือกโหมดการตัดให้ตรงกับคลิป ถ้าเป็นโหมดตัดฉากเด่น ให้เลือกความยาว และเลือกว่าจะให้ AI เขียนสคริปต์พากย์ พิมพ์สคริปต์เอง หรือไม่พากย์แล้วใส่เพลงประกอบแทน จากนั้นกดเริ่มแล้วรอ ระบบอ่านฟุตเทจทุกไฟล์ก่อน โหมดที่ใช้เสียงเดิมฟังจากสิ่งที่พูด โหมดตัดฉากเด่นดูจากภาพ แล้วค่อยเลือกช่วง ไม่ใช่สุ่มตัดตามเวลา".
  - The same guide, the modes: "โหมดตัดฉากเด่น เหมาะกับคลิปขายของที่ถ่ายไว้หลายคลิป ระบบเลือกช็อตที่โชว์สินค้าได้ชัดจากทั้งกอง เรียงใหม่ตามสคริปต์ขาย แล้วให้คุณเลือกว่าจะพากย์ทับหรือใส่เพลง ส่วนโหมดตัดไฮไลต์จากคลิปยาว เหมาะกับคลิปพูดยาวหรือไลฟ์ที่อยากแยกออกมาเป็นคลิปสั้นหลายตัว โดยคงเสียงเดิมไว้ทั้งหมด"
    → "…จากทุกคลิปที่ลากเข้ามา เรียงใหม่ตามสคริปต์ขาย แล้วให้คุณเลือกว่าจะพากย์ใหม่หรือใส่เพลง โหมดนี้ไม่ใช้เสียงในคลิปเดิม ส่วนโหมดตัดไฮไลต์…".
  - The same guide, how the AI decides: "ก่อนตัด ระบบถอดเสียงในฟุตเทจออกมาเป็นข้อความพร้อมเวลาของแต่ละคำ นั่นคือเหตุผลที่คลิปที่พูดชัดจะได้ร่างแรกที่ดีกว่าคลิปที่เสียงลมแรงหรือไมค์อยู่ไกล ระบบใช้ข้อความนั้นเป็นฐานในการเลือกว่าช่วงไหนควรเก็บและช่วงไหนควรตัดทิ้ง"
    → "ในโหมดตัดช่วงเงียบและตัดไฮไลต์จากคลิปยาว ก่อนตัด ระบบถอดเสียง… ส่วนโหมดตัดฉากเด่น AI ดูภาพจากฟุตเทจทุกไฟล์แล้วเลือกช็อตที่โชว์สินค้าได้ชัด".
  - The same guide, the sound section: title "เสียงในคลิป: ใช้เสียงเดิม พากย์เอง หรือใส่เพลง"
    → "เสียงในคลิป: แต่ละโหมดใช้เสียงอะไร"; "ถ้าเลือกใช้เสียงเดิม ระบบเก็บเสียงจากฟุตเทจไว้ทั้งหมดและซับจะตรงกับสิ่งที่พูดโดยอัตโนมัติ เป็นทางที่เร็วที่สุดและเหมาะกับคลิปพูดหน้ากล้อง"
    → "โหมดตัดช่วงเงียบและโหมดตัดไฮไลต์จากคลิปยาวใช้เสียงเดิมจากฟุตเทจทั้งหมด ซับจึงตรงกับสิ่งที่พูดโดยอัตโนมัติ…"; the voiceover paragraph now opens "โหมดตัดฉากเด่นไม่ใช้เสียงในคลิปเดิม แต่พากย์ใหม่ … หรือคุณพิมพ์สคริปต์เอง …"; "ถ้าเลือกใส่เพลงประกอบ ระบบวางคัตให้เข้ากับจังหวะเพลงและปรับระดับเสียงได้ เพลงประกอบเปิดให้ใช้ตั้งแต่แพลน Lite ขึ้นไป แพลนฟรียังไม่มีส่วนนี้ เพลงที่อัปโหลดต้องเป็นเพลงที่คุณมีสิทธิใช้"
    → "ถ้าไม่อยากพากย์ ในโหมดตัดฉากเด่นเลือกไม่พากย์แล้วใส่เพลงประกอบแทนได้ ระบบวางคัตให้เข้ากับจังหวะเพลงและปรับระดับเสียงได้ …" — music, and cutting to its beat, belong to ตัดฉากเด่น only (the speech modes keep the clips' sound: `beatSync` needs `isCut` in web/src/lib/wizardState.ts). The beat line stays because the owner is turning snapping on for the web build (`canSnapToBeat`, today `!isBrowser`).
  - /guide/product-review, the answer: "คลิปรีวิวสินค้าเสียเวลาที่การไล่ดูเทกซ้ำ ๆ วิธีที่เร็วกว่าคือถ่ายหลายมุมสั้น ๆ แล้วให้ระบบคัดช็อตที่โชว์สินค้าชัดจากทั้งกอง เรียงตามสคริปต์ขาย ใส่ซับไทย และให้คุณพากย์ทับทีละประโยค เหลือแค่เกลาไทม์ไลน์รอบเดียวก่อนดาวน์โหลด"
    → "…คัดช็อตที่โชว์สินค้าชัดจากทุกคลิป เรียงตามสคริปต์ขาย ใส่ซับไทย และได้สคริปต์ให้คัดลอกไปพากย์เอง…".
  - The same guide: "งานนี้ซ้ำทุกวันและไม่ต้องใช้ความคิดสร้างสรรค์เลย มันคือการฟัง จำ แล้วเทียบ ซึ่งเป็นงานที่ระบบทำแทนได้ตรง ๆ เพราะระบบถอดเสียงทั้งกองได้ในรอบเดียวและไม่ลืมว่าเทกก่อนหน้าพูดอะไรไว้"
    → "…เพราะระบบดูฟุตเทจทุกไฟล์ได้ในรอบเดียว เลือกเทกที่ดีที่สุดของแต่ละช็อตไว้ และเก็บเทกอื่นเป็นช็อตสำรอง" (this mode reads the pictures, not the speech).
  - The same guide: "สำหรับคลิปขายของ ให้เลือกโหมดตัดฉากเด่น ระบบจะดูฟุตเทจทั้งกอง เลือกช็อตที่โชว์สินค้าได้ชัด แล้วเรียงใหม่เป็นลำดับที่เล่าเรื่องได้ ไม่ใช่เรียงตามเวลาที่ถ่าย"
    → "…ระบบจะดูฟุตเทจทุกไฟล์…".
  - /guide/help, the modes: "ตัดฉากเด่น — คลิปขายของ ระบบเลือกช็อตที่โชว์สินค้าเด่นจากหลายคลิป เรียงใหม่พร้อมสคริปต์ขาย เลือกได้ว่าจะพากย์ทับหรือใส่เพลง โหมดนี้ดูฟุตเทจทั้งกองในรอบเดียว จึงเห็นภาพรวมของทุกคลิปพร้อมกัน"
    → "…เลือกได้ว่าจะพากย์ใหม่หรือใส่เพลง ไม่ใช้เสียงในคลิปเดิม โหมดนี้ดูฟุตเทจทุกไฟล์ในรอบเดียว…".
  - /scope, what stays yours: "ระบบตัดสินจากเสียงเป็นหลัก ไม่ได้ตัดสินว่าภาพช่วงนั้นใช้ได้ไหม"
    → "ในโหมดที่ใช้เสียงเดิม ระบบตัดสินจากเสียงเป็นหลัก…" (ตัดฉากเด่น chooses by the picture).
- Home, step 1: "ลากคลิปจากมือถือหรือกล้องเข้ามาได้หลายไฟล์พร้อมกัน ระบบตรวจความยาวและความละเอียดให้ ไฟล์ฟอร์แมตแปลกก็แปลงให้ก่อน"
  → "…ระบบตรวจความยาวและความละเอียดให้" (owner: drop the format-conversion line).

**"ทั้งกอง"**

- /scope, intro: "Noey Studio ไม่ใช่โปรแกรมตัดต่อที่ทำแทนทั้งกระบวนการ และไม่ใช่ปุ่มเดียวจบ สิ่งที่ระบบทำคือขั้นตอนที่ซ้ำและกินเวลาที่สุดของคลิปสั้น — ฟังฟุตเทจทั้งกอง หาว่าช่วงไหนพูดได้ดี ตัดช่วงที่ไม่เอาออก แล้วพิมพ์ซับตามที่พูด สามอย่างนี้ระบบทำให้เสร็จก่อนคุณจะเปิดไทม์ไลน์ครั้งแรก ที่เหลือคือการเกลา ซึ่งยังเป็นงานของคุณ"
  → "…ฟังฟุตเทจทุกไฟล์…"; the same sentence in /llms.txt: "> Noey Studio ทำขั้นตอนที่ซ้ำและกินเวลาที่สุดของคลิปสั้น คือฟังฟุตเทจทั้งกอง หาช่วงที่พูดได้ดี ตัดช่วงที่ไม่เอาออก และใส่ซับไทยตามที่พูด สามอย่างนี้เสร็จก่อนคุณเปิดไทม์ไลน์ครั้งแรก ส่วนการเกลาจังหวะและลำดับการเล่ายังเป็นงานของคุณ"
  → "…คือฟังฟุตเทจทุกไฟล์…".
- /scope, step 1 title: "ถอดเสียงทั้งกอง" → "ถอดเสียงทุกไฟล์".

**Sign-up**

- The line under the terms box, "ติ๊กยอมรับเงื่อนไขก่อนจึงจะสมัครได้", is gone
  (the box stays drawn as the empty slot the locked buttons wait on).

**Browsers: Safari 26 and up too**

The editor's own gate names "Chrome หรือ Edge เวอร์ชันล่าสุด หรือ Safari 26 ขึ้นไป"
(web/src/platform/WebGate.tsx); the owner chose to say the same on the site.

- Everywhere: "Chrome หรือ Edge เวอร์ชันใหม่" → "Chrome หรือ Edge เวอร์ชันใหม่ หรือ Safari 26 ขึ้นไป"
- Home, the hero's fine print: "สมัครแล้วได้เครดิตทดลองฟรี · ไม่ต้องผูกบัตร · ใช้ได้เฉพาะบนคอมผ่าน Chrome หรือ Edge"
  → "… · ใช้ได้เฉพาะบนคอมผ่าน Chrome, Edge หรือ Safari 26 ขึ้นไป"; the computer-only
  note likewise ("…ผ่าน Chrome, Edge หรือ Safari 26 ขึ้นไป ยังใช้บนมือถือหรือแท็บเล็ตไม่ได้").
- FAQ: "คอมทั่วไปที่รัน Chrome เวอร์ชันใหม่ได้ก็พอ เครื่องที่แรงกว่าจะเรนเดอร์เสร็จเร็วกว่า และคลิปยิ่งยาวก็ยิ่งใช้เวลานานขึ้นตามส่วน"
  → "คอมทั่วไปที่รัน Chrome หรือ Edge เวอร์ชันใหม่ หรือ Safari 26 ขึ้นไปได้ก็พอ …".
- Structured data (`operatingSystem`): "Web browser (Chrome, Edge)" → "Web browser (Chrome, Edge, Safari 26+)".

## 24. Account: the last review round

- /account/billing, the plan picker: each row's price and clips are spaced as
  /pricing prints them — "99 บาท/เดือน" → "99 บาท / เดือน", "ตัดได้ราว 4 คลิป/เดือน"
  → "ตัดได้ราว 4 คลิป / เดือน" — and Pro and up add their ระดับละเอียด count as
  a fact of its own ("ระดับละเอียดราว 20 คลิป", lib/plans.ts: a plan bought for
  that setting states both). The storage fact is named: "3 GB" → "เก็บได้ 3 GB".
- Storage sizes print a whole number whole: "10.0 GB" → "10 GB" (as /pricing
  writes it); a fraction keeps its one decimal ("3.7 GB").
- /account, the summary: the quota row is named by its window, as the quota
  tab names it — "โควตารอบนี้" → "Monthly limit" (with more than one window,
  the fullest one's name; "โควตารอบนี้" stays where the account has none).

## 25. Final review round: profile and sign-in labels

- /account/profile, the email form: its password field "รหัสผ่านปัจจุบัน" →
  "ยืนยันด้วยรหัสผ่าน" (the password form below asks for the same password
  under "รหัสผ่านปัจจุบัน"; two identical labels on one screen read as one
  field).

## 26. /pricing: the clip calculator (owner, 2026-10-01)

The owner asked for counts a visitor can price on their own footage: pick the
mode, set the raw-clip length (it was fixed at 5 minutes), and every count on
/pricing follows. The modes cost very differently (ตัดช่วงเงียบ only
transcribes), so every count now says which mode it assumes. ตัดฉากเด่น at
5 minutes stays the default and the basis every other page states.

**Reworded**

- The basis under every clip count (cards, home strip, account billing):
  "~คลิปดิบ 5 นาที" → "คิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที" — a count read alone
  must say which mode it is for.
- The basis sentence (home, help table, FAQ, guides, /pricing.md, llms.txt):
  "คิดจากคลิปดิบ 5 นาที ปัดลง · คลิปที่ยาวกว่าหรือระดับละเอียดใช้โควตามากกว่า · ระบบบอกก่อนเริ่มทุกครั้งว่างานนี้ใช้เท่าไหร่"
  → "คิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที ปัดลง · …" (the rest unchanged). On
  /pricing the picker's copy follows the calculator: "คิดจากโหมด<mode> คลิปดิบ
  <n> นาที ปัดลง · <clause> · ระบบบอกก่อนเริ่มทุกครั้งว่างานนี้ใช้เท่าไหร่", the
  clause being "คลิปที่ยาวกว่าใช้โควตามากกว่า" (ตัดช่วงเงียบ), the original one
  (ตัดฉากเด่น) or "หนึ่งคลิปยาวแยกได้หลายคลิปสั้น" (ตัดไฮไลต์จากคลิปยาว).
- /pricing, "โควตาคิดยังไง":
  "เรานับเป็นจำนวนคลิปที่ AI ตัดให้ต่อเดือน เพราะงานหนักของแต่ละคลิปคือการถอดเสียงและการวางแผนตัด ซึ่งใช้กำลังใกล้เคียงกันไม่ว่าฟุตเทจจะยาวแค่ไหน ตัวเลขบนการ์ดคิดจากคลิปดิบ 5 นาทีและปัดลง แพลน Pro ขึ้นไปบอกทั้งจำนวนที่ระดับปกติและระดับละเอียด คลิปที่ยาวกว่าใช้โควตามากกว่า และหน้าตั้งค่าแสดงเป็นเปอร์เซ็นต์ของรอบที่เหลือ"
  → "…ตัวเลขบนการ์ดคิดจากโหมดและความยาวคลิปดิบที่ตั้งไว้ด้านบน ตั้งต้นที่โหมดตัดฉากเด่น
  คลิปดิบ 5 นาที และปัดลง แต่ละโหมดใช้โควตาไม่เท่ากัน แพลน Pro ขึ้นไป…" (the rest
  unchanged).
- /pricing, the answer under the title and the "Trial credit" rule: "ตัดได้
  ราว 2 คลิป" gains its basis, "(คิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที)".
- /pricing, the sentence under the cards ends on its basis, "(คิดจากโหมดตัดฉากเด่น
  คลิปดิบ 5 นาที)", and its counts follow the calculator like the cards'.
- /pricing, the comparison table now has a note under it (it had none there):
  "จำนวนคลิปในตารางคิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที ตามที่ตั้งไว้ในส่วนแพลนด้านบน
  ปัดลง", following the calculator.
- The clips picker's label "ใช้ประมาณกี่คลิปต่อเดือน" and its readout "คลิป / เดือน"
  say "คลิปยาว" in ตัดไฮไลต์จากคลิปยาว.
- The editor drawing on the home page (the wizard's estimate): "งานนี้ใช้ประมาณ
  5% ของโควตารายสัปดาห์" → "…ของโควตารายเดือน" — paid plans have one monthly
  window now, and the editor names it `limitLabel('monthly')`.

**Added** (all on /pricing, in the calculator above the cards)

- "โหมดที่ใช้", the three modes with their editor icons, names and footage
  lines from lib/modes.ts (the home page's "เหมาะกับ" lines).
- "ความยาวคลิปดิบของคุณ", a minutes field with "สั้นลง 1 นาที" / "ยาวขึ้น 1 นาที"
  steppers, "นาที", and "ความยาวต่อคลิป ตั้งได้ 1–30 นาที".
- "ความละเอียด" with "ปกติ" / "ละเอียด" (ตัดฉากเด่น only); in the other modes
  "โหมดนี้ไม่มีระดับละเอียด" in its place.
- One line on what drives each mode's cost:
  - ตัดช่วงเงียบ: "ใช้แค่การถอดเสียง ไม่มีขั้นที่ AI ดูภาพหรืออ่านเนื้อหา จึงใช้โควตาน้อยที่สุดในสามโหมด"
  - ตัดฉากเด่น: "AI ดูฟุตเทจทุกวินาทีแล้วเขียนสคริปต์ ยิ่งคลิปยาว หรือเลือกระดับละเอียด (แพลน Pro ขึ้นไป) ยิ่งใช้โควตามาก"
  - ตัดไฮไลต์จากคลิปยาว: "ถอดเสียงแล้วให้ AI อ่านทั้งคลิปและเกลาทีละไฮไลต์ จำนวนไฮไลต์รู้ได้หลังอ่านจบ ระบบจึงคิดเผื่อไว้สูงและบอกเป็นจำนวนขั้นต่ำ"
  (ตัดฉากเด่น and ตัดไฮไลต์จากคลิปยาว swap places as clips get longer, so
  neither is called the dearer.)
- In ตัดไฮไลต์จากคลิปยาว every count reads "อย่างน้อย N คลิปยาว" ("ตัดได้อย่างน้อย
  N คลิปยาว / เดือน" on a card): the estimate assumes up to one highlight a
  minute, above what real runs produce, so the count is a floor.
- Past a plan's footage ceiling a count is replaced by "เกินเพดานฟุตเทจของแพลนนี้
  (10 นาที)" on a card (the plan's own ceiling) and "เกินเพดานฟุตเทจ" in the table
  and the sentence.
- For screen readers only, once per change: "คิดใหม่ตามโหมด<mode> คลิปดิบ <n>
  นาที" (plus " ระดับละเอียด").

No count is invented: each is the plan's budget divided by what the backend
charges for one cut of that mode and length (lib/plans.ts `cutCost`, pinned
against the backend's own results in cut-calculator.test.ts). No token count
is printed anywhere.

## 27. The footage ceiling is ตัดฉากเด่น's alone (owner, 2026-10-01)

The per-plan footage ceiling (ฟรี/Lite 10 นาที, Starter 20, Pro ขึ้นไป 30)
applies to ตัดฉากเด่น only. ตัดช่วงเงียบ and ตัดไฮไลต์จากคลิปยาว take up to 2
ชั่วโมงต่อโปรเจกต์ on every plan (the editor's `capSecFor`); within that, the
plan's quota is what limits a run. Every sentence that said one ceiling for
every mode is rewritten; the two hours is stated by one constant,
`SPEECH_FOOTAGE_NOTE`: "โหมดตัดช่วงเงียบและตัดไฮไลต์จากคลิปยาวรับฟุตเทจรวมได้ถึง 2
ชั่วโมงต่อโปรเจกต์ทุกแพลน".

- Plan cards, the account card and the free FAQs: "ฟุตเทจรวม 10 นาทีต่อโปรเจกต์"
  → "ฟุตเทจรวมโหมดตัดฉากเด่น 10 นาทีต่อโปรเจกต์" (every plan, `footageFeature`);
  the upgrade dialog and /account/billing: "ฟุตเทจ 10 นาทีต่อโปรเจกต์" →
  "ฟุตเทจตัดฉากเด่น 10 นาทีต่อโปรเจกต์". The old template parts:
  "ใช้ได้ครบทุกโหมด ฟุตเทจรวม", "ต่อโปรเจกต์ วิเคราะห์ระดับปกติ และเก็บได้ 3 โปรเจกต์ภายใน 1 GB เครดิตนี้ไม่รีเซ็ตรายเดือน ใช้หมดแล้วเลือกแพลนรายเดือนต่อได้",
  "ได้ เครดิตทดลองฟรีที่ได้ตอนสมัครใช้ได้ครบทุกโหมดรวมโหมดพากย์ใหม่ ฟุตเทจรวม",
  "ต่อโปรเจกต์ วิเคราะห์ระดับปกติ และเก็บได้ 3 โปรเจกต์ภายใน 1 GB เครดิตนี้เป็นก้อนเดียว ไม่รีเซ็ตรายเดือน".
- The comparison table: the row "ฟุตเทจรวมต่อโปรเจกต์" → "ฟุตเทจรวมต่อโปรเจกต์
  โหมดตัดฉากเด่น", and a new row under it, "ฟุตเทจรวมต่อโปรเจกต์
  โหมดตัดช่วงเงียบและตัดไฮไลต์จากคลิปยาว", "2 ชั่วโมง" on every plan.
- /pricing, the quota rules: "เพดานเดียวต่อแพลน ใช้กับทุกโหมดเท่ากัน —" + ladder
  → "โหมดตัดฉากเด่นมีเพดานต่อแพลน —" + ladder + " · " + the note + " ภายในนั้นโควตาของแพลนเป็นตัวกำหนด".
- FAQ "คลิปยาวแค่ไหนถึงจะใช้ได้": "ขึ้นกับแพลน ความยาวฟุตเทจรวมต่อโปรเจกต์คือ" +
  ladder + "เพดานนี้ใช้กับทุกโหมดเท่ากัน ถ้าฟุตเทจยาวกว่านั้นให้ตัดให้สั้นลงก่อนหรือแยกเป็นสองโปรเจกต์ ส่วนโควตานับเป็นจำนวนคลิปต่อเดือน ไม่ได้นับเป็นนาที ดูรายละเอียดได้ในหน้าราคา"
  → "ขึ้นกับโหมด ในโหมดตัดฉากเด่น ความยาวฟุตเทจรวมต่อโปรเจกต์ขึ้นกับแพลน คือ" +
  ladder + " ส่วน" + the note + " ถ้าฟุตเทจยาวกว่านั้นให้ตัดให้สั้นลงก่อนหรือแยกเป็นสองโปรเจกต์
  โควตานับเป็นจำนวนคลิปต่อเดือน ไม่ได้นับเป็นนาที ภายในเพดานนี้โควตาของแพลนเป็นตัวกำหนดว่าตัดได้กี่คลิป ดูรายละเอียดได้ในหน้าราคา".
- FAQ "อัปเกรดแล้วรับฟุตเทจยาวขึ้นไหม": "ขึ้นถึงจุดหนึ่ง ความยาวฟุตเทจรวมต่อโปรเจกต์คือ"
  → "ขึ้นถึงจุดหนึ่ง ในโหมดตัดฉากเด่น ความยาวฟุตเทจรวมต่อโปรเจกต์คือ", and it ends on
  " ส่วน" + the note + "อยู่แล้ว".
- /llms.txt and /pricing.md: "- ความยาวฟุตเทจรวมต่อโปรเจกต์:" + ladder + " เพดานเดียวใช้กับทุกโหมด"
  → "- ความยาวฟุตเทจรวมต่อโปรเจกต์ โหมดตัดฉากเด่น:" + ladder + " · " + the note.
- /guide/ai-cut-tiktok, step 1: "ขั้นแรกคือเอาฟุตเทจเข้าระบบ ลากไฟล์จากมือถือหรือกล้องเข้าหน้าเว็บได้หลายไฟล์พร้อมกัน ระบบอ่านความยาวรวมและความละเอียดของทุกไฟล์ แล้วเทียบกับเพดานฟุตเทจของแพลนที่ใช้อยู่ก่อนเริ่มงาน ถ้าเกินเพดาน ระบบบอกตั้งแต่ตอนนั้น ไม่ปล่อยให้ไปเสียเวลาตอนตัด"
  → "…แล้วเทียบกับเพดานฟุตเทจของโหมดและแพลนที่ใช้อยู่ก่อนเริ่มงาน…".
- /guide/ai-cut-tiktok, limits: "ความยาวฟุตเทจรวมต่อโปรเจกต์ขึ้นกับแพลน คือ" →
  "ในโหมดตัดฉากเด่น ความยาวฟุตเทจรวมต่อโปรเจกต์ขึ้นกับแพลน คือ" + ladder + " ส่วน" + the note + "…";
  and "เพดานความยาวนี้ใช้กับทุกโหมดเท่ากัน ไม่มีโหมดไหนได้มากกว่าหรือน้อยกว่า สิ่งที่ต่างกันคือความละเอียดการวิเคราะห์ แพลนฟรี Lite และ Starter วิเคราะห์ที่ระดับปกติเท่านั้น ตั้งแต่ Pro ขึ้นไปเลือกระดับละเอียดได้ ซึ่งให้ AI อ่านฟุตเทจละเอียดขึ้นแต่ใช้โควตามากกว่า"
  → "เพดานตามแพลนมีเฉพาะโหมดตัดฉากเด่น เพราะโหมดนี้ให้ AI ดูฟุตเทจทั้งหมด
  ส่วนอีกสองโหมดทำงานจากเสียงพูด ภายในสองชั่วโมงนั้นโควตาของแพลนเป็นตัวกำหนดว่าตัดได้กี่คลิป
  อีกเรื่องที่ต่างกันตามแพลนคือความละเอียดการวิเคราะห์ …" (the rest unchanged).
- /guide/product-review: "ฟุตเทจรวมต่อโปรเจกต์คือข้อจำกัดที่คนทำคลิปรีวิวชนบ่อยที่สุด เพราะถ่ายหลายมุมแล้วรวมกันยาวเร็ว เพดานคือ"
  → "…เพดานในโหมดตัดฉากเด่นคือ"; and "ไม่มีจำนวนตายตัว แต่ยิ่งมีมุมให้เลือกหลากหลาย ร่างแรกยิ่งไม่จำเจ ขอให้ฟุตเทจรวมไม่เกินเพดานของแพลน เช่น"
  → "…ขอให้ฟุตเทจรวมไม่เกินเพดานของแพลนในโหมดตัดฉากเด่น เช่น".
- /guide/long-to-shorts (ตัดไฮไลต์จากคลิปยาว):
  - "ถ้าคลิปยาวมีทั้งช่วงพูดและช่วงเงียบยาว ๆ สลับกัน ผลจะดีขึ้นถ้าตัดช่วงเงียบทิ้งคร่าว ๆ ก่อนอัปโหลด เพราะช่วงเงียบกินเพดานความยาวฟุตเทจของแพลนเท่ากับช่วงที่พูด"
    → "…เพราะช่วงเงียบนับรวมในความยาวฟุตเทจและใช้โควตาเท่ากับช่วงที่พูด".
  - "โหมดนี้ชนเพดานความยาวเร็วกว่าโหมดอื่น เพราะตั้งใจใช้กับคลิปยาว เพดานฟุตเทจรวมต่อโปรเจกต์คือ" + ladder
    → "โหมดนี้รับฟุตเทจรวมได้ถึง 2 ชั่วโมงต่อโปรเจกต์ทุกแพลน เพดานตามแพลนมีเฉพาะโหมดตัดฉากเด่น
    ภายในสองชั่วโมงนั้นโควตาของแพลนเป็นตัวกำหนดว่าตัดได้กี่คลิปยาวต่อเดือน คลิปยิ่งยาวยิ่งใช้โควตามาก
    ลองตั้งความยาวคลิปของคุณในหน้าราคาเพื่อดูว่าแต่ละแพลนพอสำหรับกี่คลิป".
  - FAQ "ไลฟ์ยาวสองชั่วโมงอัปโหลดได้ไหม": "ยังไม่ได้ในโปรเจกต์เดียว เพดานสูงสุดคือ" +
    "30 นาที" + "ต่อโปรเจกต์ตั้งแต่แพลน Pro ขึ้นไป ให้แบ่งไลฟ์เป็นหลายโปรเจกต์ตามช่วงเวลา หรือตัดเฉพาะช่วงที่จะใช้ก่อนอัปโหลด"
    → "ได้ โหมดนี้รับฟุตเทจรวมได้ถึง 2 ชั่วโมงต่อโปรเจกต์ทุกแพลน แต่คลิปยาวขนาดนี้ใช้โควตามาก
    แพลนเล็กอาจไม่พอแม้แต่คลิปเดียว ลองตั้งความยาวในหน้าราคาเพื่อดูว่าแพลนไหนพอ
    ถ้าไลฟ์ยาวกว่าสองชั่วโมง ให้แบ่งเป็นหลายโปรเจกต์ตามช่วงเวลา หรือตัดเฉพาะช่วงที่จะใช้ก่อนอัปโหลด".
- /guide/help: "ความยาวฟุตเทจต่อโปรเจกต์เป็นตัวเลขเดียวต่อแพลน ใช้กับทุกโหมดเท่ากัน คือ"
  → "ความยาวฟุตเทจต่อโปรเจกต์ในโหมดตัดฉากเด่นเป็นตัวเลขเดียวต่อแพลน คือ" + ladder + " ส่วน" + the note + "…";
  and "ฟุตเทจเกินเพดาน — ตัดให้สั้นลงก่อนอัปโหลด หรือแยกเป็นสองโปรเจกต์ ระบบตรวจความยาวรวมให้ตั้งแต่ตอนลากไฟล์เข้ามา จึงรู้ผลก่อนเริ่มงาน เพดานเป็นตัวเลขเดียวต่อแพลน ไม่ขึ้นกับโหมดหรือความละเอียดที่เลือก"
  → "…จึงรู้ผลก่อนเริ่มงาน ในโหมดตัดฉากเด่นเพดานเป็นตัวเลขเดียวต่อแพลน
  ส่วนโหมดตัดช่วงเงียบและตัดไฮไลต์จากคลิปยาวรับได้ถึงสองชั่วโมงทุกแพลน".
- /pricing calculator: the length goes to 30 นาที in ตัดฉากเด่น and to 120 นาที
  in the other two ("ความยาวต่อคลิป ตั้งได้ 1–120 นาที"); "เกินเพดานฟุตเทจ…"
  appears only in ตัดฉากเด่น, and where one clip of that length costs more than a
  plan's whole budget the count reads "ไม่พอสำหรับคลิปยาวขนาดนี้".

## 28. /pricing calculator: the review round (2026-10-01)

An independent review scored the calculator 7.0; these are its fixes.

- ตัดไฮไลต์จากคลิปยาว: "ตัดได้อย่างน้อย N คลิปยาว / เดือน" → "ตัดได้ราว N คลิปยาว / เดือน"
  (and "อย่างน้อย N คลิปยาว" → "ราว N คลิปยาว" in the table and the list). A run is
  charged per request as it goes and can exceed the estimate, so a floor read
  as a guarantee. The mode's cost line now says the estimate is generous:
  "…จำนวนไฮไลต์รู้ได้หลังอ่านจบ ระบบจึงคิดเผื่อไว้สูงและบอกเป็นจำนวนขั้นต่ำ" →
  "…จำนวนไฮไลต์รู้ได้หลังอ่านจบ ตัวเลขของโหมดนี้จึงคิดเผื่อไว้ค่อนข้างสูง".
- "โควตาคิดยังไง" contradicted itself ("ใช้กำลังใกล้เคียงกันไม่ว่าฟุตเทจจะยาวแค่ไหน"
  beside "คลิปที่ยาวกว่าใช้โควตามากกว่า"):
  "เรานับเป็นจำนวนคลิปที่ AI ตัดให้ต่อเดือน เพราะงานหนักของแต่ละคลิปคือการถอดเสียงและการวางแผนตัด ซึ่งใช้กำลังใกล้เคียงกันไม่ว่าฟุตเทจจะยาวแค่ไหน ตัวเลขบนการ์ดคิดจากโหมดและความยาวคลิปดิบที่ตั้งไว้ด้านบน ตั้งต้นที่โหมดตัดฉากเด่น คลิปดิบ 5 นาที และปัดลง แต่ละโหมดใช้โควตาไม่เท่ากัน แพลน Pro ขึ้นไปบอกทั้งจำนวนที่ระดับปกติและระดับละเอียด คลิปที่ยาวกว่าใช้โควตามากกว่า และหน้าตั้งค่าแสดงเป็นเปอร์เซ็นต์ของรอบที่เหลือ"
  → "เรานับเป็นจำนวนคลิปที่ AI ตัดให้ต่อเดือน แต่ละคลิปใช้โควตาตามโหมดและความยาวฟุตเทจ
  ตัดช่วงเงียบใช้น้อยที่สุดเพราะถอดเสียงอย่างเดียว ตัดฉากเด่นและตัดไฮไลต์จากคลิปยาวมีขั้นที่ AI
  วางแผนตัดเพิ่มเข้ามา และทุกโหมด คลิปที่ยาวกว่าใช้โควตามากกว่า ตัวเลขบนการ์ดคิดจากโหมดและ
  ความยาวคลิปดิบที่ตั้งไว้ด้านบน ตั้งต้นที่โหมดตัดฉากเด่น คลิปดิบ 5 นาที และปัดลง แพลน Pro
  ขึ้นไปบอกทั้งจำนวนที่ระดับปกติและระดับละเอียด และหน้าตั้งค่าแสดงเป็นเปอร์เซ็นต์ของรอบที่เหลือ" —
  true for all three modes.
- The plans section's heading was for screen readers only ("แพลนทั้งหมด"); it is
  now visible like every other section's, "คำนวณแพลนที่พอดี", with the intro
  "เลือกโหมดที่ใช้และความยาวคลิปดิบของคุณ แล้วบอกว่าอยากได้กี่คลิปต่อเดือน
  ระบบชี้แพลนที่พอดีให้ และการ์ดทุกใบคิดตัวเลขใหม่ตามนั้น".
- One answer per page: the card that fits carries "พอดีกับที่เลือก" (new) and the
  gold action; Pro's "แนะนำ" stays, quieter, while another plan fits.
- With ระดับละเอียด picked, a card's headline is its ระดับละเอียด count, tagged
  "ระดับละเอียด", and the second line reads "ระดับปกติราว N คลิป" (dimmed); a plan
  without the setting says "ไม่มีระดับละเอียด" (new) in place of a count.
- When no plan covers the clips asked for, the readout says "เกินทุกแพลน · Max
  ได้ราว N" (new) instead of pointing at Max.
- The basis is said once, beside the answer ("คิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที",
  plus "ระดับละเอียด" when picked); the cards on /pricing no longer repeat it
  under each count (the home strip still does), and the picker's note keeps
  only what follows it: "ปัดลง · … · ระบบบอกก่อนเริ่มทุกครั้งว่างานนี้ใช้เท่าไหร่".
- The free plan's one-off nature is said once on /pricing, in its card's blurb:
  the card's " · ทดลองใช้ครั้งเดียว ไม่รีเซ็ต" after its count and the picker's
  "ฟรี: ทดลองใช้ครั้งเดียว ไม่รีเซ็ต" are gone there (both stay where the blurb is
  not shown: the home strip, the account card).
- The sentence under the cards is a short list now: the lead
  "ใช้หมดแล้วเลือกแพลนรายเดือนได้ 6 ระดับ ราคาต่อเดือนและจำนวนคลิปต่อเดือน (คิดจาก…)"
  then one row per plan ("Lite · 99 บาท · ราว 4 คลิป"). Its old middle part,
  "ต่อเดือน โดยได้จำนวนคลิปต่อเดือน", and the run-on list of prices and counts are
  replaced by those rows.
- Phones: the modes are chips (icon over name), and what the picked mode is for
  is said once under them — "เหมาะกับ" + the mode's footage line.
- Per-mode starting length: ตัดไฮไลต์จากคลิปยาว opens on 30 minutes (the others on
  5) until the visitor sets a length.

## 29. /pricing calculator: the second review round (2026-10-01)

- ตัดไฮไลต์จากคลิปยาว's cost line put the padding on the count; it is on the
  cost per clip, and the count is the cautious side:
  "…จำนวนไฮไลต์รู้ได้หลังอ่านจบ ตัวเลขของโหมดนี้จึงคิดเผื่อไว้ค่อนข้างสูง" →
  "…จำนวนไฮไลต์รู้ได้หลังอ่านจบ ระบบจึงประเมินโควตาต่อคลิปของโหมดนี้เผื่อไว้
  ใช้จริงอาจได้คลิปมากกว่าตัวเลขนี้".
- "ปัดลง" moved from the start of the picker's note to the basis beside the
  answer: "คิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที · ปัดลง"; the note now starts on
  its caveat ("คลิปที่ยาวกว่าหรือระดับละเอียดใช้โควตามากกว่า · ระบบบอกก่อน…").
  `CLIPS_FOOTNOTE` everywhere else is unchanged.
- The list under the cards: every row is name | price | count, with the
  ระดับละเอียด count on its own dimmed line ("ระดับละเอียดราว N คลิป", no leading
  " · "); Lite and Starter say "ไม่มีระดับละเอียด" on that line (hidden, with the
  others, in the modes without the setting).
- The raw-clip length is drawn, and set, as a clip on a track: a ruler of
  timecodes ("00:00:00" … "00:30:00", or to "02:00:00"), the clip as a gold
  block labelled with its length ("00:05:00"), and a trim handle on its end.
  In ตัดฉากเด่น the plans' footage ceilings are markers named "ฟรี · Lite",
  "Starter", "Pro ขึ้นไป" under the legend "เพดานฟุตเทจ"; in the other modes the
  line under the track reads "ทุกแพลนรับฟุตเทจได้ถึง 2 ชั่วโมง". The handle is a
  slider named "ความยาวคลิปดิบของคุณ" whose value reads "N นาที"; the number field
  beside it is named "พิมพ์ความยาวคลิปดิบเป็นนาที" for screen readers, and its
  range line, "ความยาวต่อคลิป ตั้งได้ 1–30 นาที" (1–120 in the speech modes), is
  now read to screen readers only — the ruler shows the range.

## 30. /pricing clip track: the third review round (2026-10-01)

No wording changed. The track's ruler now marks every five minutes on the
30-minute scale and every quarter hour on the two-hour one ("00:05:00",
"00:15:00", …), showing only the round ones where the track is narrow; the
track has its own full-width row; and a ceiling the clip runs past is marked
with a small ✕ on the clip instead of a line through its name (a line through
Thai cuts the vowels).

## 31. Clip counts on /pricing only (owner, 2026-10-01)

Every count off /pricing was pinned to a 5-minute ตัดฉากเด่น clip, with no way
to change the mode or the length, and the owner found that confusing. Counts
now appear on /pricing (cards, calculator, comparison table, summary list) and
its /pricing.md twin only. Everywhere else says what a count depends on and
points to the calculator (`/pricing#pricing-plans-title`).

- Home, pricing strip: the cards and the extra-plans list drop their counts
  ("ตัดได้ราว N คลิป / เดือน", "ระดับละเอียดราว N คลิป", "คิดจากโหมดตัดฉากเด่น
  คลิปดิบ 5 นาที", the group footnote and the free card's " · ทดลองใช้ครั้งเดียว
  ไม่รีเซ็ต"). Its link "ดูทั้ง 7 แพลน รวม Lite, Agency และ Max" →
  "ดูทั้ง 7 แพลน และคำนวณจำนวนคลิปของคุณ" (now to the calculator).
- /account/billing, plan card: the count block ("ตัดได้ราว N คลิป / เดือน",
  "ระดับละเอียดราว N คลิป", "คิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที") →
  "ตัดได้กี่คลิปต่อเดือนขึ้นกับโหมดและความยาวคลิปดิบของคุณ" + link
  "ลองคำนวณที่หน้าราคา". The free plan keeps "ทดลองใช้ครั้งเดียว ไม่รีเซ็ต" as
  its own line.
- /account/billing, change-plan dialog: each row's facts were count ·
  ระดับละเอียด count · footage · storage; now footage · "ทำงาน AI พร้อมกันได้ N
  งาน" · storage.
- Plan copy no longer carries the unused account-card and dialog lines
  (`accountFeatures`, `dialogSummary`): "· ฟุตเทจตัดฉากเด่น", "ต่อโปรเจกต์ · 3
  GB", "ต่อโปรเจกต์ · 5 GB", "คิวประมวลผลก่อนแพลนอื่น · เก็บโปรเจกต์ไม่จำกัดจำนวน
  · 10 GB", "คิวประมวลผลลำดับแรก · เก็บโปรเจกต์ไม่จำกัด · 30 GB",
  "คิวประมวลผลลำดับแรก · เก็บโปรเจกต์ไม่จำกัด · 60 GB", "· ทำงานพร้อมกัน 4 งาน ·
  60 GB", "คิวประมวลผลลำดับแรก · เก็บโปรเจกต์ไม่จำกัด · 100 GB", "·
  ทำงานพร้อมกัน 5 งาน · 100 GB". Nothing rendered them.
- /guide/help, comparison table: the two count rows are dropped there (kept
  on /pricing); the note under it, the count basis → "ตัดได้กี่คลิปต่อเดือน
  ขึ้นกับโหมดและความยาวคลิปดิบของคุณ" + link "ลองคำนวณที่หน้าราคา".
- /guide/help, "ขีดจำกัดของแต่ละแพลน": "จำนวนคลิปต่อเดือนของแต่ละแพลนคือ
  [ladder] ส่วนแพลนฟรีได้ [count] ครั้งเดียว ตัวเลขเหล่านี้เป็นค่าประมาณ:
  [basis]" → "แพลนที่ใหญ่ขึ้นได้โควตารายเดือนมากขึ้น ส่วนแพลนฟรีเป็นเครดิตทดลอง
  ก้อนเดียว แต่ละงานใช้โควตาไม่เท่ากันตามโหมดและความยาวคลิปดิบ จึงไม่มีจำนวน
  คลิปตายตัวในตารางนี้ เลือกโหมดและความยาวคลิปของคุณในตัวคำนวณของหน้าราคา
  แล้วจะเห็นว่าแต่ละแพลนตัดได้ราวกี่คลิปต่อเดือน".
- /guide/choose-ai-editor, เกณฑ์ที่ 4: "ของเราคิดเป็นจำนวนคลิปที่ AI ตัดให้ต่อเดือน
  ตั้งแต่ [Lite count] ในแพลน Lite จนถึง [Max count] ในแพลนสูงสุด
  แล้วแสดงผลเป็นเปอร์เซ็นต์ของรอบในหน้าตั้งค่า …" → "ของเราคิดเป็นโควตารายเดือน
  ที่แสดงเป็นเปอร์เซ็นต์ของรอบในหน้าตั้งค่า แต่ละงานใช้โควตาไม่เท่ากันตามโหมด
  และความยาวคลิปดิบ ตัดได้ราวกี่คลิปต่อเดือนในแต่ละแพลนลองคำนวณได้ในหน้าราคา
  แพลนฟรีเป็นเครดิตทดลองก้อนเดียว …" (the rest unchanged). Old pieces:
  "ของเราคิดเป็นจำนวนคลิปที่ AI ตัดให้ต่อเดือน ตั้งแต่", "ในแพลน Lite จนถึง",
  "ในแพลนสูงสุด แล้วแสดงผลเป็นเปอร์เซ็นต์ของรอบในหน้าตั้งค่า แพลนฟรีเป็นเครดิต
  ทดลองก้อนเดียว ส่วนแพลนรายเดือนทุกแพลนมีรอบเดียวคือรอบรายเดือน ไม่มีเพดาน
  รายสัปดาห์หรือรายชั่วโมง และแพลนใหญ่ขึ้นได้คลิปต่อบาทมากขึ้น การแก้ไทม์ไลน์
  และการเรนเดอร์ซ้ำไม่นับ", "จำนวนคลิปต่อเดือนของแต่ละแพลนคือ", "ส่วนแพลนฟรีได้",
  "ครั้งเดียว ตัวเลขเหล่านี้เป็นค่าประมาณ:".
- /about FAQ "มีให้ลองใช้ฟรีไหม ต้องผูกบัตรก่อนไหม": drops "ตัดได้ ราว 2 คลิป"
  ("มีและไม่ต้องผูกบัตร สมัครแล้วได้เครดิตทดลองก้อนเดียว ตัดได้" → "มีและไม่ต้องผูก
  บัตร สมัครแล้วได้เครดิตทดลองก้อนเดียว ใช้ได้ครบทุกโหมด …").
- /pricing FAQ "แพลนฟรีใช้ได้นานแค่ไหน": "แพลนฟรีคือเครดิตทดลองก้อนเดียวที่ได้
  ตอนสมัคร ตัดได้ [count] และไม่รีเซ็ตรายเดือน ใช้หมดแล้วเลือกแพลนรายเดือนที่
  พอดีกับปริมาณงานได้ เริ่มที่ Lite หรือ Starter" → "แพลนฟรีคือเครดิตทดลอง
  ก้อนเดียวที่ได้ตอนสมัคร และไม่รีเซ็ตรายเดือน ตัดได้กี่คลิปขึ้นกับโหมดและ
  ความยาวคลิปดิบ ลองดูได้ในตัวคำนวณของหน้าราคา ใช้หมดแล้วเลือกแพลนรายเดือนที่
  พอดีกับปริมาณงานได้ เริ่มที่ Lite หรือ Starter". Old pieces: "แพลนฟรีคือ
  เครดิตทดลองก้อนเดียวที่ได้ตอนสมัคร ตัดได้", "และไม่รีเซ็ตรายเดือน ใช้หมดแล้ว
  เลือกแพลนรายเดือนที่พอดีกับปริมาณงานได้ เริ่มที่ Lite หรือ Starter".
- /pricing FAQ "จำนวนคลิปต่อเดือนนับยังไง": "[basis] แต่ละแพลนได้ต่อเดือน
  [ladder] ส่วนการแก้ไทม์ไลน์ …" → how counting works per mode and length, and
  "เลือกโหมดและความยาวคลิปของคุณในตัวคำนวณของหน้าราคา แล้วจะเห็นว่าแต่ละแพลน
  ตัดได้ราวกี่คลิปต่อเดือน" (the closing sentence unchanged). Old piece:
  "แต่ละแพลนได้ต่อเดือน". The FAQ is also /pricing.md's, so it names the
  calculator "ของหน้าราคา" rather than "ด้านบน".
- /llms.txt: "- จำนวนคลิปที่ AI ตัดให้ต่อเดือน: [ladder]" and "- วิธีนับจำนวนคลิป:
  [basis]" → "- จำนวนคลิปที่ AI ตัดให้ต่อเดือน: ขึ้นกับแพลน โหมด และความยาว
  คลิปดิบ ดูจำนวนโดยประมาณได้ที่ตัวคำนวณของหน้าราคา [link]".
- /pricing.md keeps its counts and their basis, and adds "- แต่ละงานใช้โควตา
  ไม่เท่ากันตามโหมดและความยาวคลิปดิบ ตัวเลขจริงจึงต่างจากตัวเลขตั้งต้นนี้ได้มาก
  หน้าราคามีตัวคำนวณให้เลือกโหมดและความยาวคลิปดิบเอง: [link]".

## 32. Loading states (LOADING_PROMPT.md, 2026-10-01)

No sentence was reworded or removed. What a visitor can now read while
waiting:

- "กำลังโหลด" — every route loading state (the account, /verify-email,
  /checkout/success), in its `role="status"` line, and on the header ruler's
  tag under reduced motion (decoration there; the ruler is hidden from
  assistive technology).
- "กำลังเปิดห้องตัดต่อ" — the render card from a click on "เปิดห้องตัดต่อ"
  until the editor opens, and the polite status line screen readers hear.
- The forms' existing "กำลัง…" labels ("กำลังเข้าสู่ระบบ…", "กำลังส่ง…",
  "กำลังบันทึก…", "กำลังสมัคร…", "กำลังดำเนินการ…", "กำลังไปหน้าชำระเงิน…",
  "กำลังยกเลิก…", "กำลังเปิด…", "กำลังเปลี่ยน…", "กำลังลบบัญชี…") are unchanged;
  they now replace the button's label 150 ms after the press, so a quick
  answer shows none of them. The plan dialog's "เปลี่ยนบัตร" / "เพิ่มบัตรเครดิต"
  button keeps its own words while it waits.
- Decoration, hidden from assistive technology: the loading card's and the
  render card's title strip says "RENDERING" (the word the pending status
  card already used), and both count the wait on a timecode
  (`00:00:01:12`) — real elapsed time, never a percentage. The account
  skeletons show the cards' existing strip names ("ห้องตัดต่อ", "สรุปบัญชี",
  "รอบปัจจุบัน", "งานที่ใช้โควตาในรอบนี้", "แพลนปัจจุบัน", "การชำระเงิน",
  "ข้อมูลส่วนตัว", "ความปลอดภัย") and the status skeletons their task
  ("ยืนยันอีเมล", "การชำระเงิน"); everything else in a skeleton is a bar.
- /account while the account is read: the greeting shows the name the header
  already shows ("สวัสดี คุณ<name>", from the sign-in cookie), then the
  backend's.
- The phone menu's "บัญชีของฉัน" button marks itself as the current page on
  /account, as the sheet's other buttons do on theirs.

## Text added (not replacing anything)

Only labels, no claims:

- /account, the summary: under the plan, its renewal date as the billing tab
  says it — "ต่ออายุ 13 ต.ค. 2026", or "ใช้ได้ถึง 13 ต.ค. 2026" once cancelled.
- /account/billing, the plan card: Pro and up show their ระดับละเอียด count
  under the monthly count ("ระดับละเอียดราว 20 คลิป", `clipsHighLine`), as
  their /pricing cards do.
- /account/quota: under a window at 80% or more, "ต้องการโควตาเพิ่ม" and a link,
  "ดูแพลนและการชำระเงิน".

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
- /about and /signup: the name field has a placeholder like the other
  fields, "ชื่อที่ให้เราเรียก".
- Home, a section on the three modes (owner, 2026-10-01): "สามโหมด สำหรับคลิปสามแบบ",
  "โหมดคือสิ่งที่กำหนดว่า AI ตัดจากอะไร เลือกให้ตรงกับคลิปที่ถ่ายมา แล้วระบบทำส่วนที่เหลือ ทุกโหมดใช้ได้ทุกแพลน รวมแพลนฟรี",
  and for each mode — named as the editor names it — what it is for, what
  the system does in three steps, and what comes out (`lib/modes.ts`, from the
  editor's own mode cards and notes): "ตัดช่วงเงียบ" (คลิปพูดหน้ากล้องที่ถ่ายรวดเดียว ·
  ถอดเสียงพูดเป็นข้อความพร้อมเวลาของแต่ละคำ · ตัดช่วงที่เงียบหรือหยุดคิดออก เก็บลำดับภาพเดิมไว้ทั้งหมด ·
  ใส่ซับไทยจากสิ่งที่พูด · ได้ 1 คลิป · เสียงเดิม), "ตัดฉากเด่น" (คลิปขายของหรือรีวิวสินค้า
  ที่ถ่ายไว้หลายคลิปหลายมุม · AI ดูฟุตเทจทุกไฟล์ แล้วเลือกช็อตที่โชว์สินค้าได้ชัด ·
  เขียนสคริปต์ขายภาษาไทยให้ หรือใช้สคริปต์ที่คุณพิมพ์เอง แล้วเรียงช็อตตามสคริปต์ ยาวตามที่เลือก ·
  ได้คลิปภาพพร้อมสคริปต์ คัดลอกไปพากย์ด้วยเสียงตัวเอง หรือไม่พากย์แล้วใส่เพลงแทน · ได้ 1 คลิป ·
  พากย์ใหม่ ไม่ใช้เสียงในคลิปเดิม), "ตัดไฮไลต์จากคลิปยาว" (คลิปพูดยาวหรือไลฟ์ ที่อยากแยกเป็นคลิปสั้น ·
  ถอดเสียงทั้งคลิปแล้วอ่านว่าพูดเรื่องอะไรบ้าง · เลือกช่วงที่ดูจบได้ในตัวเอง ตัดเป็นคลิปแยกทีละช่วง ·
  ความยาวและจำนวนคลิปขึ้นกับเนื้อหา ไม่ได้ตั้งไว้ล่วงหน้า · ได้หลายคลิป · เสียงเดิม). Track
  labels "M1"–"M3" are decoration.
- A new page, /changelog — "มีอะไรใหม่" (owner, 2026-10-01: a changelog instead
  of a blog). Title "มีอะไรใหม่", lead "ฟีเจอร์ใหม่ การปรับปรุง และการเปลี่ยนแปลงราคาของ
  Noey Studio เรียงจากล่าสุด", "อัปเดตล่าสุด <date>", month headings, kind tags
  "ฟีเจอร์ใหม่" / "ปรับปรุง" / "แก้ไข" / "ราคาและแพลน", and a foot link
  "ติดตามผ่าน RSS/Atom" (`/changelog/feed.xml`). The entries live in
  `lib/changelog.ts` (one per shipped change: web beat sync, honest clip counts
  and one monthly limit, Google sign-in and self-service delete, opening the
  editor signed in, beta pricing, quota in percent and precision tiers,
  resuming a paused run, long-clip highlight lengths) and are written to the
  site's honesty rule — only what has shipped, no vendor names. Linked from the
  footer's R2 column ("มีอะไรใหม่") and llms.txt.
- /about: once the contact form has sent, the form gives way to its
  confirmation and a "ส่งอีกข้อความ" button (the empty form with a gold send
  button invited sending the same message again).
- /pricing: the clips slider label "ใช้ประมาณกี่คลิปต่อเดือน"; its readout is
  built from `plans.ts` only (`clipsHeadline`, `FREE_CLIPS_CAPTION`) with
  `CLIPS_FOOTNOTE` under it.
- /about: the page's own description (its meta description) is shown as the
  lead under the title: "Noey Studio เริ่มจากครีเอเตอร์ที่ลงคลิปรีวิวสินค้าทุกวัน…".
- The footer's account column, signed in, lists the account's tabs by their
  own labels ("บัญชีของฉัน", "โควตาและลิมิต", "แพลนและการชำระเงิน") instead of
  "เข้าสู่ระบบ" and "สมัครใช้งาน"; the header's account menu lists the same
  four tabs ("…", "ข้อมูลส่วนตัว").
- /account/billing: the plan's price under its name, as /pricing prints it
  ("499 บาท / เดือน", the regular price struck through during the beta).
- /account/billing, the payment card: this billing cycle drawn as a clip on a
  lane, from the subscription's own period end (every plan bills monthly, so
  the cycle began a month before it): "รอบบิลนี้", "ต่ออายุในอีก 12 วัน" (or,
  once cancelled, "ใช้ได้อีก 12 วัน"), the playhead's "วันนี้", the cycle's two
  dates ("13 ก.ย.", "13 ต.ค." / "ใช้ได้ถึง 13 ต.ค."). Before a first
  subscription the card says where the card comes from: "บัตรจะผูกกับบัญชีตอน
  ชำระเงินครั้งแรก".
- /account on a phone or a tablet: the computer-only note (§12) above the
  editor card's "เปิดห้องตัดต่อ", which steps back to an outline there.
- The computer-only note (§12) also under the actions after an email is
  verified and after a payment, whose next step is the editor.
- Each guide shows the part of the editor it is about, labelled as a picture:
  "ภาพจำลอง · ไทม์ไลน์หลังระบบตัดร่างแรก", "ภาพจำลอง · เลนคำบรรยายไทยในไทม์ไลน์",
  "ภาพจำลอง · สลับฉากเป็นช็อตสำรอง", "ภาพจำลอง · ยืดหดความยาวฉากในไทม์ไลน์",
  "ภาพจำลอง · ห้องตัดต่อบนเว็บ", "ภาพจำลอง · การ์ดโควตาในหน้าตั้งค่า".
- Decorative readouts, hidden from assistive technology: the plan and "100%"
  after the checkout card's render bar ("PRO · 100%"), "SENT" on the contact form's confirmation, the
  status cards' title strip (a state word as a render queue prints it —
  "DONE", "EXPORT", "FAILED", "READY", "RENDERING", "END") and the 404's
  running time display.
- /account: when the last charge failed (`past_due`), the summary's plan row
  repeats the billing tab's own sentence, "ตัดบัตรไม่สำเร็จ ระบบจะลองตัดอีกครั้ง
  อัปเดตบัตรได้ที่การ์ดการชำระเงิน", so it is seen without opening that tab.
- /pricing, the quota rules: under "Weekly limit", "5-hour limit" and
  "Trial credit", quietly, the editor's own names for them —
  "โควตารายสัปดาห์", "โควตารอบ 5 ชั่วโมง", "เครดิตทดลองใช้" (web/src
  `lib/usageLimits.ts`), the names on the quota card drawn just above.
- The plan comparison table, where it scrolls sideways (narrow screens):
  "เลื่อนดูทุกแพลน →" above it (decorative, hidden from assistive technology).
- Decoration, hidden from assistive technology: the home page's six feature
  clips are tagged by their job ("SUB", "BGM", "TRIM", "SWAP", "IN", "OUT")
  instead of track numbers, the home page's extra plans carry their reel
  numbers ("P1", "P5", "P6"), and a section opens with the header ruler's
  diamond in place of a track label.

- /account/profile: the password block's heading "รหัสผ่าน", like the
  card's other blocks; under the new password, a level meter of eight
  segments (one per character up to the minimum) — decoration.
- Sign-in forms' placeholders: /signup "รหัสผ่านที่จะใช้เข้าสู่ระบบ";
  /reset-password "รหัสผ่านใหม่ของคุณ" and "พิมพ์รหัสผ่านใหม่อีกครั้ง" (as /login
  has "รหัสผ่านของคุณ"). /reset-password also gets "กลับไปหน้าเข้าสู่ระบบ" under
  its form.
- The sign-in pages' picture panel opens on a title strip, "PREVIEW" and a
  timecode (decoration, hidden from assistive technology).

No testimonials, client logos, ratings or measured-looking numbers were
added. The running timecode beside "งานที่กินเวลาที่สุด ไม่ใช่การถ่าย แต่เป็นการตัด"
on the home page is decoration (`aria-hidden`): it counts up from zero while
the section is on screen, like an editor's clock, and states no measured
time.
