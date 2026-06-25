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
RUN pip install --upgrade pip && pip install -e .

EXPOSE 8000

CMD ["uvicorn", "services.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
