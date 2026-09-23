# syntax=docker/dockerfile:1
# Hello Crew Python helpers. Two targets from one file:
#   voice  - Kokoro TTS + Whisper STT (tts_server.py)
#   ncert  - NCERT textbook search over ChromaDB (ncert/)
# Copyright (c) 2026 PacificAI. All rights reserved.
FROM python:3.12-slim AS base

LABEL org.opencontainers.image.vendor="PacificAI" \
      org.opencontainers.image.licenses="LicenseRef-PacificAI-Proprietary"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# libgomp: OpenMP runtime used by onnxruntime / ctranslate2.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 app
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS voice
LABEL org.opencontainers.image.title="Hello Crew voice"
COPY docker/requirements-voice.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt
COPY LICENSE tts_server.py ./
# Kokoro model files -> /app/data/kokoro, Whisper weights -> HF cache; both are volumes.
ENV KITTEN_HOST=0.0.0.0 KITTEN_PORT=5005 HF_HOME=/app/data/hf
RUN mkdir -p /app/data/kokoro /app/data/hf && chown -R app:app /app/data
USER app
EXPOSE 5005
CMD ["python", "-u", "tts_server.py"]

# ---------------------------------------------------------------------------
FROM base AS ncert
LABEL org.opencontainers.image.title="Hello Crew NCERT search"
COPY docker/requirements-ncert.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt
COPY LICENSE ./
COPY ncert ./ncert
ENV NCERT_HOST=0.0.0.0 NCERT_PORT=5006 NCERT_DB=/app/data/chroma
RUN mkdir -p /app/data/chroma /app/data/ncert_pdfs && chown -R app:app /app/data
USER app
EXPOSE 5006
CMD ["python", "-u", "-m", "ncert.server"]
