# AI Effects Layer — User Guide

A quick guide to the AI-assisted effects feature in the desktop video app. This
covers what it does, what effects exist, and how to use them. For the engineering
spec see `REMOTION_EFFECTS_REQUIREMENTS.md`.

## What it is

After your video is cut/dubbed and finished, you can layer animated
motion-graphics on top — stickers, badges, highlights, punch-zooms, and light
effects. An AI watches the finished clip and places effects automatically at the
right moments; you can then hand-tune everything.

**It never changes your edit.** The cut, timing, and scene order stay exactly as
they were. Effects are a separate layer painted on top — the video length and
every cut are untouched.

**Effects match what's actually being said.** The AI reads your voiceover
script/transcript (with timing) alongside the video — so a "ลด 70%" badge lands
exactly when that line is spoken, not just somewhere that looks visually similar.

**What the AI can and can't decide:**
- ✅ WHERE and WHEN to place effects (matched to the script + visuals)
- ✅ The TEXT it writes (labels, titles — real Thai text fit to the moment)
- ✅ Style parameters of an existing effect — color, position, size, which shape/
  animation variant to use
- ✅ It CAN design a brand-new visual effect from scratch — see **"สร้างเอฟเฟกต์ใหม่
  ด้วย AI"** in the editor. Describe what you want (and/or attach a reference
  image) and it writes a new animated component just for that request. Every
  AI-written component is checked by a strict safety filter before it's ever
  allowed to run — it can only use drawing/animation code, nothing that touches
  files, the network, or your system.

## Where to find it

Open a finished project (status **เสร็จแล้ว**). Below the video you'll see the
**เอฟเฟกต์ (AI)** panel.

## Generating effects with AI

1. (Optional) Type an instruction in the box — e.g. *"ใส่ป้ายโปร ซูมตอนโชว์สินค้า
   playful"* or *"keep it minimal"*. Leave it blank to let the AI decide.
2. Press **สร้างเอฟเฟกต์ด้วย AI**.
3. The app downscales the video, the AI watches it and places effects, then the
   effects are rendered and composited. The preview updates to the final result.

Press **สร้างใหม่ด้วย AI** any time to regenerate (a new instruction gives a
different result).

## The effect types

| Effect | Thai | What it does | Best for |
|--------|------|--------------|----------|
| `text-reveal` | ข้อความเด้ง | A big word/phrase that pops in | hooks, one-liners, prices |
| `sticker-badge` | สติกเกอร์ป้าย | A rounded pill with emoji + text | promos, sale tags, callouts |
| `shape-highlight` | รูปทรงไฮไลต์ | An animated ring/star/heart/spark/arrow on a spot | pointing at a product/detail |
| `light-leak` | แสงเลนส์ | A full-frame cinematic light wash | openings, mood, transitions |
| `lottie-sticker` | สติกเกอร์ Lottie | Plays a Lottie animation (from a library or your own file) | animated stickers/effects |
| `image-sticker` | สติกเกอร์รูปภาพ | Shows a static image (PNG/GIF/WEBP) you upload | logos, custom stamps, brand marks |
| `punch-zoom` | ซูมกระแทก | Zooms the footage into a focal point | emphasizing a product/face |

`punch-zoom` works on the footage itself (a real camera-style push-in). The rest
are overlays that float on top without touching the footage.

## Templates (สำเร็จรูป)

Below the buttons you'll see **เทมเพลตสำเร็จรูป** — one-tap presets (e.g.
*โปรโมชัน*, *ซินีมา*). Tap one to apply that whole look to the current video and
render immediately. The app ships with 2 defaults (which can't be deleted), and
you can save your own (see below) — user-saved templates have a small **×** to
delete them. All templates are stored on your machine and appear for every
project, not just the one you made them in.

## Editing effects by hand

Press **แก้ไข** to open the effects editor. For each effect you can:

- **Move** it — change **เริ่ม (วิ)** (start time).
- **Stretch/shrink** it — change **ยาว (วิ)** (how long it stays on screen).
- **Swap** it — pick a different effect from the dropdown at the top of the card.
- **Delete** it — the trash icon.
- **Adjust its look** — color, position (X/Y are 0–1 across the frame), size,
  text, shape, animation, etc. (the controls change per effect).
- **Add** a new effect — **เพิ่มเอฟเฟกต์**, then pick a type.

Press **บันทึก + เรนเดอร์** to save your changes and re-render the final video.

### Stickers (Lottie or image)

For a `lottie-sticker` or `image-sticker` effect, press **เลือกสติกเกอร์…** to
open the sticker picker. It shows every sticker of the matching type you've
imported before (tap to reuse instantly) plus **+ นำเข้าไฟล์ใหม่…** to import a
new file — a Lottie animation (`.json`, e.g. free from LottieFiles) for
`lottie-sticker`, or an image (PNG/GIF/WEBP) for `image-sticker`. Every import is
saved to your local library automatically — import once, reuse in any project.

### Creating a brand-new custom effect with AI

Press **เพิ่มเอฟเฟกต์** → **สร้างเอฟเฟกต์ใหม่ด้วย AI**. Type a description
(e.g. *"ทำ badge วงกลมเด้งๆ ตัวเลขนับถอยหลัง สีสดใสสไตล์ TikTok"*) and/or attach a
reference image for style inspiration, then press **สร้างเอฟเฟกต์**. The AI
writes a completely new animated component — not a variation of an existing
one — matching your description. It's added to the timeline like any other
effect: move it, resize it, delete it, save it into a template.

Every generated component passes through a strict safety check before it can
ever render — only drawing/animation code is allowed (no file access, no
network, nothing that could touch your system). If a generation fails the
check, you'll see an error and can try a different description.

### Saving a template

At the bottom of the editor, type a name and press **บันทึกเป็นเทมเพลต** to save
the current set of effects as a reusable preset. It then appears in the templates
row for any project.

## Positioning

`X` and `Y` are fractions of the frame from 0 to 1:

- `X = 0` left edge, `0.5` center, `1` right edge.
- `Y = 0` top, `0.5` middle, `1` bottom.

So `X 0.5, Y 0.15` puts an effect centered near the top.

## Notes

- Effects render on your machine — the full-resolution video never leaves your
  computer. Only a small downscaled proxy is sent for the AI to watch.
- The finished file with effects is `final_fx.mp4` in the project folder; the
  original cut (`final.mp4`) is kept untouched.
- A CapCut bundle (`effects_capcut.zip`) is also written next to it — it contains
  `final_fx.mp4`, each overlay as a transparent clip, and a `manifest.json` with
  timings, so you can re-assemble/tweak the effects in CapCut if you prefer.
