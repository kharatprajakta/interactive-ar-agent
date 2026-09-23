# Deploying Hello Crew

> © 2026 PacificAI. All rights reserved. Internal document.

Hello Crew runs as one Docker Compose stack. The same files serve a developer machine today and a production server later.

```
                 public HTTPS (Tailscale Funnel)
                              │
          127.0.0.1:3000 ┌────▼────┐        127.0.0.1:3001 ┌─────────┐
                         │   app   │                       │  admin  │  operators only
                         └┬──┬──┬──┘                       └────┬────┘
            ┌─────────────┘  │  └──────────────┐                │
       ┌────▼────┐      ┌────▼────┐       ┌────▼────┐     ┌─────▼─────┐   ┌───────────┐
       │  voice  │      │  ncert  │──────►│ ollama  │     │ postgres  │◄──│ db-backup │──► ./backups
       │ Kokoro+ │      │ChromaDB │ embed │  (GPU)  │     │  17       │   │ nightly   │
       │ Whisper │      └─────────┘       └─────────┘     └───────────┘   └───────────┘
       └─────────┘
```

| Service | Image | Data (volume) | Reachable from |
|---|---|---|---|
| `app` | `docker/node.Dockerfile` | none (stateless) | `127.0.0.1:3000` (the tunnel points here) |
| `admin` | same image, `admin/server.js` | none | `127.0.0.1:3001` only |
| `postgres` | `postgres:17-alpine` | `pgdata` | inside the stack; `127.0.0.1:5433` locally |
| `db-backup` | `postgres:17-alpine` | writes `./backups` on the host | none |
| `ollama` | `ollama/ollama` (GPU) | `ollama` (models) | inside the stack |
| `ollama-pull` | one-shot | none | pulls the chat + embedding models if missing |
| `voice` | `docker/python.Dockerfile` target `voice` | `voice-kokoro`, `voice-hf` | inside the stack |
| `ncert` | `docker/python.Dockerfile` target `ncert` | `ncert-chroma`, `ncert-pdfs` | inside the stack |
| `tailscale` | `tailscale/tailscale` (profile `public`) | `tailscale-state` | the internet, via Funnel |

**Hardening:**
- Every service restarts automatically (`unless-stopped`) and has a health check.
- Every service runs with `no-new-privileges`. The app and admin also drop all Linux capabilities and use a read-only filesystem.
- Logs are capped at 3 × 10 MB per service.
- Nothing listens on your network: the only published ports are bound to `127.0.0.1`.
- Each service gets only the secrets it needs. For example, the voice service can't see the database password.

---

## Local (Docker Desktop, Windows)

1. **Docker Desktop.** In Settings → General, turn on **"Start Docker Desktop when you sign in"**, so the stack comes back after a reboot. GPU support works with the WSL2 backend.
2. **Settings.** Copy the template and fill in the blanks:
   ```powershell
   copy .env.example .env    # set INVITE_CODE, ADMIN_PASSWORD, POSTGRES_PASSWORD (+ DATABASE_URL)
   ```
3. **Reuse what's already downloaded (optional).** This copies your Ollama models, the NCERT index and the Kokoro voices into the volumes:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\scripts\seed-volumes.ps1
   ```
4. **Start:**
   ```powershell
   docker compose up -d --build
   docker compose ps          # everything should turn "healthy" (voice takes a few minutes on first run)
   ```
5. **Open:**
   - the app at http://localhost:3000
   - the admin panel at http://localhost:3001 (sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`)
6. **Public link:** keep `tailscale funnel --bg 3000` running on the host. It forwards `https://<machine>.<tailnet>.ts.net` to port 3000.

### Everyday commands

```powershell
docker compose logs -f app                 # follow a service's logs
docker compose restart app                 # restart one service
docker compose up -d --build app admin     # rebuild after code changes
docker compose down                        # stop (data stays in volumes)
docker compose run --rm ncert python -m ncert.ingest download jesc1   # index more NCERT books
```

`docker compose down -v` **deletes all data** (users, memory, models). Don't use it unless you mean it.

---

## Settings and secrets

| File | Committed? | Purpose |
|---|---|---|
| `.env.example` | ✅ | Every setting, documented, with no secrets |
| `.env` | ❌ gitignored | Local values: invite code, admin and database passwords |
| `deploy/production.env` | ❌ gitignored | Production values. Make it from `.env.example` on the server |
| `deploy/compose.prod.yaml` | ✅ | Production overrides: released images, no DB port, pinned Ollama |

**Rotating secrets:**
- **Invite code:** edit `INVITE_CODE`, then `docker compose up -d app`.
- **Admin password:** edit `ADMIN_PASSWORD`, then `docker compose up -d admin`.
- **Database password:** change it inside Postgres first (`ALTER USER hellocrew PASSWORD '…'`), then update `.env` and run `docker compose up -d`.

---

## Backups and restore

- `db-backup` writes `backups/hellocrew-YYYYMMDD-HHMMSS.dump` every `BACKUP_INTERVAL_HOURS` (default 24) and deletes dumps older than `BACKUP_KEEP_DAYS` (default 14).
- `backups/` is on the host, outside Docker. Copy it somewhere else (a cloud drive, another disk) for real off-site safety.
- **Back up now:**
  ```powershell
  docker compose exec db-backup sh -c 'pg_dump -Fc -f /backups/manual-$(date +%Y%m%d-%H%M).dump'
  ```
- **Restore** (this replaces the current data):
  ```powershell
  docker compose stop app admin
  docker compose exec -T postgres pg_restore --clean --if-exists --no-owner -U hellocrew -d hellocrew < backups\hellocrew-XXXX.dump
  docker compose start app admin
  ```
- Models and the NCERT index can be re-downloaded or re-indexed, so they aren't backed up.

---

## CI/CD (GitHub Actions)

| Workflow | When | What |
|---|---|---|
| `ci.yml` | Every push and PR | JS syntax check, Python compile, Compose validation (local and production), builds all three images (no push) |
| `release.yml` | Push to `main`, tags `v*.*.*`, manual | Builds and pushes `ghcr.io/<owner>/hello-crew-{app,voice,ncert}`. Tags: branch name, short SHA, and for `v1.2.3` tags `1.2.3`, `1.2` and `latest` |

**Cutting a release:** `git tag v0.2.0 && git push origin v0.2.0`.

GHCR packages are private by default. The production server logs in with a GitHub token that has `read:packages`.

---

## Production (later)

**Target:** a Linux server with an NVIDIA GPU (the chat model needs about 4 GB of VRAM), Docker Engine and the NVIDIA Container Toolkit.

1. On the server, check out this repo (only `compose.yaml`, `deploy/` and `.env.example` are needed), then create the settings file:
   ```bash
   cp .env.example deploy/production.env   # set everything, incl. GHCR_OWNER, RELEASE_TAG=0.2.0, OLLAMA_VERSION (pinned), TS_AUTHKEY
   ```
2. Log in to the registry and start the stack:
   ```bash
   echo "$GITHUB_TOKEN" | docker login ghcr.io -u <user> --password-stdin
   docker compose -f compose.yaml -f deploy/compose.prod.yaml --env-file deploy/production.env --profile public up -d
   ```
   The `tailscale` container joins your tailnet as `TS_HOSTNAME` and serves the app publicly over HTTPS through Funnel. Its config is in `deploy/tailscale/serve.json`.
3. **Admin panel:** it isn't public. Reach it through an SSH tunnel (`ssh -L 3001:127.0.0.1:3001 server`) or over the tailnet.
4. **Upgrades:** set `RELEASE_TAG` to the new version, then `docker compose … pull && docker compose … up -d`. Migrations run automatically on start.
5. **Still to decide for production:**
   - off-site backup storage (for example, sync `backups/` to S3 or B2)
   - monitoring and alerts on the health checks
   - a deploy job in `release.yml` (SSH plus `compose pull/up`) once the server exists
   - a managed Postgres, if preferred (point `DATABASE_URL` at it and drop the `postgres` service)
