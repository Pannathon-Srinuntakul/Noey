# Deploy Noey Tiktok บน Railway

> อัปเดต: 2026-06-22  
> โปรเจกต์มี `backend/Dockerfile`, `frontend/Dockerfile`, `docker-compose.yml` อยู่แล้ว — Railway ใช้ image เดียวกัน แยกเป็น **หลาย service**

---

## ภาพรวมบน Railway

```
Railway Project
├── PostgreSQL      (plugin — managed)
├── Redis           (plugin — managed)
├── api             (backend Dockerfile — uvicorn)
├── worker          (backend Dockerfile — python -m services.worker)
├── scheduler       (backend Dockerfile — python -m services.scheduler)
└── web             (frontend Dockerfile — nginx + SPA)
```

**Private network:** service คุยกันผ่าน `{ชื่อ-service}.railway.internal`  
**Public URL:** เปิดให้ user เข้าได้แค่ `web` (และ optionally `api` ถ้าไม่ proxy ผ่าน nginx)

---

## ขั้นที่ 1 — สร้าง Project

1. [railway.app](https://railway.app) → New Project
2. **Add PostgreSQL** (plugin)
3. **Add Redis** (plugin)
4. **Deploy from GitHub repo** (เชื่อม repo Noey Tiktok)

---

## ขั้นที่ 2 — สร้าง Services (จาก repo เดียวกัน)

สร้าง service 4 ตัว ชี้ root directory / Dockerfile ตามนี้:

| Service | Root / Dockerfile | Start Command |
|---------|-------------------|---------------|
| **api** | `backend/Dockerfile` | `uvicorn services.api.main:app --host 0.0.0.0 --port $PORT` |
| **worker** | `backend/Dockerfile` | `python -m services.worker` |
| **scheduler** | `backend/Dockerfile` | `python -m services.scheduler` |
| **web** | `frontend/Dockerfile` | (default nginx) |

> **สำคัญ:** Railway กำหนด `$PORT` ให้ — อย่า hardcode 8000 บน api service

### Pre-deploy / Release command (เฉพาะ **api**)

```bash
alembic upgrade head
```

รัน migration ก่อน start ทุก deploy

### ครั้งแรกหลัง DB ว่าง (one-time)

รันใน Railway shell ของ **api** (หรือ one-off job):

```bash
python scripts/migrate_to_multitenant.py
```

สร้าง tenant `default` + admin user (ดู output ใน log)

---

## ขั้นที่ 3 — Environment Variables

ตั้งใน Railway → แต่ละ service (หรือ Shared Variables)

### จาก PostgreSQL plugin (Reference Variables)

Railway ให้ `DATABASE_URL` — แอปเราใช้ `POSTGRES_*` แยก ให้ map แบบนี้:

```env
POSTGRES_HOST=${{Postgres.PGHOST}}
POSTGRES_PORT=${{Postgres.PGPORT}}
POSTGRES_USER=${{Postgres.PGUSER}}
POSTGRES_PASSWORD=${{Postgres.PGPASSWORD}}
POSTGRES_DB=${{Postgres.PGDATABASE}}
```

### จาก Redis plugin

```env
REDIS_URL=${{Redis.REDIS_URL}}
```

> ถ้า Redis URL เป็น `redis://` ธรรมดา arq ใช้ได้ (มี `RedisSettings.from_dsn`)

### บังคับทุก backend service (api, worker, scheduler)

```env
JWT_SECRET=<random-64-chars>          # python -c "import secrets; print(secrets.token_hex(32))"
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=anthropic/claude-haiku-4-5-20251001
ALLOW_REGISTRATION=false
```

### Optional

```env
ENCRYPTION_KEY=...                    # Fernet key ถ้าเก็บ API key ใน DB
LLM_WEB_SEARCH_ENABLED=true
```

### Frontend service (**web**)

nginx ใน `frontend/nginx.conf` ตอนนี้ proxy ไป `http://api:8000` — **ใช้ได้แค่ docker-compose**

บน Railway ต้องแก้เป็นหนึ่งในสองแบบ:

#### แบบ A (แนะนำ): Private networking + envsubst

1. ตั้ง env บน service **web**:
   ```env
   API_INTERNAL_HOST=api.railway.internal
   API_INTERNAL_PORT=8000
   ```
   (`8000` = PORT ที่ service **api** bind — ต้องตรงกับ `$PORT` ของ api)

2. แก้ nginx ให้ใช้ host จาก env (entrypoint script) — **ยังไม่ได้ทำใน repo** ต้อง implement ก่อน deploy web

#### แบบ B: แยก domain API (ง่ายกว่าชั่วคราว)

1. เปิด **Public URL** ให้ service **api** → ได้ `https://noey-api-production.up.railway.app`
2. Build frontend ด้วย `VITE_API_BASE=https://noey-api-production.up.railway.app` (ต้องแก้ `api.ts` ให้อ่าน env — **ยังไม่ได้ทำ**)
3. เปิด CORS บน FastAPI ให้ origin ของ web

#### แบบ C: Deploy แค่ API บน Railway ก่อน

- Frontend รัน local / Vite dev proxy ชั่วคราว
- หรือ frontend บน Vercel ชี้ API URL

---

## ขั้นที่ 4 — Networking

| Service | Public? | หมายเหตุ |
|---------|---------|----------|
| api | Optional | ถ้า web proxy ผ่าน private ไม่ต้อง public |
| worker | **ไม่** | ไม่มี HTTP |
| scheduler | **ไม่** | ไม่มี HTTP |
| web | **ใช่** | user เข้า URL นี้ |
| postgres, redis | **ไม่** | internal only |

---

## ขั้นที่ 5 — CORS (ถ้า frontend คนละ domain กับ API)

แก้ `backend/services/api/main.py`:

```python
allow_origins=["https://your-web.up.railway.app"]
```

(ตอนนี้ allow แค่ `localhost:5173`)

---

## Video editing บน Railway (อนาคต)

| ส่วน | Railway |
|------|---------|
| **FFmpeg** | เพิ่มใน `backend/Dockerfile`: `RUN apt-get install -y ffmpeg` |
| **faster-whisper** | รันบน worker ได้ — CPU ช้า, ใช้ RAM ~2GB+ |
| **Remotion** | service แยก (Node) — RAM 2–4GB+, แพง |
| **ไฟล์วิดีโอ** | อย่าเก็บ local disk ถาวร — ใช้ **Railway Volume** (ชั่วคราว) หรือ **Cloudflare R2 / S3** (แนะนำ) |

Worker สำหรับ video ควรเป็น service แยก `video-worker` (scale ต่างจาก worker ทั่วไป)

---

## Checklist ก่อน go-live

- [ ] `JWT_SECRET` เปลี่ยนจาก dev
- [ ] `alembic upgrade head` ใน release command
- [ ] รัน `migrate_to_multitenant.py` ครั้งแรก
- [ ] api bind `$PORT`
- [ ] แก้ nginx หรือ `VITE_API_BASE` ให้ web เรียก api ได้
- [ ] CORS production origin
- [ ] Redis + worker + scheduler รันอยู่ (เช็ค logs)
- [ ] ทดสอบ login + chat + import CSV

---

## ค่าใช้จ่ายคร่าวๆ (Railway)

| Resource | ประมาณ |
|----------|--------|
| api + web + worker + scheduler | ~$5–20/เดือน (usage) |
| Postgres plugin | ~$5+/เดือน |
| Redis plugin | ~$5+/เดือน |
| Video worker + storage | เพิ่มตาม usage |

ใช้ **Hobby plan** ทดสอบได้ — production ควร monitor RAM ของ worker

---

## สิ่งที่ต้อง implement ใน repo ก่อน deploy สมบูรณ์

1. **api start command** ใช้ `$PORT` (Railway)
2. **frontend → api** บน Railway (nginx envsubst หรือ `VITE_API_BASE`)
3. **CORS** production origins
4. (Optional) `DATABASE_URL` รองรับใน `settings.py` — Railway ให้ URL เดียว
5. (Video) FFmpeg ใน Dockerfile + object storage

---

## คำสั่ง local ที่ mirror Railway

```powershell
docker compose up -d postgres redis api worker scheduler web
# เปิด http://localhost:8080
```

Local ใช้ network ชื่อ `api` ใน nginx — เหมือนที่ Railway ใช้ `api.railway.internal`
