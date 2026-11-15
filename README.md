# SnackTracker — Baby Tracker PWA

An offline-first, multi-parent **Baby Tracker Progressive Web App (PWA)** for logging feeds (breast & bottle), sleep, diapers, and spit-ups—complete with daily & multi-day analytics, pediatrician exports, `en-US` / `zh-CN` internationalization, and scale-to-zero Cloud Run deployment.

**Live Demo:** https://baby-tracker-myr7twizua-uc.a.run.app

---

## Features

- **Breastfeeding Timer (Left / Right)**: Live timestamp-driven timer with pause/resume, instant left/right side switching, and manual entry.
- **Bottle Feeding**: Track start & end times, volume in `ml` or `oz`, and milk type (breast milk / formula) via live timer or quick entry.
- **Sleep Tracking**: Separate **Nap** and **Night Sleep** timers with midnight-splitting and DST-aware daily aggregation.
- **1-Tap Diaper & Spit-Up Logging**: Instant **Wet**, **Poopy**, or **Both** (`+1 wet` & `+1 poopy` clinical counting) with undo toast, plus spit-up volume & notes.
- **Offline-First with Atomic Delta Sync**: Works seamlessly offline using IndexedDB (`idb`) and Workbox service worker precaching; queues mutations locally and syncs idempotently on reconnect.
- **Multi-Parent & Multi-Baby Sharing**: Create multiple baby profiles, switch between them effortlessly, and share access with partners/caregivers via 8-character invite codes (`owner`, `caregiver`, `viewer` roles).
- **Daily Stats, Trends & Pediatrician Export**: View daily KPIs, 7/14/30-day trends, and export offline-capable CSV, JSON, or printable summary reports for pediatrician visits.
- **Mobile-First + Desktop Responsive**: Thumb-zone bottom navigation on phones, sidebar navigation on laptops/desktops, light/dark system theme, and clean category accents.
- **Bilingual (`en-US` / `zh-CN`)**: Full American English and Mainland Chinese UI with a persistent `EN / 中文` language switcher.

---

## Screenshots

### Desktop Dashboard (English)
![Desktop Dashboard](docs/screenshots/dashboard-desktop.png)

### Desktop Dashboard (Mainland Chinese / 简体中文)
![Desktop Dashboard Chinese](docs/screenshots/dashboard-zh.png)

### Mobile Dashboard & Multi-Day Trends
| Mobile View (`390×844`) | Multi-Day Trends |
| :---: | :---: |
| ![Mobile Dashboard](docs/screenshots/dashboard-mobile.png) | ![Trends View](docs/screenshots/trends-desktop.png) |

---

## Architecture

TypeScript ESM monorepo:

- [`packages/shared`](packages/shared) — Shared Zod schemas, domain types, timezone/DST-safe daily & range stats engine, and pediatrician CSV/JSON/summary exporters.
- [`apps/server`](apps/server) — Stateless Fastify API (`0.0.0.0:$PORT`, `/healthz`, graceful `SIGTERM` shutdown) with `scrypt` + HMAC `HttpOnly` cookie auth, delta sync (`/api/sync/push`, `/api/sync/pull`), and pluggable `StorageAdapter` (**SQLite**, **Cloud Firestore**, **PostgreSQL**).
- [`apps/web`](apps/web) — React 19 + Vite + Tailwind CSS v4 + `vite-plugin-pwa` (Workbox) + `idb` offline-first PWA.
- [`cloudrun`](cloudrun) — Cloud Run Knative service manifest ([`cloudrun/service.yaml`](cloudrun/service.yaml)) configured for scale-to-zero (`minScale: "0"`).
- [`e2e`](e2e) — Playwright end-to-end test suite (Tiers 1–6 across desktop & mobile viewports).

---

## Local Development & Testing

### Prerequisites
- Node.js 24+ (uses built-in `node:sqlite` for local SQLite)
- npm 10+

### Setup & Run
```bash
npm install
npm run build
npm start
```
By default, the server starts on `http://0.0.0.0:8080` using local SQLite (`./data/baby-tracker.sqlite`) and serves the built PWA from `apps/web/dist`.

For frontend hot-reload during development:
```bash
# Terminal 1: API server
npm run dev --workspace=apps/server

# Terminal 2: Vite dev server
npm run dev --workspace=apps/web
```

### Tests
```bash
# Typecheck, build, and run all unit/integration tests (73 tests)
npm run typecheck && npm run build && npm test

# Run Playwright E2E suite (156 tests across desktop & mobile)
cd e2e && npm install && E2E_START_SERVER=1 npx playwright test
```

---

## Deploying with Supported Backends

The server selects its storage backend automatically via environment variables (or explicitly via `STORAGE_BACKEND=sqlite|firestore|postgres`):

| Backend | Selection Rule | Best For |
| :--- | :--- | :--- |
| **Cloud Firestore** | `STORAGE_BACKEND=firestore` (or `FIRESTORE_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT` set without `DATABASE_URL`) | **GCP Free Tier + Cloud Run scale-to-zero** (no idle DB cost, zero manual indexes needed) |
| **PostgreSQL** | `STORAGE_BACKEND=postgres` or `DATABASE_URL` set | Cloud SQL, Neon, Supabase, or self-hosted Postgres |
| **SQLite** | Default fallback (`SQLITE_PATH`, defaults to `./data/baby-tracker.sqlite`) | Local dev, Docker single-node with persistent volume |

---

### Option 1: Google Cloud Run + Firestore (Free Tier, Scale-to-Zero)

Cloud Firestore in Native mode includes an always-free tier (1 GiB storage, 50K reads/day, 20K writes/day), and Cloud Run scales to zero when idle.

1. **Enable APIs & create the Firestore Native database**:
   ```bash
   export PROJECT_ID=your-gcp-project-id
   export REGION=us-central1

   gcloud services enable \
     run.googleapis.com \
     cloudbuild.googleapis.com \
     artifactregistry.googleapis.com \
     firestore.googleapis.com \
     --project="$PROJECT_ID"

   gcloud firestore databases create \
     --location="$REGION" \
     --type=firestore-native \
     --project="$PROJECT_ID"
   ```

2. **Build & deploy to Cloud Run**:
   ```bash
   gcloud builds submit --tag "gcr.io/$PROJECT_ID/baby-tracker:latest" --project="$PROJECT_ID"

   gcloud run deploy baby-tracker \
     --image="gcr.io/$PROJECT_ID/baby-tracker:latest" \
     --region="$REGION" \
     --project="$PROJECT_ID" \
     --allow-unauthenticated \
     --min-instances=0 \
     --max-instances=10 \
     --memory=512Mi \
     --set-env-vars="NODE_ENV=production,STORAGE_BACKEND=firestore,FIRESTORE_PROJECT_ID=$PROJECT_ID" \
     --set-env-vars="SESSION_SECRET=$(openssl rand -hex 32)"
   ```
   *(On Cloud Run, the runtime service account uses Application Default Credentials automatically; ensure it has `roles/datastore.user` if using a custom service account. For local testing against Firestore, set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`.)*

---

### Option 2: PostgreSQL (Cloud Run, Fly.io, Render, Railway, or Docker)

`PostgresStorageAdapter` automatically creates all required tables and indexes on startup.

```bash
docker build -t baby-tracker:latest .
docker run -d \
  -p 8080:8080 \
  -e NODE_ENV=production \
  -e STORAGE_BACKEND=postgres \
  -e DATABASE_URL="postgres://user:password@host:5432/baby_tracker?sslmode=require" \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  baby-tracker:latest
```

---

### Option 3: SQLite (Single-Instance Docker / VPS)

Mount a persistent volume at `/app/data` so the SQLite WAL database persists across container restarts:

```bash
docker build -t baby-tracker:latest .
docker run -d \
  -p 8080:8080 \
  -v baby-tracker-data:/app/data \
  -e NODE_ENV=production \
  -e STORAGE_BACKEND=sqlite \
  -e SQLITE_PATH=/app/data/baby-tracker.sqlite \
  -e COOKIE_SECURE=false \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  baby-tracker:latest
```
*(Set `COOKIE_SECURE=false` only when serving over plain HTTP on `localhost`/LAN; keep `true` behind HTTPS.)*

---

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8080` | HTTP port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `STORAGE_BACKEND` | Auto | `sqlite`, `firestore`, or `postgres` |
| `FIRESTORE_PROJECT_ID` | `GOOGLE_CLOUD_PROJECT` | GCP project ID for Firestore |
| `FIRESTORE_DATABASE_ID` | `(default)` | Optional named Firestore database |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `SQLITE_PATH` | `./data/baby-tracker.sqlite` | SQLite database file path (or `:memory:`) |
| `SESSION_SECRET` | Dev fallback | HMAC secret for signing session cookies (**set in production**) |
| `COOKIE_SECURE` | `true` in production | Set `Secure` flag on session cookies |
| `STATIC_DIR` | `apps/web/dist` | Path to built PWA static assets |
