# Project: SnackTracker — Pumping & Tummy Time Tracking

## Architecture
- **Monorepo** (`"type": "module"`, npm workspaces):
  - `packages/shared` (`@baby-tracker/shared`): Zod schemas (`schemas.ts`), DST-safe local-day stats (`stats.ts`), CSV/JSON/pediatrician export (`export.ts`).
  - `apps/server`: Fastify API + SQLite/Postgres/Firestore adapters (`sqlite.ts`, `postgres.ts`, `firestore.ts`), sync routes (`/api/sync/push`, `/api/sync/pull`). Validates mutations via `TrackingEventSchema` and stores `type` + `payload_json` generically (zero DB migrations required).
  - `apps/web`: React 19 + Tailwind CSS v4 + `lucide-react` PWA, IndexedDB (`idb`) + atomic outbox (`store.ts`), `en-US`/`zh-CN` i18n (`i18n.tsx`), `DashboardView`, `TimelineView`, `TrendsView`, `ExportPage`.
  - `e2e`: Playwright (`@playwright/test`) E2E suite in `e2e/tests/`.

## Code Layout
- `packages/shared/src/{schemas,stats,export}.ts` (+ `src/__tests__/*.test.ts`)
- `apps/server/src/db/{sqlite,postgres,firestore}.ts`, `routes/sync.ts` (+ `src/__tests__/server.test.ts`)
- `apps/web/src/index.css`, `App.tsx`, `pages/ExportPage.tsx`, `components/{ActiveTimersBanner,DashboardView,DailySummaryCards,TimelineView,TrendsView,TrackingModals,uiUtils}.ts*`, `lib/{store,i18n,db,sync}.ts*` (+ `*.test.ts`)
- `e2e/tests/*.spec.ts`, `e2e/helpers/app.ts`

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | `pumping` & `tummy_time` Zod schemas | Add `PumpingSideSchema`, `PumpingPayloadSchema`, `PumpingEventSchema`, `TummyTimeMoodSchema`, `TummyTimePayloadSchema`, `TummyTimeEventSchema`; extend `TrackingEventTypeSchema` and `TrackingEventSchema`. | M1 | survey |
| 2 | Daily stats, period averages & last-activity summary | Extend `DailyStats`, `computeDailyStats` (DST-safe midnight duration splitting & ongoing timer clamping; `totalFeedCount` unaffected by pumping), `PeriodMetrics`, `computePeriodAverages`, `LastActivitySummary`, and `computeLastActivitySummary` (including early-exit `break`). | M1 | survey |
| 3 | CSV, JSON & pediatrician summary export | Insert `pumpingSide`, `pumpingLeftMl`, `pumpingRightMl`, `tummyTimeMood` in `EVENTS_CSV_HEADERS` after `relatedFeedId` and before trailing `notes`/`loggedBy` (preserving columns 0–18); extend `exportDailyStatsToCsv` and `generatePediatricianSummary` (`text` & `markdown`). | M1 | survey |
| 4 | Offline-first store & asymmetric auto-end sleep | Extend `ActiveTimersForBaby` & `getActiveTimersForBaby`; add `'tummy_time'` to `AUTO_END_SLEEP_TYPES` (NOT `'pumping'`); add `startPumping`, `finishPumping`, `logPumping`, `startTummyTime`, `finishTummyTime`, `logTummyTime`. | M1 | survey |
| 5 | Design system tokens & bilingual i18n | Add light/dark `--accent-pumping*` (purple) & `--accent-tummy*` (orange), `.bt-card-*`, `.bt-badge-*` in `index.css`; add 100% matching `enUS` & `zhCN` keys/placeholders (plain `'`/`"` strings) in `i18n.tsx`. | M1 | survey |
| 6 | Dashboard cards, live timers & sticky banner | Add Pumping (`GlassWater`) & Tummy Time (`Activity`) cards after Vitamins (cards #7 & #8, preserving Breast/Sleep `Manual` button indices); wire `ActiveTimersBanner`, 1s tick (`hasActiveTimer`), and `PumpingModal`/`TummyTimeModal` (create, finish, edit). | M1 | survey |
| 7 | Summary cards, Timeline, Trends & Export UI | Integrate Pumping & Tummy Time into `DailySummaryCards` (6-card `lg:grid-cols-3` Dashboard summary), `TimelineView` (filter pills, rows, edit/delete), `TrendsView` + `uiUtils.ts` (averages + charts), and `ExportPage` (preview + print). | M1 | survey |
| 8 | Unit, Server & Playwright E2E tests | Add comprehensive unit tests (`schemas`, `stats`, `export`, `store`, `uiUtils`, `i18n`), server sync/RBAC tests (`server.test.ts`), and E2E spec (`e2e/tests/pumping-and-tummy-time.spec.ts`), keeping all existing tests green. | M1 | survey |

## Interface Contracts
### `packages/shared/src/schemas.ts`
- `PumpingSideSchema = z.enum(['left', 'right', 'both'])`
- `PumpingPayloadSchema = z.object({ side: PumpingSideSchema.optional(), volumeMl: z.number().nonnegative().max(2000).nullable(), leftVolumeMl: z.number().nonnegative().max(2000).nullable().optional(), rightVolumeMl: z.number().nonnegative().max(2000).nullable().optional() })`
- `TummyTimeMoodSchema = z.enum(['happy', 'neutral', 'fussy'])`
- `TummyTimePayloadSchema = z.object({ mood: TummyTimeMoodSchema.optional() })`
- `TrackingEventSchema`: discriminated union including `PumpingEventSchema` (`type: 'pumping'`) and `TummyTimeEventSchema` (`type: 'tummy_time'`); inherits `endedAt >= startedAt` cross-field check.

### `apps/web/src/lib/store.ts`
- `AUTO_END_SLEEP_TYPES = new Set<TrackingEvent['type']>(['breast_feed', 'bottle_feed', 'diaper', 'tummy_time'])` (`'pumping'` explicitly excluded).
- `ActiveTimersForBaby`: `{ breastFeed, bottleFeed, sleep, pumping, tummyTime }`.
- Helpers: `startPumping`, `finishPumping`, `logPumping`, `startTummyTime`, `finishTummyTime`, `logTummyTime`.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Pumping & Tummy Time Tracking | Features 1–8 (Domain, Store, UI, i18n, Unit/Server/E2E tests) | none | DONE (Iteration 2 PASS: 88/88 unit, 163/163 E2E, CLEAN audit) |
