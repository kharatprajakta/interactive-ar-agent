# syntax=docker/dockerfile:1
# Hello Crew web app + admin panel (one image, two commands).
# Copyright (c) 2026 PacificAI. All rights reserved.
FROM node:24-slim

LABEL org.opencontainers.image.title="Hello Crew" \
      org.opencontainers.image.description="Hello Crew web app and admin panel" \
      org.opencontainers.image.vendor="PacificAI" \
      org.opencontainers.image.licenses="LicenseRef-PacificAI-Proprietary"

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY LICENSE THIRD_PARTY_NOTICES.md server.js ./
COPY lib ./lib
COPY public ./public
COPY admin ./admin

USER node
EXPOSE 3000 3001
# Overridden per service in compose.yaml (the admin panel runs admin/server.js).
CMD ["node", "server.js"]
