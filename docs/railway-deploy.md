> **2026-09-09:** `frontend/` (the legacy dashboard this doc's frontend section described) has been DELETED. The Railway frontend service builds from `web/` now; every mention of `frontend/` below is historical.

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
รันเองตอน API start (`lifespan` ใน `services/api/main.py`) ภายใต้ Postgres advisory
lock (`_startup_lock`) — process แรกที่ได้ lock เป็นคน migrate ที่เหลือรอแล้วพบว่าไม่มีอะไรต้องทำ
ดังนั้น **api หลาย replica (และ `API_WORKERS` > 1) start พร้อมกันได้** ไม่ต้อง pin ไว้ที่ 1

### Healthcheck path (api)

ตั้ง **Deploy → Healthcheck Path = `/health/ready`** (timeout 300 s พอ — migrate + seed
รันก่อนพอร์ตเปิด) Railway จะสลับ traffic ไป deployment ใหม่ก็ต่อเมื่อ path นี้ตอบ 200
ซึ่งหมายถึง process นั้น `SELECT 1` ผ่าน Postgres และ `PING` Redis ได้จริง (แต่ละอย่าง
timeout 1 s) ถ้าอันใดอันหนึ่งล้มจะได้ 503 พร้อม `{"db": "ok|fail", "redis": "ok|fail"}`
บอกว่าตัวไหน — ส่วน `/health` เป็น liveness เฉย ๆ (ตอบ 200 เสมอเมื่อ process ขึ้น)
ห้ามใช้เป็น healthcheck path เพราะ deploy ที่ต่อ Redis ไม่ได้ก็จะผ่าน

`HEALTHCHECK` ใน `backend/Dockerfile` (probe `/health`) มีไว้ให้ `docker compose`
Railway ไม่อ่านค่านั้น

### web: build argument

`VITE_BACKEND_URL` เป็น **build-time** ไม่ใช่ runtime — ค่านี้ถูกฝังทั้งใน bundle
และใน Content-Security-Policy ของหน้าเว็บ (`web/vite.config.ts`) เปลี่ยนแล้วต้อง
**rebuild** ไม่ใช่ restart

```
VITE_BACKEND_URL=https://noey-api-production.up.railway.app
```

หมายเหตุชื่อ service บน Railway สลับกับความหมาย: **"Noey Frontend"** (nginx, port 8080,
`noey-frontend-production.up.railway.app`) คือตัวแก้ไขวิดีโอ (`web/`) ส่วน **"Noey Studio"**
(Next, port 3000) คือเว็บไซต์หน้าร้าน (noey-frontend repo) — ตั้ง `VITE_*` ที่ "Noey Frontend"

`VITE_UPLOAD_ORIGIN` ก็เป็น build-time เหมือนกัน — origin ของ bucket ที่เบราว์เซอร์
PUT ไฟล์ตรงเข้าไป (presigned upload, `web/src/lib/directUpload.ts`) ต้องอยู่ใน
`connect-src` ของ CSP ไม่งั้นเบราว์เซอร์บล็อกเองแล้ว client ถอยไปอัปโหลดผ่าน api
(ช้ากว่าและกินแบนด์วิดท์ของ api — วัด 2026-09-23 ได้ ~110 MB/s รวมทุกคน)

```
VITE_UPLOAD_ORIGIN=https://<bucket>.<endpoint host>   # scripts/set_bucket_cors.py พิมพ์ค่านี้ให้
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
RAILWAY_RUN_UID=0   # image รันเป็น user `app` (ไม่ใช่ root) แต่ Railway mount volume เป็นของ root
```

ถ้าไม่ตั้ง `RAILWAY_RUN_UID=0` ทุกการเขียนลง volume จะได้ Permission denied
(docs.railway.com/volumes#permissions) แบบ B ไม่ต้องตั้ง

**แบบ B — S3 / Cloudflare R2 (จำเป็นเมื่อ worker หลาย replica)**

```env
S3_BUCKET=noey-videos
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com   # R2 เท่านั้น; AWS ไม่ต้องตั้ง
S3_REGION=auto
```

**อัปโหลดตรงเข้า bucket** (แบบ B): bucket ต้องยอมรับ PUT จาก origin ของหน้าเว็บ
(CORS) — รันครั้งเดียวต่อ bucket ด้วยตัวแปร S3_* ของ production

```
cd backend && railway run --service "Noey Api" --environment production -- \
  python scripts/set_bucket_cors.py https://noey-frontend-production.up.railway.app
```

สคริปต์พิมพ์ origin ที่ต้องใส่ใน `VITE_UPLOAD_ORIGIN` ของ web ให้ด้วย

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

### IP ของ client หลัง proxy (rate limit)

```env
TRUSTED_PROXY_HOPS=1
```

จำนวน reverse proxy ที่เชื่อถือได้ซึ่งต่อท้าย `X-Forwarded-For` ก่อนถึง api
(`services/api/ratelimit.py:client_ip`) — บน Railway มี edge proxy ของ Railway หนึ่งชั้น
จึงเป็น **1**: api จะอ่าน IP จากรายการที่ 1 นับจากขวา ค่า default `0` ใช้ IP ของ socket
ซึ่งบน Railway คือ proxy เอง → ทุกคนกลายเป็น IP เดียวกันและ rate limit ต่อ IP
(login/register/contact) จะล็อกผู้ใช้ทั้งหมดพร้อมกัน ตั้งมากกว่าจำนวน proxy จริง
ก็อันตรายเช่นกัน: client ปลอม header แล้วเลือก IP ตัวเองได้

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
- [ ] `VITE_UPLOAD_ORIGIN` ตอน build web = origin ของ bucket และรัน `set_bucket_cors.py` แล้ว
- [ ] api: Healthcheck Path = `/health/ready` (replica กี่ตัวก็ได้ — migrate อยู่ใต้ advisory lock)
- [ ] `TRUSTED_PROXY_HOPS=1` บน api (ไม่งั้น rate limit ต่อ IP เห็นทุกคนเป็น proxy)
- [ ] `RAILWAY_RUN_UID=0` บน api + worker ถ้าใช้ Railway Volume (แบบ A)
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
