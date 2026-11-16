# Project: SnackTracker — Daily Baby Vitamin Tracking

## Architecture
- **Monorepo** (`"type": "module"`, npm workspaces):
  - `packages/shared` (`@baby-tracker/shared`): Zod schemas (`schemas.ts`), DST-safe local-day stats (`stats.ts`), CSV/JSON/pediatrician export (`export.ts`).
  - `apps/server`: Fastify API + SQLite/Postgres/Firestore adapters (`sqlite.ts`, `postgres.ts`, `firestore.ts`), sync routes (`/api/sync/push`, `/api/sync/pull`). Validates mutations via `TrackingEventSchema` and stores `type` + `payload_json` generically (zero DB migration needed for new `TrackingEvent` types).
  - `apps/web`: React 19 + Tailwind CSS v4 + `lucide-react` PWA, IndexedDB (`idb`) + atomic outbox (`store.ts`), `en-US`/`zh-CN` i18n (`i18n.tsx`), `DashboardView`, `TimelineView`, `TrendsView`, `ExportPage`.
  - `e2e`: Playwright (`@playwright/test`) E2E suite in `e2e/tests/`.

## Code Layout
- `packages/shared/src/schemas.ts`, `stats.ts`, `export.ts` (+ `src/__tests__/*.test.ts`)
- `apps/server/src/db/{sqlite,postgres,firestore}.ts`, `routes/sync.ts` (+ `src/__tests__/server.test.ts`)
- `apps/web/src/index.css`, `App.tsx`, `components/{DashboardView,TimelineView,TrendsView,uiUtils}.ts*`, `lib/{store,i18n,db,sync}.ts*`
- `e2e/tests/*.spec.ts`, `e2e/helpers/app.ts`

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Vitamin event schema | Add `'vitamin'` point-in-time `TrackingEvent` (`endedAt = startedAt`, `payload: {}`) in `schemas.ts` | M1 | survey |
| 2 | Daily stats & export | Add `vitaminCount`, `vitaminGiven`, `vitaminDaysCount` in `stats.ts`; handle `'vitamin'` in `export.ts` | M1 | survey |
| 3 | Offline store & local-day toggle | Add `logVitamin` & `toggleVitaminForLocalDay` (Yes if `vitaminCount > 0`; No soft-deletes all same-day active vitamin events) in `store.ts` | M1 | survey |
| 4 | Visual theme & Dashboard card | Emerald accent (`--accent-vitamin`, `.bt-card-vitamin`, `.bt-badge-vitamin`) in `index.css`; 6th quick-action Daily Vitamins card with 1-tap Yes/No in `DashboardView.tsx` (remove `xl:col-span-2` from Diaper card for 3×2 / 2×3 grid balance) | M1 | survey |
| 5 | Timeline & i18n parity | Handle `'vitamin'` in `TimelineView.tsx` (`renderSummary` + filter pill) and add `en-US`/`zh-CN` keys in `i18n.tsx` | M1 | survey |
| 6 | Unit, integration & E2E tests | Add tests in `schemas.test.ts`, `stats.test.ts`, `export.test.ts`, `store.test.ts`, `server.test.ts`, and `e2e/tests/` | M1 | survey |

## Interface Contracts
### `TrackingEvent` (`packages/shared/src/schemas.ts`)
- `VitaminPayloadSchema = z.object({})`
- `VitaminEventSchema = z.object({ ...baseEventFields, type: z.literal('vitamin'), payload: VitaminPayloadSchema })`
- `TrackingEventTypeSchema` includes `'vitamin'`; `TrackingEventSchema` includes `VitaminEventSchema`.

### `DailyStats` & `PeriodMetrics` (`packages/shared/src/stats.ts`)
- `DailyStats`: `vitaminCount: number`, `vitaminGiven: boolean` (`vitaminCount > 0`).
- `PeriodMetrics`: `vitaminDaysCount: number`.

### Store (`apps/web/src/lib/store.ts`)
- `logVitamin(...)`: creates point-in-time `vitamin` event (`endedAt: startedAt`, `payload: {}`) atomically in IDB + outbox.
- `toggleVitaminForLocalDay({ babyId, dateKey, timeZone, given, userId, userName? })`: if `given === true` and no active `vitamin` event exists on `dateKey`, creates one (using `nowIso()` for today or DST-safe local noon for historical `dateKey`); if `given === false`, soft-deletes all active `vitamin` events on `dateKey` via `deleteEvent`.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Daily Vitamin Tracking | Features 1–6 (single Explorer → Worker → Verification Wave cycle) | none | DONE (Iteration 1 PASS: 78/78 unit, 157/157 E2E, CLEAN audit) |
