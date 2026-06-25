# AI Video Editing — Product Spec & Architecture

> Context doc สำหรับ feature ตัดต่อวิดีโออัตโนมัติใน Noey Tiktok  
> อัปเดตล่าสุด: 2026-06-22 (เพิ่ม 2 โหมดตัดต่อ + STT/Claude notes)

---

## โหมดตัดต่อ 2 แบบ

Feature นี้รองรับ **2 workflow** — user เลือกตอนเริ่มโปรเจกต์

### โหมด 1 — `talking_head` (พูดในคลิป → ถอดเสียง → ตัดตามเสียง)

**เหมาะกับ:** คลิปที่ creator พูดในวิดีโออยู่แล้ว (มือถือถ่ายพร้อมเสียงจริง)

```
User อัปโหลดวิดีโอ (หลายคลิป + optional reference)
        ↓
Whisper / faster-whisper / Whisper API   ← Claude ทำขั้นนี้ไม่ได้
        ↓
Claude (วิเคราะห์ transcript + optional vision)
        ↓
Timeline JSON
        ↓
FFmpeg / Remotion → MP4
```

**AI ทำอะไรได้:**
- ถอดเสียง + timestamp
- ตัดช่วงเงียบ / พูดซ้ำ / ไม่น่าสนใจ
- หา hook / highlight จากเนื้อหาที่พูด
- สร้าง caption จาก transcript
- ใส่ popup / SFX / zoom ตามจังหวะคำพูด

**ต้องมี STT แยกจาก Claude** — ดูหัวข้อ [Speech-to-Text](#speech-to-text-stt)

---

### โหมด 2 — `dub_first` (User พากย์เอง → ตัดภาพให้สวย + สคริปต์แนะนำ)

**เหมาะกับ:** B-roll / ถ่ายท่าโชว์สินค้าโดยไม่พูดในคลิป (หรือเสียงในคลิปเป็น scratch) แล้ว user จะไปพากย์ทีหลัง

**ไม่จำเป็นต้องถอดเสียงจากวิดีโอต้นฉบับ** — วิเคราะห์จาก **ภาพ + scene + user brief** แทน

#### Flow แบบ A — สร้างสคริปต์ก่อน พากย์ทีหลัง (แนะนำ)

```
User อัปโหลด footage (หลายคลิป) + บอกธีม/สินค้า (optional reference)
        ↓
Scene detection + sample frames
        ↓
Claude Vision (เข้าใจว่าแต่ละช่วงทำท่าอะไร)
        ↓
Edit Script JSON  ← สคริปต์ + แผนตัดให้ user อ่านตอนพากย์
        ↓
User อ่านสคริปต์ → บันทึกเสียงพากย์ (upload VO แยก)
        ↓
(optional) Whisper บนไฟล์พากย์เท่านั้น — sync caption กับเสียงพากย์
        ↓
Claude ปรับ Timeline JSON ให้ภาพ fit ความยาว VO
        ↓
FFmpeg / Remotion → MP4
```

#### Flow แบบ B — มีพากย์แล้ว แค่ตัดภาพให้เข้ากับเสียง

```
User อัปโหลด footage + ไฟล์พากย์ (.mp3/.wav)
        ↓
วัดความยาว VO + (optional) Whisper บนพากย์ → caption
        ↓
Claude Vision บน footage + ความยาวรวม VO
        ↓
Timeline JSON (จัด shot ให้พอดีความยาว + จังหวะ)
        ↓
Render
```

**AI ทำอะไรได้ (โหมด 2):**
- ตัดต่อหลายคลิปให้ flow สวย (jump cut, จังหวะเร็ว)
- สร้าง **Edit Script** ให้ user รู้ว่าแต่ละช่วง:
  - ภาพอะไร / ท่าอะไร
  - ควรยาวกี่วินาที
  - ตัดแบบไหน (cut / zoom / transition)
  - **พากย์ควรพูดอะไร** (ข้อความแนะนำ — user อัดเอง)
- ใส่ caption จากสคริปต์หรือจาก Whisper บน **ไฟล์พากย์** (ไม่ใช่เสียงในคลิป)
- popup / SFX / effect ตามแผน

**ทำได้ไหม?** → **ได้** — โหมดนี้พึ่ง **Claude Vision + scene detection** มากกว่า Whisper บนวิดีโอต้นฉบับ

---

### เปรียบเทียบ 2 โหมด

| | โหมด 1 `talking_head` | โหมด 2 `dub_first` |
|--|----------------------|-------------------|
| ถอดเสียงจากวิดีโอ | ✅ จำเป็น | ❌ ไม่จำเป็น (optional บนพากย์) |
| Claude Vision | แนะนำ (เสริม) | ✅ หลัก |
| Whisper ที่ไหน | บน audio ในคลิป | บนไฟล์พากย์ (ถ้าต้องการ caption sync) |
| Output พิเศษ | caption จากคำพูดจริง | **Edit Script** ก่อนพากย์ |
| MVP ควรเริ่ม | ง่ายกว่า | ทำหลังหรือ parallel |

---

## Edit Script JSON (โหมด 2 — สคริปต์ให้ user พากย์)

นอกจาก Timeline JSON สำหรับ render แล้ว โหมด 2 ควรมี **Edit Script** แยก — เป็นเอกสารให้ creator อ่านตอนอัดเสียง

```json
{
  "mode": "dub_first",
  "title": "รีวิวครีม XX",
  "totalDurationSec": 42,
  "segments": [
    {
      "order": 1,
      "durationSec": 3,
      "visualDescription": "ถือสินค้าใกล้กล้อง หมุนให้เห็นฉลาก",
      "cutStyle": "jump_cut",
      "effect": "punchZoom",
      "sourceClip": "clip1",
      "sourceIn": 5.2,
      "sourceOut": 8.2,
      "voiceoverScript": "วันนี้มารีวิวครีมตัวนี้ที่ใช้มา 2 สัปดาห์แล้ว",
      "onScreenNote": "Hook — พูดเร็ว มีพลัง"
    },
    {
      "order": 2,
      "durationSec": 5,
      "visualDescription": "ทา cream บนหลังมือ",
      "cutStyle": "standard",
      "effect": null,
      "sourceClip": "clip2",
      "sourceIn": 12.0,
      "sourceOut": 17.0,
      "voiceoverScript": "เนื้อครีมบางเบา ซึมเร็ว ไม่เหนียว",
      "popup": { "template": "price", "data": { "price": "299" } }
    }
  ]
}
```

Frontend แสดงเป็น **ตาราง / storyboard** — user เห็นช่วงละกี่วิ ท่าอะไร พูดอะไร ก่อนไปอัดพากย์

หลัง user upload VO → แปลง Edit Script → **Timeline JSON** (เวลา absolute บน timeline สุดท้าย)

---

## Speech-to-Text (STT)

### Claude API ทำถอดเสียงไม่ได้

- **Anthropic ไม่มี Whisper / Speech-to-Text**
- Claude ใช้ได้ **หลังมี transcript แล้ว** — วางแผนตัด, caption, Timeline JSON
- Claude **Vision** ดูภาพจาก frame ได้ — สำคัญมากใน **โหมด 2**

### ตัวเลือก STT

| ตัวเลือก | ราคา | ใช้เมื่อ |
|---------|------|---------|
| **OpenAI Whisper API** | ~$0.006/นาที | โหมด 1 ทั้งคลิป; โหมด 2 บนไฟล์พากย์ |
| **gpt-4o-mini-transcribe** | ~$0.003/นาที | ถูกกว่า Whisper classic |
| **faster-whisper** (local/Railway) | ฟรี (จ่าย CPU/RAM) | volume สูง / ลด API cost |
| **Deepgram** | free tier ~200 นาที/เดือน | real-time / เร็ว |

**แนะนำ MVP:** Whisper API + `OPENAI_API_KEY` แยกจาก `ANTHROPIC_API_KEY`

---

## วิสัยทัศน์ (รวมทั้ง 2 โหมด)

User เลือกโหมด → อัปโหลดวิดีโอ (หลายคลิป + optional reference) → AI วิเคราะห์ → Timeline JSON (+ Edit Script ในโหมด 2) → Render → Download

เป้าหมาย: ตัดต่อ TikTok affiliate อัตโนมัติ — ทั้งแบบพูดในคลิป และแบบพากย์ทีหลัง

---

## Flow หลัก — โหมด 1 (`talking_head`)

```
1. Upload
   ├─ clips[] (1..N)
   └─ referenceStyle? (optional — คลิปตัวอย่างสไตล์)

2. Ingest Job
   ├─ validate, normalize (1080×1920, 30fps, loudness)
   └─ extract audio ต่อคลิป

3. Analysis Job (parallel ต่อคลิป)
   ├─ Whisper → transcript (word + segment timestamps)
   ├─ silence / dead-air detection
   └─ (optional) scene cuts, face bbox

4. Reference Analysis (ถ้ามี reference)
   └─ → Style Profile JSON

5. Planning Job (Claude)
   ├─ merge transcripts + context
   ├─ highlights, cuts, repetition removal
   ├─ caption / popup / CTA / SFX / effect slots
   └─ → Master Timeline JSON

6. Preview Render (low-res, เร็ว)
   └─ user approve / tweak (optional)

7. Final Render
   ├─ Remotion (caption, popup, graphics, motion)
   └─ FFmpeg (concat, audio mix, encode H.264+AAC)

8. Output
   └─ download MP4 (+ optional project JSON แก้ทีหลัง)
```

### Flow ย่อ โหมด 1

```
User Upload Video
        ↓
Whisper (ไม่ใช่ Claude)
        ↓
Claude
        ↓
Timeline JSON
        ↓
Remotion (optional ใน MVP — ใช้ FFmpeg ก่อนได้)
        ↓
FFmpeg
        ↓
Output Video
```

---

## Flow หลัก — โหมด 2 (`dub_first`)

```
1. Upload footage[] (+ reference?, + brief สินค้า/ธีม)
2. Ingest + normalize
3. Analysis (ไม่บังคับ Whisper บนวิดีโอ)
   ├─ scene detection / shot boundaries
   ├─ sample frames ทุก N วิ → Claude Vision
   └─ (optional) reference → Style Profile
4. Planning (Claude)
   ├─ Edit Script JSON (ท่า, วินาที, ข้อความพากย์แนะนำ)
   └─ Timeline JSON draft (visual cuts only)
5. User download/ดู Edit Script → บันทึกพากย์ → upload voiceover
6. (optional) Whisper บน voiceover → caption timestamps
7. Claude merge VO duration + footage → final Timeline JSON
8. Preview → Final render → Download
```

---

## Input

| Input | รายละเอียด | โหมด |
|-------|------------|------|
| วิดีโอหลัก | อัปโหลดได้หลายคลิป (1..N) | 1 + 2 |
| Reference Style | optional — คลิปตัวอย่างสไตล์ | 1 + 2 |
| Brief / ธีม | ชื่อสินค้า, ข้อความที่อยากสื่อ | 2 |
| Voiceover file | ไฟล์พากย์ที่ user อัดเอง | 2 (หลังได้ Edit Script หรือพร้อม upload) |
| `mode` | `talking_head` \| `dub_first` | เลือกตอนเริ่ม |

---

## AI Analysis — ความสามารถที่ต้องการ

### โหมด 1
- วิเคราะห์เสียงจากวิดีโอ (Whisper)
- ถอดเสียงเป็นข้อความ (พร้อม timestamp)
- เข้าใจบริบทจาก transcript
- หา Highlight / ช่วงตัดทิ้งจากคำพูด

### โหมด 2
- วิเคราะห์**ภาพ** (Claude Vision + scene cuts)
- อธิบายแต่ละช่วงว่า “ทำท่าอะไร”
- สร้าง **Edit Script** (กี่วิ, ตัดแบบไหน, พากย์แนะนำ)
- จัด shot ให้สวย / fit ความยาวพากย์ (เมื่อมี VO)
- **ไม่บังคับ** ถอดเสียงจาก footage

### ร่วมกันทั้ง 2 โหมด
- เรียนรู้สไตล์จาก reference (→ Style Profile JSON)
- สร้าง Timeline JSON สำหรับ render

### ข้อจำกัดสำคัญ

- **Whisper + Claude อย่างเดียว = ได้แค่เสียง/ข้อความ** ไม่เห็นภาพในคลิป
- ถ้าต้องการ “เข้าใจภาพ” ต้องเพิ่ม:
  - Vision model (sample frame → Claude vision)
  - Scene detection (PySceneDetect / FFmpeg)
  - Face/person tracking (Focus Speaker — Phase 3+)

---

## Video Editing — ความสามารถที่ต้องการ

### Cutting
- ตัดช่วงเงียบ
- ตัดช่วงพูดซ้ำ
- ตัดช่วงไม่น่าสนใจ
- รวมหลายคลิป

### Caption
- สร้างซับอัตโนมัติ
- ซับแบบ TikTok (คำต่อคำ)
- ไฮไลต์คำตามเสียงพูด
- ปรับ Style ได้

### Popup
- ข้อความเด้ง
- ราคา
- Call To Action
- Product Highlight

### Sound Effect
- Pop, Whoosh, Click, Ding
- เลือกจังหวะอัตโนมัติ (จาก Timeline JSON + asset library)

### Visual Effect
- Zoom In / Zoom Out
- Punch Zoom
- Focus Speaker (ยาก — ต้อง face tracking)

### Graphic Element
- Emoji, Arrow, Sticker
- Product Card

---

## สิ่งที่ flow ต้องมีเพิ่ม (ไม่ให้หายตอน implement)

| ขั้น | เหตุผล |
|------|--------|
| **Media ingest + normalize** | หลายคลิป fps/resolution/audio ไม่ตรงกัน |
| **Asset library** | SFX, sticker, font, popup templates |
| **Timeline JSON** | single source of truth ระหว่าง AI กับ renderer |
| **Preview ก่อน render เต็ม** | render ช้า |
| **Human tweak (optional)** | แก้ caption / popup ก่อน export |
| **Job queue + progress** | ใช้ pattern เดิม: arq + `GET /jobs/{id}` |

---

## Timeline JSON — หัวใจของระบบ

AI **ไม่** output FFmpeg command โดยตรง — output JSON ที่ validate ได้ แล้ว worker แปลงเป็น FFmpeg/Remotion

### ตัวอย่าง Master Timeline

```json
{
  "mode": "talking_head",
  "styleProfile": "from-reference-001",
  "sources": [
    { "id": "clip1", "file": "upload_1.mp4" },
    { "id": "clip2", "file": "upload_2.mp4" }
  ],
  "timeline": [
    { "type": "cut", "source": "clip1", "in": 12.4, "out": 28.0 },
    { "type": "cut", "source": "clip2", "in": 3.0, "out": 15.5 }
  ],
  "captions": [
    { "start": 0.0, "end": 1.2, "text": "วันนี้", "highlight": true }
  ],
  "popups": [
    { "start": 5.0, "duration": 2.0, "template": "price", "data": { "price": "299" } }
  ],
  "sfx": [
    { "start": 5.0, "asset": "pop.mp3" }
  ],
  "effects": [
    { "start": 4.8, "end": 5.3, "type": "punchZoom", "scale": 1.15 }
  ],
  "graphics": [
    { "start": 10.0, "type": "arrow", "position": "bottom-right" }
  ],
  "output": {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "maxDurationSec": 60
  }
}
```

### ตัวอย่าง Style Profile (จาก Reference clip)

```json
{
  "avgCutLengthSec": 2.1,
  "captionStyle": "tiktok-bold-yellow",
  "wordsPerCaptionLine": 3,
  "sfxPerMinute": 4,
  "sfxTypes": ["pop", "whoosh"],
  "zoomOnEmphasis": true,
  "popupAtProductMention": true,
  "maxDurationSec": 45
}
```

**วิธีได้ Style Profile:**
1. Whisper reference → transcript + pace
2. Scene/cut detection → cut frequency
3. (Optional) OCR/vision → caption/popup pattern
4. Claude สรุปเป็นพารามิเตอร์ — ไม่ copy pixel-by-pixel

---

## Tier ความยาก (สำหรับวางแผน)

### Tier 1 — MVP (4–6 สัปดาห์)

| ฟีเจอร์ | วิธี |
|---------|------|
| อัปโหลดหลายคลิป | FastAPI + storage |
| ถอดเสียง + timestamp | Whisper / faster-whisper |
| ตัดช่วงเงียบ | FFmpeg + silence detect |
| รวมคลิป | FFmpeg concat |
| Caption พื้นฐาน | SRT/ASS burn-in |
| หา highlight จากเสียง | Claude + transcript |
| Job async | arq worker (มีอยู่แล้วในโปรเจกต์) |

**MVP ไม่จำเป็นต้องมี Remotion** — FFmpeg ตัดต่อ + subtitle พื้นฐานก่อน

### Tier 2 — Phase 2

| ฟีเจอร์ | วิธี |
|---------|------|
| Caption TikTok (คำต่อคำ) | Remotion / ASS karaoke + word-level Whisper |
| ไฮไลต์คำตามเสียง | word timestamps |
| ตัดพูดซ้ำ / ไม่น่าสนใจ | Claude + rules (tune ต่อ) |
| Popup / CTA / ราคา | Remotion template + JSON |
| SFX auto timing | Timeline JSON + asset lib |
| Zoom in/out พื้นฐาน | FFmpeg zoompan / Remotion scale |

### Tier 3 — Phase 3+

| ฟีเจอร์ | ความท้าทาย |
|---------|-----------|
| เรียนรู้สไตล์ reference แบบละเอียด | ต้องแยกสไตล์เป็นพารามิเตอร์วัดได้ |
| Focus Speaker | face/person detection + crop tracking |
| Product Card / Highlight อัตโนมัติ | object detection หรือ user มาร์ก |
| Emoji/Sticker/Arrow อัตโนมัติ | layout engine + safe zone |
| Visual effect ซับซ้อน | render ช้า, QA ยาก |

---

## Tech Stack ที่เข้ากับ Noey Tiktok

| Layer | แนะนำ | สถานะในโปรเจกต์ |
|-------|--------|------------------|
| API + upload | FastAPI | ✅ มี |
| Background jobs | arq + `core.jobs` | ✅ มี |
| LLM planning | Claude via LiteLLM | ✅ มี |
| Transcription | faster-whisper (local) หรือ OpenAI API | ❌ ยังไม่มี |
| Render MVP | FFmpeg (subprocess / ffmpeg-python) | ❌ ยังไม่มี |
| Render Pro | Remotion (Node service แยก) | ❌ ยังไม่มี |
| Storage | local → S3/MinIO ทีหลัง | partial |
| Frontend | upload + progress + preview + download | ❌ ยังไม่มี |

### API pattern ที่แนะนำ

```
POST /videos/edit          → job_id
GET  /jobs/{id}            → status + progress
GET  /videos/{id}/download → signed URL / file
```

---

## Remotion vs FFmpeg

| ใช้ FFmpeg อย่างเดียว | ใช้ Remotion |
|----------------------|--------------|
| ตัด/ต่อ/encode | Caption animated สไตล์ TikTok |
| subtitle burn-in ธรรมดา | Popup templates |
| silence cut | Motion graphics |
| เร็วกว่า, ง่ายกว่า | หนัก (Node + Chromium + RAM) |

**แนะนำ:** MVP = FFmpeg → Phase 2 เพิ่ม Remotion เฉพาะ caption/popup/graphics

---

## ความเสี่ยง / ค่าใช้จ่าย

- **Whisper:** คลิป 10 นาที ≈ 1–2 นาที (local) หรือ ~$0.06 (API)
- **Claude:** ถูกเมื่อเทียบ render — transcript ~10k tokens ไม่แพง
- **Render:** CPU-bound — limit concurrent jobs ต่อ user
- **Remotion license:** ฟรี individual/small team — ตรวจ commercial ถ้า scale

---

## สิ่งที่อย่า promise ใน v1

- เรียนรู้สไตล์ reference เหมือน editor มนุษย์ 100%
- Focus speaker / product card อัตโนมัติโดยไม่มี detection
- Graphic สวยทุกเฟรมโดยไม่มี template system

---

## MVP ที่แนะนำเริ่ม (Phase 1)

### Phase 1a — โหมด 1 ก่อน (ง่ายสุด)
1. Upload MP4/MOV + เลือก `talking_head`
2. Whisper API → transcript + timestamps
3. Claude → Timeline JSON
4. FFmpeg: trim + concat → **`final.mp4`** + แยก clips → ZIP
5. Download: **คลิปเต็ม** + **CapCut bundle**

### Phase 1b — โหมด 2 (ต่อจาก 1a)
1. Upload footage + brief + เลือก `dub_first`
2. Scene detect + Claude Vision → **Edit Script JSON**
3. UI แสดง storyboard / สคริปต์ให้ user
4. User upload voiceover
5. Claude → Timeline JSON + FFmpeg render (ยังไม่ caption TikTok สวย)

Phase ถัดไป: Remotion caption → popup/SFX → reference style → advanced VFX

---

## Output หลัง render — 2 อย่าง (มีครบทั้งคู่)

ทุก job ที่เสร็จต้องมี **ทั้ง flow เดิม + CapCut handoff** — ไม่ใช่อย่างใดอย่างหนึ่ง

### Output A — คลิปเต็มตัดแล้ว (flow เดิม, **บังคับ**)

ไฟล์หลักที่ user download / โพสต์ได้ทันที:

```
final.mp4   ← คลิปรวม 9:16 ตัดต่อครบแล้ว (concat ตาม Timeline JSON)
              อาจมี caption burn-in พื้นฐาน + audio mix แล้ว
```

- ใช้ได้เลยถ้าไม่เข้า CapCut
- ใช้เป็น **reference** ตอน import layer ใน CapCut ก็ได้
- นี่คือ deliverable หลักของ flow เดิม — **ห้ามตัดออก**

### Output B — CapCut bundle (เสริม, **บังคับเหมือนกัน** ตาม product intent)

ZIP แยก asset สำหรับ user เอาไปต่อใน CapCut:

```
project_{id}_capcut.zip
├── final.mp4                 ← สำเนาเดียวกับ Output A (อยู่ใน ZIP ด้วย)
├── clips/ …                  ← segment แยก (clean video)
├── audio/ … overlays/ … captions/ …
├── manifest.json
└── README.txt
```

---

## CapCut Handoff — Export แยก layer

**เป้าหมาย:** นอกจาก **คลิปเต็ม (`final.mp4`)** แล้ว ยังได้ **asset แยกทุกชิ้น** เพื่อ import เป็น layer ใน CapCut ต่อเอง (caption สวย, สี, เพลง)

**ทำได้** — Remotion สำหรับ polish สุดท้ายยังเป็น optional เพราะ CapCut รับช่วงต่อ

### โครงสร้าง ZIP (`project_{id}_capcut.zip`)

```
project_abc_capcut/
├── final.mp4                   ← คลิปเต็มตัดแล้ว (เหมือน Output A)
├── clips/
│   ├── 01_hook.mp4             ← แต่ละ segment ตัดแล้ว (video clean — ไม่ burn overlay)
│   ├── 02_product_show.mp4
│   └── 03_cta.mp4
├── audio/
│   ├── voiceover.mp3
│   └── sfx/
│       ├── pop_001.mp3
│       └── whoosh_002.mp3
├── overlays/                   ← PNG โปร่งใส
│   ├── price_299.png
│   └── arrow_001.png
├── captions/
│   ├── subtitles.srt
│   └── subtitles.ass           ← (optional)
├── manifest.json
└── README.txt
```

### `manifest.json` — บอก CapCut ว่าเอาอะไรวางตรงไหน

```json
{
  "projectTitle": "รีวิวครีม XX",
  "fps": 30,
  "resolution": { "width": 1080, "height": 1920 },
  "preview": "final.mp4",
  "timeline": [
    {
      "order": 1,
      "startSec": 0.0,
      "durationSec": 3.0,
      "video": "clips/01_hook.mp4",
      "label": "Hook — ถือสินค้า",
      "audio": [],
      "overlays": [],
      "captions": [{ "startSec": 0.0, "endSec": 2.8, "text": "วันนี้มารีวิว..." }]
    },
    {
      "order": 2,
      "startSec": 3.0,
      "durationSec": 5.0,
      "video": "clips/02_product_show.mp4",
      "label": "โชว์เนื้อครีม",
      "audio": [{ "file": "audio/sfx/pop_001.mp3", "atSec": 3.0 }],
      "overlays": [{ "file": "overlays/price_299.png", "atSec": 4.0, "durationSec": 2.0 }],
      "captions": []
    }
  ]
}
```

User เปิด CapCut → ดู `final.mp4` เป็น reference → import คลิปจาก `clips/` → วาง SFX / PNG / พากย์ตาม `manifest`

### CapCut import — ความจริง

| สิ่งที่ทำได้ดี | หมายเหตุ |
|---------------|----------|
| **final.mp4** คลิปเต็ม | โพสต์ได้เลย หรือใช้ sync reference |
| MP4 แยกทีละ clip | ลากเข้า timeline เป็น layer |
| SRT subtitle | CapCut รองรับ import subtitle |
| MP3 / WAV (SFX, VO) | ลากเข้า audio track |
| PNG โปร่งใส | ลากเป็น overlay |

| สิ่งที่ CapCut ไม่รองรับดี | ทางเลือก |
|-------------------------|----------|
| Import project file อัตโนมัติ (เหมือน Premiere XML) | ใช้ **manifest.json + README** เป็น guide |
| Auto วาง layer ให้ครบ 100% | user จัดใน CapCut เอง (ตามแผนที่ AI ให้) |

**ไม่พยายาม generate ไฟล์ draft CapCut โดยตรง** — format ปิด proprietary, พังง่ายเมื่อ CapCut update

### Pipeline export (ทั้ง 2 output)

```
Timeline JSON
    ↓
FFmpeg
    ├─ ① render final.mp4          ← คลิปเต็มตัดแล้ว (บังคับ)
    ├─ ② export clips/*.mp4        ← segment แยก (clean video)
    ├─ ③ export audio/*, overlays/*
    ├─ ④ export captions/*.srt
    └─ ⑤ zip ทุกอย่าง + final.mp4 → project_{id}_capcut.zip
```

- **① final.mp4** = flow เดิม — user download แยกได้ หรืออยู่ใน ZIP
- Segment ใน ZIP = **video clean** (ไม่ burn popup/SFX ลง clip แยก — ให้ CapCut วาง layer เอง)
- Caption ใน **final.mp4** อาจ burn-in พื้นฐานได้ (Phase 1) — ใน ZIP ยังมี `.srt` แยกให้ CapCut ใช้ใหม่

**ข้อดี:**
- ได้คลิปใช้ได้ทันที **และ** asset แยกสำหรับ polish
- MVP ไม่ต้อง Remotion สำหรับ polish สุดท้าย

### API download

```
GET /videos/{project_id}/download        → final.mp4 (คลิปเต็ม — flow เดิม)
GET /videos/{project_id}/export/capcut   → ZIP (final.mp4 + clips + assets + manifest)
```

---

## ขั้นตอน implement ถัดไป (เมื่อพร้อมลงมือ)

1. ออกแบบ **Timeline JSON schema v1** + **Edit Script schema** + **CapCut manifest schema**
2. DB: `video_projects` (mode, status), `video_assets`, `video_jobs`
3. Router + arq: ingest → analyze → plan → **render final.mp4 + export CapCut ZIP**
4. Frontend: download **คลิปเต็ม** + ปุ่ม download **ZIP แยก layer**

---

## สรุปความเป็นไปได้

| คำถาม | คำตอบ |
|--------|--------|
| ทำได้ไหม? | **ได้** — ทั้ง 2 โหมด |
| โหมด 1 (ถอดเสียง) | **ได้** — Whisper + Claude |
| โหมด 2 (พากย์เอง + สคริปต์) | **ได้** — Claude Vision + Edit Script |
| Export แยก layer สำหรับ CapCut | **ได้** — ZIP คู่กับ **final.mp4** (มีทั้งคู่ทุก job) |
| Claude ถอดเสียงได้ไหม? | **ไม่ได้** — ต้อง Whisper แยก |
| Flow ครอบคลุมไหม? | **~80%** — เพิ่ม Edit Script + mode branch |
| ทำครั้งเดียวหมด? | **ไม่แนะนำ** — Phase 1a → 1b → 2 → 3 |
