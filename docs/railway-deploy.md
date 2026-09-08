# Deploy Noey Tiktok บน Railway

> อัปเดต: 2026-09-08 — เขียนใหม่ทั้งไฟล์
>
> ฉบับก่อนหน้า (2026-06-22) อธิบายระบบที่ไม่มีจริงแล้ว: service `scheduler`
> (ไม่มี `backend/services/scheduler` — งานตามเวลาเป็นของ arq), และ `web` ที่
> build จาก `frontend/` (คือ dashboard ตัวเก่า ไม่ใช่แอปตัดต่อ) ทำตามแล้วจะได้
> service ที่ start ไม่ขึ้น และเว็บผิดตัว

---

## ภาพรวม

```
Railway Project
├── PostgreSQL   (plugin)
├── Redis        (plugin)
├── api          backend/Dockerfile — uvicorn
├── worker       backend/Dockerfile — python -m services.worker
└── web          web/Dockerfile     — static build + nginx
```

**Private network:** service คุยกันผ่าน `{ชื่อ-service}.railway.internal`
**Public URL:** ต้องเปิดทั้ง `web` และ `api` — เบราว์เซอร์เรียก API ตรง ไม่ผ่าน proxy

**HTTPS บังคับ ทั้งสองฝั่ง** เว็บ build ใช้ service worker + OPFS + WebCodecs ซึ่ง
เบราว์เซอร์ให้เฉพาะ secure context เท่านั้น เปิดผ่าน `http://` (นอกจาก localhost)
แอปจะไม่ยอมเริ่มเลย และหน้า HTTPS ก็เรียก API ที่เป็น `http://` ไม่ได้ (mixed content)

---

## ขั้นที่ 1 — Services

| Service | Root / Dockerfile | Start Command |
|---------|-------------------|---------------|
| **api** | `backend/Dockerfile` | `uvicorn services.api.main:app --host 0.0.0.0 --port $PORT` |
| **worker** | `backend/Dockerfile` | `python -m services.worker` |
| **web** | `web/Dockerfile` | (nginx default) |

> Railway กำหนด `$PORT` ให้ — อย่า hardcode 8000 บน api

**ไม่ต้องตั้ง release command** — `alembic upgrade head` และการ seed tenant/admin
รันเองตอน API start (`lifespan` ใน `services/api/main.py`)
เพราะรันตอน start ให้ **pin api ไว้ที่ 1 replica** ไม่งั้น replica หลายตัวจะแย่งกัน migrate

### web: build argument

`VITE_BACKEND_URL` เป็น **build-time** ไม่ใช่ runtime — ค่านี้ถูกฝังทั้งใน bundle
และใน Content-Security-Policy ของหน้าเว็บ (`web/vite.config.ts`) เปลี่ยนแล้วต้อง
**rebuild** ไม่ใช่ restart

```
VITE_BACKEND_URL=https://noey-api-production.up.railway.app
```

---

## ขั้นที่ 2 — Environment Variables

ตั้งเป็น **Shared Variables** เพื่อให้ทั้ง api และ worker ได้เหมือนกัน
ค่าที่ตั้งแค่ service เดียวคือสาเหตุความพังที่พบบ่อยที่สุด

### จาก plugin

```env
POSTGRES_HOST=${{Postgres.PGHOST}}
POSTGRES_PORT=${{Postgres.PGPORT}}
POSTGRES_USER=${{Postgres.PGUSER}}
POSTGRES_PASSWORD=${{Postgres.PGPASSWORD}}
POSTGRES_DB=${{Postgres.PGDATABASE}}
REDIS_URL=${{Redis.REDIS_URL}}
```

### บังคับ (api + worker)

```env
JWT_SECRET=<random 64 hex>      # python -c "import secrets; print(secrets.token_hex(32))"
SEED_EMAIL=<อีเมลแอดมิน>
ADMIN_PASSWORD=<รหัสผ่านจริง>
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
LLM_MODEL=gemini/gemini-3.7-flash
LLM_VISION_MODEL=gemini/gemini-3.1-pro-preview
FRONTEND_URL=https://<web service>.up.railway.app
ALLOW_REGISTRATION=false
```

`JWT_SECRET`, `POSTGRES_PASSWORD` และ `ADMIN_PASSWORD` **ต้องไม่ใช่ค่า default**
ทั้ง api และ worker จะ **refuse to start** ถ้ายังเป็นค่า placeholder ขณะที่
`POSTGRES_HOST` ไม่ใช่ localhost (`assert_production_secrets()` ใน
`packages/core/settings.py`) — ค่า default อยู่ใน source ใครอ่าน repo ได้ก็ปลอม
token เป็นใครก็ได้รวมทั้ง admin

`ELEVENLABS_API_KEY` **ต้องถึง worker** ด้วย — worker คือตัวที่ถอดเสียง

### ที่เก็บไฟล์ — เลือกอย่างน้อยหนึ่ง (บังคับ)

api กับ worker เป็นคนละ host และ **ไม่ได้แชร์ดิสก์กัน** ค่า default (`backend/data`)
อยู่ในตัว image ด้วย — redeploy ทีเดียวไฟล์หายหมด

**แบบ A — Railway Volume (ง่ายกว่า)**
mount volume ที่ path เดียวกันทั้งสอง service แล้วตั้ง

```env
DATA_DIR=/data
```

**แบบ B — S3 / Cloudflare R2 (จำเป็นเมื่อ worker หลาย replica)**

```env
S3_BUCKET=noey-videos
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com   # R2 เท่านั้น; AWS ไม่ต้องตั้ง
S3_REGION=auto
```

ถ้าไม่ตั้งทั้งสองแบบ: manifest ของโปรเจกต์จะว่างเมื่อเปิดจากเบราว์เซอร์อื่น,
โควตาที่เก็บอ่านได้ 0 เสมอ, และการแปลงไฟล์ HEVC จะรายงานว่าสำเร็จแต่ดาวน์โหลด 404
ตลอดไป — ทุกอันดูเหมือนไฟล์หาย ไม่ใช่ config ผิด

### CORS

```env
FRONTEND_URL=https://<web service>.up.railway.app
CORS_EXTRA_ORIGINS=https://<origin อื่น ถ้ามี>,https://...
```

origin ที่ไม่อยู่ในสองตัวนี้จะถูก block ทุก request
settings ถูก cache ไว้ → **แก้ CORS ต้อง restart api**

### Optional

```env
ENCRYPTION_KEY=...        # Fernet — ถ้าไม่ตั้ง key ที่เก็บใน DB เป็น plaintext
API_DOCS_ENABLED=false    # default ปิด — schema เปิดเผยชื่อ provider ใน docstring
LLM_WEB_SEARCH_ENABLED=true
PLAN_FREE_STORAGE_BYTES=10737418240   # 10 GB (default ทุกแพลน)
```

---

## ขั้นที่ 3 — Networking

| Service | Public? | หมายเหตุ |
|---------|---------|----------|
| api | **ใช่** | เบราว์เซอร์เรียกตรง ต้อง HTTPS |
| web | **ใช่** | user เข้า URL นี้ ต้อง HTTPS |
| worker | ไม่ | ไม่มี HTTP |
| postgres, redis | ไม่ | internal only |

`web/nginx.conf` เสิร์ฟ `/media-sw.js` จาก **root path** พร้อม `Cache-Control: no-store`
ทั้งสองอย่างจำเป็น: scope ของ service worker คือ origin (ถ้าเสิร์ฟจาก `/assets/`
มันจะคุมอะไรไม่ได้เลย และ preview คลิปทุกตัว 404) และถ้า cache ไว้ deploy ใหม่ก็
ไม่ได้ผลจนกว่าเบราว์เซอร์จะยอมทิ้งของเก่า

---

## Checklist ก่อน go-live

- [ ] `JWT_SECRET` ตั้งแล้ว **ค่าเดียวกัน** ทั้ง api และ worker
- [ ] `ADMIN_PASSWORD` + `SEED_EMAIL` ตั้งแล้ว (ไม่งั้น API ไม่ยอม boot)
- [ ] `POSTGRES_PASSWORD` ไม่ใช่ `change_me`
- [ ] `DATA_DIR` ชี้ volume ที่ mount ทั้ง api และ worker **หรือ** ตั้ง S3 ครบ
- [ ] `ELEVENLABS_API_KEY` ถึง worker
- [ ] `FRONTEND_URL` = origin ของ web จริง
- [ ] `VITE_BACKEND_URL` ตอน build web = origin ของ api จริง
- [ ] api pin ไว้ 1 replica (migration รันตอน start)
- [ ] api และ web เป็น HTTPS ทั้งคู่
- [ ] `ENCRYPTION_KEY` ตั้ง ถ้าจะเก็บ AI key ใน DB
- [ ] smoke test: login → import คลิป → ตัด → เปิดโปรเจกต์เดิมจากอีกเบราว์เซอร์

---

## ค่าใช้จ่ายคร่าวๆ

| Resource | ประมาณ |
|----------|--------|
| api + worker + web | ~$5–20/เดือน (usage) |
| Postgres plugin | ~$5+/เดือน |
| Redis plugin | ~$5+/เดือน |
| Volume / R2 | ตามปริมาณไฟล์ |

การเรนเดอร์ทั้งหมดเกิดบนเครื่องผู้ใช้ (WebCodecs) เซิร์ฟเวอร์ทำแค่ AI, เก็บไฟล์
และแปลง codec ที่เบราว์เซอร์ถอดไม่ได้ — RAM ของ worker จึงไม่ใช่ตัวแปรหลัก
