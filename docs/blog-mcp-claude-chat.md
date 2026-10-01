# Noey Studio blog — handoff for Claude (claude.ai chat / scheduled task)

Give this file to Claude in claude.ai. It explains how to connect to the blog's MCP
server, what each tool does, the rules a post must pass, and the prompt for the
scheduled task. Full technical reference: `docs/blog-mcp.md` (repo).

## 1. Connect (the owner does this once)

1. claude.ai → **Customize → Connectors → Add custom connector**.
2. Name: `Noey Studio blog`. MCP server URL: **`https://api.noeystudio.com/mcp`**
   (exactly; no trailing slash).
3. Advanced settings: leave OAuth Client ID / Secret **empty** (Claude registers itself).
4. **Add** → **Connect**. A tab opens on `admin.noeystudio.com/connect`. Sign in to the
   admin (password + 6-digit code by email; if already signed in, click
   "เข้าสู่ระบบอยู่แล้ว? ดำเนินการต่อ"). Check it says "ส่งกลับไปที่ claude.ai" →
   **อนุญาต**.
5. Test in a chat with the connector on: "เรียก get_site_info แล้วสรุปกฎการเขียน".

The owner controls everything from admin.noeystudio.com → **บทความ**: auto-publish
on/off (default on, max 2 posts a day), take any post down, revoke the connector,
edit the **Writing brief** and **Content plan**, upload real screenshots / demo clips /
logos / PDFs in **คลังสื่อ**. Every action is in the audit log.

## 2. Why the tools look like this

- The scheduled task's sandbox cannot reach api.noeystudio.com directly, and base64
  images are too big to pass as arguments. So everything is sent as **text** through MCP.
- Pictures inside a post are **HTML/CSS (optionally JS) "visuals"** that the website
  shows like images (fixed ratio, scales with the page, not clickable, sharp at any size,
  can animate). The server only validates and stores them — it renders nothing.
- The **cover** must be a real image file (for social sharing and Google), so the server
  draws it from a small HTML/CSS subset (`render_cover`).

## 3. Tools

| Tool | What it does |
|---|---|
| `get_site_info` | Product facts, honest scope, plans, CTA links, existing guides, **writing rules**, `brand` (colours, fonts, logo URL, recommended sizes, minimal visual + cover examples), `brief` (+ `updated_at`) and `content_plan` (topics not yet written, in order). Call first, every time. |
| `list_posts(status?, limit, cursor?)` / `get_post(slug)` | All posts, to avoid repeats. Follow `next_cursor` to the end. |
| `list_categories` / `list_tags` | Categories are fixed; use an existing one. |
| `list_media({kind?, tag?})` | The owner's real screenshots (`screenshot`), demo clips (`demo`), logos (`logo`), PDFs (`file`) with url, poster, alt, description, tags, size. Prefer these over drawing the product. |
| `get_icons(names)` | Lucide icons as inline `<svg>` to paste into visual / cover HTML. |
| `create_visual({html, css, js?, width, height, alt, caption?, animated})` | Stores a visual; returns `{id, markdown: "::visual[alt](id)"}`. Put that markdown on its own line in the post. |
| `render_cover({html, css, alt})` | Draws a 1600×900 WebP cover; returns `{url, width, height}`. Use as `cover_image_url` with `cover_alt`. |
| `create_post({...})` | Creates a **draft**. Refusals list every rule that failed — fix them and call again. |
| `update_post(slug, changes)` | Only posts this connector wrote (`source = ai`). |
| `publish_post(slug)` | Publishes; refuses when the owner turned auto-publish off or today's cap is used — then stop and report. |
| `unpublish_post(slug)` | Takes a post offline (never deletes). Only when the owner asks. |
| `mark_topic_done({topic_id, slug})` | Marks a content-plan topic as written by that post. |
| `upload_image` | Small images only (base64 ≤ 300 KB). Prefer the tools above. |

### Visual rules (`create_visual`)
- Canvas `width × height` is the designed size and fixes the ratio (e.g. 1600×1000
  infographic, 1200×1200 square, 1080×1350 portrait). 200–2400 px a side.
- ≤ 200 KB in total. Self-contained: no external URLs. Images only from the media
  store (`list_media`) or `data:image/*`; fonts are provided (use the `font-family`
  names in `brand`).
- Not allowed: `<iframe> <form> <a> <input>/<button> <object> <embed> <base> <meta>
  <link> <audio>/<video>`, `on*=` attributes, `@import`, `@font-face`, `<script>` inside
  `html` (put JS in `js`). Refusals name each spot with its line.
- JS may animate (`requestAnimationFrame`, Web Animations) but has no network,
  cookies, storage or access to the page around it.
- `animated: true` for anything that moves; **at most 3 animated visuals per post**.
  Motion pauses off screen and for readers who prefer reduced motion — design the
  first frame to make sense on its own.

### Cover rules (`render_cover`)
- 1600×900. Supported: flexbox, relative/absolute position, sizes, padding/margin,
  linear/radial gradients, border, border-radius, box-shadow, text-shadow, opacity,
  transform, the brand's Thai fonts at 400–700, inline `<svg>` from `get_icons`,
  `<img>` from the media store.
- Not supported (refused with the spot named): CSS grid, inline/table layouts,
  animation/@keyframes/transition, float, fixed/sticky, `@media`, `<style>` in html,
  emoji, JS.

### Post rules (`create_post` / `update_post`)
- A cover is required (from `render_cover` or the media library) with `cover_alt`.
- At least **2 pictures in the body**: `::visual[alt](id)` (made by this connector)
  and/or `![alt](url)` images / `![alt](url.mp4)` clips from the media library. Every
  picture needs a Thai alt that says what it shows. At most 3 animated visuals.
- No raw HTML, script or iframe in the Markdown. PDF links only from the media library.
- Plus the original rules: Thai title/excerpt/meta within their lengths, headings from
  `##`, at least 2 internal links, a CTA to `/signup`, 3–6 plain-text FAQ, an existing
  category, ≤ 8 tags, a minimum length, **no invented numbers/statistics/reviews, no
  claims outside the scope, never name an AI vendor**.

## 4. Prompt for the scheduled task (every 2 days)

claude.ai → create a scheduled task, every 2 days, with the **Noey Studio blog**
connector enabled, and this prompt:

```text
คุณคือผู้เขียนบล็อกของ Noey Studio (noeystudio.com) ใช้ตัวเชื่อมต่อ "Noey Studio blog" เท่านั้น ทำตามลำดับนี้ทุกครั้ง:

1. เรียก get_site_info แล้วอ่าน writing_rules, scope, guides, brand, brief และ content_plan ให้ครบ ทำตามกฎและ brief ทุกข้อ
2. เลือกหัวข้อ: ถ้า content_plan มีหัวข้อที่ยังไม่ได้เขียน ให้เขียนหัวข้อแรก (เก็บ id ไว้)
   ถ้าไม่มี ให้เรียก list_posts (ทุกสถานะ ไล่ next_cursor จนหมด) แล้วเลือกหัวข้อใหม่ที่ครีเอเตอร์ TikTok Affiliate ไทย
   ค้นหาจริง ไม่ซ้ำกับบทความที่มีและคู่มือใน guides (ถ้าใกล้กับคู่มือ ให้ลิงก์ไปหาคู่มือแทน)
3. ภาพ (บังคับ):
   - เรียก list_media ดูภาพหน้าจอ/คลิปสาธิตจริงที่ใช้ได้ก่อน
   - ปก: render_cover 1600×900 ใช้สีและฟอนต์จาก brand (flexbox เท่านั้น ไม่มี grid/animation/emoji) แล้วใช้ url เป็น cover_image_url พร้อม cover_alt
   - ในเนื้อหาอย่างน้อย 2 ชิ้น: create_visual (infographic/แผนภาพ/ภาพเคลื่อนไหวในแบรนด์ ขนาดเช่น 1600×1000)
     วาง markdown ที่ได้ (::visual[alt](id)) ไว้บรรทัดของมันเอง และ/หรือรูป/คลิปจาก list_media เป็น ![alt](url)
   - ไอคอนใช้ get_icons แล้ววาง <svg> ลงใน html, ภาพเคลื่อนไหวไม่เกิน 3 ชิ้น, ทุกภาพต้องมี alt ภาษาไทยที่บอกว่าภาพแสดงอะไร
   - ห้ามแต่งตัวเลขในกราฟ ห้ามลอกหน้าจอผลิตภัณฑ์ขึ้นมาเอง (ใช้ภาพหน้าจอจริงจาก list_media)
4. เรียก create_post หนึ่งครั้ง:
   - slug ภาษาอังกฤษตัวเล็ก-ขีดกลาง, title/excerpt/meta ภาษาไทย ตามความยาวที่กำหนด
   - ย่อหน้าแรกตอบคำถามของหัวข้อตรง ๆ, ใช้หัวข้อ ## / ###, ย่อหน้าสั้น
   - ลิงก์ภายในอย่างน้อย 2 ลิงก์ (เช่น /pricing, /scope หรือหน้าใน guides) และปิดท้ายด้วย CTA ไป /signup
   - faq 3–6 ข้อ เป็นข้อความล้วน, เลือก category ที่มีอยู่, tags ไม่เกิน 8
   - ห้ามแต่งตัวเลข/สถิติ/รีวิวลูกค้า ห้ามอ้างความสามารถที่ scope บอกว่าทำไม่ได้ ห้ามเอ่ยชื่อผู้ให้บริการ AI
   ถ้าถูกปฏิเสธ (create_post, create_visual หรือ render_cover) ให้แก้ตามรายการที่ได้รับแล้วเรียกใหม่ (สูงสุด 3 ครั้งต่อเครื่องมือ)
5. ถ้าเขียนจากหัวข้อใน content_plan ให้เรียก mark_topic_done(topic_id, slug)
6. เรียก publish_post กับ slug นั้น
   - ถ้าตอบว่ารอเจ้าของอนุมัติ หรือเกินเพดานรายวัน ให้หยุดและรายงาน ห้ามพยายามเลี่ยง
7. สรุปสั้น ๆ: หัวข้อ, slug, สถานะ, ลิงก์, ภาพที่ใช้ และเหตุผลที่เลือกหัวข้อนี้
ห้ามแก้บทความที่ source เป็น human และห้ามถอนบทความใด ๆ เว้นแต่เจ้าของสั่ง
```

## 5. Before the first run (owner checklist)

- Upload a few real screenshots and a short demo clip in **คลังสื่อ** (the prompt
  prefers real product images over drawn ones).
- Fill the **Writing brief** and add topics to the **Content plan** if you want to
  steer what gets written.
- If you want to read every post before it goes live, switch auto-publish off.
