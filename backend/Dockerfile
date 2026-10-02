# Backend image — serves both the API (default CMD) and the worker (command override).
#
# Pinned to a digest, not a moving tag: `python:3.12-slim` is rebuilt whenever
# Debian ships a patch, and a push to main is a production deploy (CLAUDE.md
# rule 1), so the base must not change under a commit that touched nothing.
# Bump deliberately: `docker pull python:3.12-slim` (or the Docker Hub tags
# API) gives the new digest — the manifest-list digest, so it resolves on
# amd64 and arm64 alike. Digest fetched 2026-09-27.
#
# The blog cover renderer (render_cover: satori + resvg, backend/cover_renderer/,
# docs/blog-mcp.md) needs a `node` binary and its node_modules — nothing else
# from Node. They are prepared in a throwaway stage and only the binary and
# the installed modules are copied into the runtime image: no npm, no apt
# nodejs, no build tools. Node is pinned by digest like the Python base
# (fetched 2026-10-02, node v22.23.3).
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS cover-renderer
WORKDIR /cover
COPY cover_renderer/package.json cover_renderer/package-lock.json ./
# `npm ci` installs exactly the lockfile (integrity hashes checked); no
# package here has an install script, and none may run one.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

# Dependencies FIRST and from the lock, so the layer is cached until the lock
# changes and the image only ever contains what requirements.lock says
# (`--no-deps` both times: nothing may be resolved at build time — that is how
# a push used to pull a new litellm nobody had run). `pip check` fails the
# build if the lock is missing something the project imports transitively.
# `--require-hashes`: the lock carries the sha256 of every release file
# (scripts/lock_requirements.py), so a version replaced upstream fails the
# build instead of deploying. No `pip install --upgrade pip` any more — that
# pulled whatever pip was newest, unhashed; the digest-pinned base's pip is
# what runs.
# Editable install of the project itself, as before: services/ and packages/
# are used in place, and alembic.ini + scripts/ are found relative to them.
COPY pyproject.toml requirements.lock alembic.ini ./
RUN pip install --no-deps --require-hashes -r requirements.lock
COPY packages ./packages
COPY services ./services
COPY scripts ./scripts
RUN pip install --no-deps -e . && pip check

# The cover renderer: the node binary (~120 MB uncompressed, statically
# linked apart from glibc/libstdc++, which the slim base already has) and the
# renderer's installed modules (~25 MB: satori, resvg's prebuilt linux binary,
# juice). The API spawns ONE `node cover_renderer/worker.mjs` per process on
# the first render_cover call and stops it when idle (packages/blog/cover.py).
COPY --from=cover-renderer /usr/local/bin/node /usr/local/bin/node
COPY --from=cover-renderer /cover/node_modules ./cover_renderer/node_modules
COPY cover_renderer/package.json cover_renderer/worker.mjs ./cover_renderer/
RUN node --version

# Run as an unprivileged user. Everything above ran as root (apt, pip into
# system site-packages); from here the process can read the code but write
# only to its own data directory and HOME. The data directories are the
# default DATA_DIR (backend/data → /app/data) and are gitignored, so they are
# created here rather than copied. HOME is where pythainlp keeps its corpus
# downloads and NUMBA_CACHE_DIR where librosa's numba-compiled kernels land —
# both need a writable path now that site-packages is not.
#
# /data is the DATA_DIR the compose file and a Railway Volume mount. It is
# created here, owned by app, because a mountpoint Docker has to invent is
# root's — and a FRESH named volume copies the image directory's ownership,
# while one created by the old root-running image keeps root's (fix once:
# `docker compose run --rm --user root api chown -R app:app /data`). Railway
# mounts volumes as root regardless: set RAILWAY_RUN_UID=0 on a service that
# uses one (docs/railway-deploy.md) — S3 storage needs nothing.
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin app \
    && mkdir -p data/video_uploads data/video_outputs data/models /data \
    && chown -R app:app /app/data /data
ENV HOME=/home/app \
    NUMBA_CACHE_DIR=/tmp/numba-cache
USER app

EXPOSE 8000

# Liveness for `docker compose` (Railway ignores Docker HEALTHCHECK and uses
# its own healthcheck path — /health/ready, see docs/railway-deploy.md).
# Plain python: the slim image has neither curl nor wget, and adding one for a
# probe is an extra package to patch. The worker runs this image with a
# command override and serves no HTTP; docker-compose.yml disables the check
# for that service.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT', '8000'), timeout=3)"

# Railway injects PORT at runtime — must listen on 0.0.0.0:$PORT (not hardcoded 8000).
#
# API_WORKERS is how the API uses more than one core. One uvicorn process is one
# event loop on one core, so on an 8 vCPU host a single worker leaves seven idle
# — the load test on 2026-09-22 measured 0.05 of 8 vCPU while requests queued.
# Each worker is a separate process with its own database pool, so the pool
# settings multiply: keep API_WORKERS x (DB_POOL_SIZE + DB_MAX_OVERFLOW) under
# the server's max_connections (500 on this Postgres, measured 2026-09-23).
# Default 1 so a plain `docker run` and local development behave as before.
# Migrations + seed run in the app's lifespan under a database advisory lock
# (services/api/main.py), so N workers — or N replicas — start safely at once.
# "::" listens on IPv6 and IPv4 (dual stack). Railway's private network
# (noey-api.railway.internal) is IPv6: on 0.0.0.0 the site and admin could only
# reach the API through its public domain, and from inside Railway that hop
# timed out intermittently (2026-10-02 — /account showed "ระบบบัญชีขัดข้อง").
CMD ["sh", "-c", "uvicorn services.api.main:app --host :: --port ${PORT:-8000} --workers ${API_WORKERS:-1}"]
