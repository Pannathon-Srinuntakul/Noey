# Editor limits & plans — design spec (web editor + desktop)

**Status: built on web 2026-09-22** (all sections); desktop has §1, §5, §6 — gaps in PARITY.md.

Source: claude.ai/design project 2ca4ea9d-5326-4f54-8c1a-43eef9da72bb, file
`Noey Studio - Editor Limits.dc.html` (owner, 2026-09-22). Re-fetch it with DesignSync
`get_file` for exact markup. This page is the authority for the editor's limit/plan UI; it
supersedes the earlier "English limit labels" note — **labels are Thai as below**.
Dark editor palette: bg `#171614`, surface `#211f1d`, text `#f3f2f2`, muted `#a3a09c`,
accent `#d9a441` (hover `#f0c274`), error `#e08b84`, hairline `rgba(243,242,242,0.12)`,
radius 4px. Use the editor's existing tokens/components; match these values.

## 1. Settings page — usage card ("การใช้งาน")
- Header row: `แผน {plan}` · spacer · link `เปลี่ยนแผน` (jumps to the plans list).
- One row per window, then storage. Each row: name (left), `ใช้ไป N%` (right, tabular),
  4px bar, reset line under it (muted 13px).
  - Free: `โควตารายเดือน` — `รีเซ็ต 1 ต.ค.`
  - Lite / Starter: `โควตารายสัปดาห์` — `รอบใหม่ พฤหัสบดี 09:40`
  - Pro and up: `โควตารายสัปดาห์` + `โควตารอบ 5 ชั่วโมง` — `รอบใหม่ใน 1 ชม. 48 นาที`
  - `ที่เก็บไฟล์`: value `6.2 / 10 GB`, reset line `ลบโปรเจกต์เก่าเพื่อคืนพื้นที่ได้`.
- Bar/value colour: ≥95% error, ≥80% accent, else text.
- Footer line: `แก้ไทม์ไลน์ สลับช็อต และเรนเดอร์ซ้ำ ไม่กินโควตา`.
- Times in the viewer's local timezone.

## 2. Near-limit banner (top of the app)
- Shown when any quota window ≥80%: accent-tinted bar,
  text `{window name} ใช้ไป N% · {reset line}`, link `ดูแผน`, dismiss ✕.

## 3. Quota exhausted — modal when pressing start
- Title `โควตารอบนี้หมดแล้ว`; body
  `กลับมาเริ่มงานใหม่ได้ {อีก 1 ชม. 48 นาที | 1 ต.ค.} · ระหว่างนี้ยังแก้ไทม์ไลน์และเรนเดอร์คลิปที่ตัดไว้แล้วได้`.
- Buttons: `เข้าใจแล้ว` (secondary), `เพิ่มโควตา` (primary → plans; when the top-up wallet
  exists, also offer continue-with-balance here).

## 4. One-line notices (inline, same row style: when · text · optional action)
- Footage over limit: `ฟุตเทจรวม 24 นาที เกินเพดาน 20 นาทีของแผนนี้ ตัดให้สั้นลงหรือแยกเป็นสองโปรเจกต์` — `ดูไฟล์`
- Storage full: `เหลือพื้นที่ 0.4 GB ไม่พอสำหรับไฟล์ชุดนี้ 1.4 GB` — `ลบงานเก่า`
- Queue: `ทำพร้อมกันได้ 2 งาน งานที่สามจะเริ่มเองเมื่อมีช่องว่าง`
- Payment failed: `ตัดบัตรไม่สำเร็จ จะลองอีกครั้งใน 2 วัน ถ้าไม่สำเร็จจะกลับเป็นแผนฟรีวันที่ 26 ก.ย.` — `แก้ข้อมูลบัตร`

## 5. Settings page — plans list ("แผน")
Rows (name / sub / price), current row accent-tinted with `ใช้อยู่`; others a text button
`เปลี่ยนเป็นแผนนี้` (higher, accent) or `ลดมาแผนนี้` (lower, muted):
- ฟรี — `ทดลองใช้ · ฟุตเทจ 5 นาที/โปรเจกต์` — ฿0
- Lite — `1x · ฟุตเทจ 10 นาที · 3 GB` — ฿199
- Starter — `2x · ฟุตเทจ 20 นาที · 5 GB` — ฿399
- Pro — `5x · ฟุตเทจ 2 ชม. · 10 GB` — ฿990
- Studio — `10x · พร้อมกัน 3 งาน · 30 GB` — ฿1,990
- Agency — `20x · พร้อมกัน 4 งาน · 60 GB` — ฿3,990
- Max — `35x · พร้อมกัน 5 งาน · 100 GB` — ฿6,990
Footer: `เปลี่ยนขึ้นมีผลทันที เปลี่ยนลงมีผลรอบบิลถัดไป`. Prices come from `/billing/plans`.

## 6. Confirm plan change — modal
- Title `เปลี่ยนเป็นแผน {Pro}`; body
  `โควตาใหม่มีผลทันทีหลังชำระเงิน ครั้งนี้ตัดบัตร ฿{prorated} ตามวันที่เหลือของรอบบิล เดือนถัดไป ฿{price}`
  (downgrade: effective next billing cycle, no charge now).
- Checkbox `ฉันเข้าใจว่าระบบจะตัดบัตรทุกเดือนจนกว่าจะยกเลิก และรอบที่ใช้ไปแล้วไม่คืนเงิน`;
  hint `ติ๊กยอมรับเงื่อนไขก่อน`; buttons `ยกเลิก`, `ไปหน้าชำระเงิน` (disabled until ticked;
  server re-checks consent). Proration amount comes from the backend (Stripe preview when
  live, computed in mock mode).
