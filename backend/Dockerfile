# Backend image — serves both the API (default CMD) and the scheduler (command override).
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

# Create runtime data directories (gitignored, not in source).
RUN mkdir -p data/video_uploads data/video_outputs data/models

COPY pyproject.toml alembic.ini ./
COPY packages ./packages
COPY services ./services
COPY scripts ./scripts
RUN pip install --upgrade pip && pip install -e .

EXPOSE 8000

# Railway injects PORT at runtime — must listen on 0.0.0.0:$PORT (not hardcoded 8000).
#
# API_WORKERS is how the API uses more than one core. One uvicorn process is one
# event loop on one core, so on an 8 vCPU host a single worker leaves seven idle
# — the load test on 2026-09-22 measured 0.05 of 8 vCPU while requests queued.
# Each worker is a separate process with its own database pool, so the pool
# settings multiply: keep API_WORKERS x (DB_POOL_SIZE + DB_MAX_OVERFLOW) under
# the server's max_connections (500 on this Postgres, measured 2026-09-23).
# Default 1 so a plain `docker run` and local development behave as before.
CMD ["sh", "-c", "uvicorn services.api.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${API_WORKERS:-1}"]
