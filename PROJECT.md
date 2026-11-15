# Project: Baby Tracker PWA

## Architecture

A local-first, multi-parent Baby Tracker Progressive Web App (PWA) built as a TypeScript ESM monorepo:

- **`packages/shared`**: Shared TypeScript domain types, Zod validation schemas, daily stats & midnight-split/timezone aggregation helpers, clinical diaper counting, and pediatrician CSV/JSON/summary formatters.
- **`apps/server`**: Stateless Node.js 24 + Fastify HTTP server listening on `0.0.0.0:$PORT` (default `8080`). Exposes `/healthz`, `/api/auth/*`, `/api/babies/*`, `/api/invites/*`, `/api/sync/push`, `/api/sync/pull`, and serves `apps/web/dist` in production. Uses a pluggable `StorageAdapter`: SQLite (`node:sqlite` / `better-sqlite3`) by default for zero-config local/dev/test, and PostgreSQL (`pg`) when `DATABASE_URL` is set for Cloud Run scale-to-zero.
- **`apps/web`**: React 19 + Vite + Tailwind CSS + `vite-plugin-pwa` (Workbox) + `idb` (IndexedDB). All reads and writes hit IndexedDB first in atomic transactions (`events`/`babies` + `outbox`), with timestamp-driven active timers (`started_at`/`ended_at`), incremental push/pull sync, and client-side pediatrician exports. Mobile-first thumb-zone UI with dark mode and responsive laptop multi-column dashboard.
- **`e2e`**: Playwright test suite configured with `/usr/bin/chromium` covering Tiers 1–4 (opaque-box requirement-driven tests) and Tier 5 (adversarial coverage hardening).
- **`cloudrun`**: Multi-stage `Dockerfile`, `.dockerignore`, and `cloudrun/service.yaml` (`min-instances=0`) for Google Cloud Run scale-to-zero deployment.

## Code Layout

Strict write-ownership boundaries per milestone:
- Root workspace (`package.json`, `tsconfig.base.json`, `vitest.config.ts`): owned by **M1 (`shared-domain`)**
- `packages/shared/**`: owned by **M1 (`shared-domain`)**
- `apps/server/**`, `Dockerfile`, `.dockerignore`, `cloudrun/**`: owned by **M2 (`backend-sync`)**
- `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/public/**`, `apps/web/src/lib/**`, `apps/web/src/main.tsx`: owned by **M3 (`pwa-offline-store`)**
- `apps/web/src/components/**`, `apps/web/src/pages/**`, `apps/web/src/App.tsx`, `apps/web/src/index.css`: owned by **M4 (`frontend-ui-export`)**
- `e2e/**`, `TEST_INFRA.md`, `TEST_READY.md`: owned by **E2E Testing Track (`e2e_orch`)**

## Feature Inventory

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Shared Domain & Validation | Unified event/baby/member/invite types, Zod schemas, UUIDv4, UTC ISO-8601 | M1 | survey_1, survey_2 |
| F2 | Breastfeeding Tracking | Left/right side timer, segment switching (L↔R), pause/resume, manual entry, last-side indicator, total L/R/session seconds | M1, M3, M4 | survey_2, survey_3 |
| F3 | Bottle Feeding Tracking | Start & end time (timer + manual), midnight crossover, `ml` consumed (0 ml allowed, optional `oz` display), milk type, notes | M1, M3, M4 | survey_2 |
| F4 | Sleep Tracking | Start & end time (timer + manual), `nap` vs `night` categorization, location, concurrent with feeds, midnight-split daily stats | M1, M3, M4 | survey_2 |
| F5 | Diaper Tracking | 1-tap `wet`, `poopy`, `both` (+1 wet AND +1 poopy in stats), undo toast, optional stool color/amount/rash/notes | M1, M3, M4 | survey_2 |
| F6 | Spit-Up Tracking | Timestamp, optional severity (`small`/`medium`/`large`), standalone or `relatedFeedId` linked, notes | M1, M3, M4 | survey_2 |
| F7 | Daily Timeline & Stats | Local-day chronological timeline, category filters, day navigation, KPIs (time since last feed/sleep, totals, 7/14/30d trends) | M1, M4 | survey_2 |
| F8 | Pediatrician Export | Date-range selector, offline client-side CSV download, JSON backup, printable summary (`@media print`), copyable text summary | M1, M4 | survey_2 |
| F9 | Multi-Baby Management | Add/switch/edit/archive babies, baby-scoped active timers (twins safe), zero-baby onboarding | M2, M3, M4 | survey_2 |
| F10 | Multi-Parent Sharing & Auth | Register/sign-in (`scrypt` + signed `HttpOnly` cookie), offline cached user, invite code/link (`/join/<code>`), roles (`owner`/`caregiver`/`viewer`), attribution | M2, M3, M4 | survey_2, survey_3 |
| F11 | Offline-First PWA & Sync | `manifest.webmanifest`, Workbox SW, IndexedDB (`idb`) atomic outbox, idempotent `push`/`pull` with `server_seq`, LWW + `deleted_at` tombstones | M2, M3 | survey_1, survey_3 |
| F12 | Mobile-First + Laptop UI | Thumb-zone quick-log bar, sticky active-timer bar, 44px+ tap targets, dark mode, responsive laptop multi-column dashboard | M4 | survey_2 |
| F13 | Cloud Run Scale-to-Zero | Stateless server on `0.0.0.0:$PORT`, `GET /healthz`, `SIGTERM` shutdown, `StorageAdapter` (SQLite default + Postgres `DATABASE_URL`), `Dockerfile` + `cloudrun/service.yaml` | M2 | survey_1, survey_3 |
| F14 | i18n (`en-US` / `zh-CN`) & Modern Styling | Clean, modern design with distinctive accents; full American English (`en-US`) and Mainland Chinese (`zh-CN`) internationalization with easy language switcher and E2E tests | M6 | user follow-up 2026-11-15T03:02:29Z |

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | `shared-domain` | Root workspace setup, `packages/shared` (types, Zod schemas, stats/midnight-split engine, CSV/JSON/text exporters, unit tests) | none | DONE (25/25 tests, Auditor CLEAN) |
| M2 | `backend-sync` | `apps/server` (Fastify, `StorageAdapter` SQLite+Postgres, auth, babies/invites, `/api/sync/push` & `pull`, static serving, `/healthz`, `SIGTERM`, integration tests) + `Dockerfile` + `cloudrun/service.yaml` | M1 | DONE (10/10 server tests, 46/46 total, Auditor CLEAN) |
| M3 | `pwa-offline-store` | `apps/web` PWA shell (`vite-plugin-pwa`, manifest, icons), IndexedDB (`idb`) store, atomic outbox, sync engine, offline auth cache, timestamp timer helpers, unit tests | M1 | DONE (41/41 tests, Auditor CLEAN) |
| M4 | `frontend-ui-export` | `apps/web` UI (mobile + laptop responsive dashboard, dark mode, breast/bottle/sleep timers, 1-tap diaper/spit-up, daily timeline/stats/trends, pediatrician export, multi-baby & sharing UI) | M1, M3 | DONE (54/54 tests, Auditor CLEAN) |
| M5 | `final-e2e-hardening` | Phase 1: Pass 100% E2E tests (Tiers 1–4 after `TEST_READY.md`); Phase 2: Tier 5 adversarial coverage hardening | M2, M3, M4, E2E Track | DONE (153/153 E2E, 63/63 unit, Auditor CLEAN) |
| M6 | `i18n-and-styling` | Clean modern styling polish with distinctive accents + full `en-US` & `zh-CN` i18n + language switcher + i18n E2E tests + final full-suite verification | M5 | DONE (156/156 E2E, 73/73 unit, Auditor CLEAN) |
| E2E | `e2e-testing-track` | Independent opaque-box Playwright test suite (Tiers 1–4) + `TEST_INFRA.md` + `TEST_READY.md` | none (runs in parallel) | DONE (148 tests, Auditor CLEAN) |

## Interface Contracts

### 1. Unified Event & Entity Model (`packages/shared`)
All synced entities carry:
- `id`: UUIDv4 string (client-generated)
- `createdAt`: UTC ISO-8601 string
- `updatedAt`: UTC ISO-8601 string (used for LWW; server clamps to `min(clientUpdatedAt, serverNow + 60_000ms)`)
- `deletedAt`: UTC ISO-8601 string | `null` (tombstone for soft deletes)
- `serverSeq`: integer (assigned monotonically by server on accepted push; `0` locally until synced)

**`Baby`**: `{ id, name, dob ('YYYY-MM-DD'), birthWeightGrams?, avatarColor, notes?, isArchived: boolean, createdByUserId, createdAt, updatedAt, deletedAt? }`
**`BabyMember`**: `{ id, babyId, userId, displayName?, role: 'owner'|'caregiver'|'viewer', joinedAt, updatedAt, deletedAt? }`
**`TrackingEvent`** (discriminated union by `type`, stored in `events` table/store):
- Common fields: `id, babyId, type, startedAt (ISO-8601), endedAt (ISO-8601 | null), notes?, loggedByUserId, loggedByName?, updatedByUserId, createdAt, updatedAt, deletedAt?, serverSeq?`
- `type: 'breast_feed'`: `payload: { segments: Array<{ side: 'left'|'right', startedAt: string, endedAt: string | null }>, pausedAt: string | null, totalLeftSeconds: number, totalRightSeconds: number }`
- `type: 'bottle_feed'`: `payload: { volumeMl: number | null, milkType?: 'breastmilk'|'formula'|'mixed'|'fortified'|'other' }`
- `type: 'sleep'`: `payload: { category: 'nap'|'night', location?: 'crib'|'bassinet'|'contact'|'stroller'|'car_seat'|'other' }`
- `type: 'diaper'`: `payload: { kind: 'wet'|'poopy'|'both', amount?: 'small'|'medium'|'large', stoolColor?: string, stoolConsistency?: string, hasRash?: boolean }`
- `type: 'spit_up'`: `payload: { severity?: 'small'|'medium'|'large', relatedFeedId?: string | null, relatedFeedType?: 'breast_feed'|'bottle_feed' | null }`

### 2. HTTP API Contract (`apps/server`)
- `GET /healthz` → `200 { status: 'ok', storage: 'sqlite'|'postgres' }`
- `POST /api/auth/register` `{ email, password, displayName }` → `201 { user }` + `Set-Cookie` (HttpOnly, SameSite=Lax)
- `POST /api/auth/login` `{ email, password }` → `200 { user }` + `Set-Cookie`
- `POST /api/auth/logout` → `200 { ok: true }` (clears cookie)
- `GET /api/auth/me` → `200 { user }` or `401`
- `POST /api/babies/:babyId/invites` `{ role?: 'caregiver'|'viewer', expiresInHours?: number }` → `201 { invite: { id, babyId, code, role, expiresAt } }`
- `POST /api/invites/accept` `{ code }` → `200 { baby, member }` (inserts/activates `BabyMember` and assigns `serverSeq` so next pull backfills baby + events)
- `GET /api/babies/:babyId/members` → `200 { members }`
- `DELETE /api/babies/:babyId/members/:userId` → `200 { ok: true }` (owner revokes member or member leaves)
- `POST /api/sync/push` `{ mutations: Array<{ mutationId, entityType: 'baby'|'event', op: 'upsert'|'delete', data, clientUpdatedAt }> }` → `200 { ackedMutationIds: string[], rejected: Array<{ mutationId, reason }>, latestSeq: number }`
- `GET /api/sync/pull?since_seq=<number>` → `200 { babies: Baby[], members: BabyMember[], events: TrackingEvent[], latestSeq: number }`
