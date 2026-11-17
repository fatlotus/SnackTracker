# Project: SnackTracker — Auto-End Active Sleep on New State

## Architecture
- **Monorepo** (`"type": "module"`, npm workspaces):
  - `packages/shared` (`@baby-tracker/shared`): Zod schemas (`schemas.ts`), DST-safe local-day stats (`stats.ts`), CSV/JSON/pediatrician export (`export.ts`).
  - `apps/server`: Fastify API + SQLite/Postgres/Firestore adapters (`sqlite.ts`, `postgres.ts`, `firestore.ts`), sync routes (`/api/sync/push`, `/api/sync/pull`). Validates mutations via `TrackingEventSchema` and stores `type` + `payload_json` generically.
  - `apps/web`: React 19 + Tailwind CSS v4 + `lucide-react` PWA, IndexedDB (`idb`) + atomic outbox (`store.ts`), `en-US`/`zh-CN` i18n (`i18n.tsx`), `DashboardView`, `TimelineView`, `TrendsView`, `ExportPage`.
  - `e2e`: Playwright (`@playwright/test`) E2E suite in `e2e/tests/`.

## Code Layout
- `packages/shared/src/schemas.ts`, `stats.ts`, `export.ts` (+ `src/__tests__/*.test.ts`)
- `apps/server/src/db/{sqlite,postgres,firestore}.ts`, `routes/sync.ts` (+ `src/__tests__/server.test.ts`)
- `apps/web/src/index.css`, `App.tsx`, `components/{DashboardView,TimelineView,TrendsView,TrackingModals,ActiveTimersBanner,uiUtils}.ts*`, `lib/{store,i18n,db,sync}.ts*`
- `e2e/tests/*.spec.ts`, `e2e/helpers/app.ts`

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Auto-end active sleep on new feed or diaper | In `apps/web/src/lib/store.ts` (`putEventAtomic`), when upserting a new `breast_feed`, `bottle_feed`, or `diaper` event, atomically close any non-deleted `sleep` event for the same `babyId` with `endedAt === null` and `Date.parse(sleep.startedAt) <= Date.parse(event.startedAt)` by setting `endedAt = event.startedAt` and queueing an `outbox` upsert in the same IDB transaction. | M1 | survey |
| 2 | Preserve active sleep on spit-up, edits/deletes, backdated events, & other babies | Do NOT auto-end active sleep on `spit_up`, `vitamin` toggle, `sleep`, `updateEvent`, `deleteEvent`, events with `startedAt < sleep.startedAt`, or events for a different `babyId`. | M1 | survey |
| 3 | Update UI comment | Update `{/* Sleep Card (Concurrent with Feeds!) */}` in `apps/web/src/components/DashboardView.tsx:474`. | M1 | survey |
| 4 | Unit tests in `store.test.ts` | Add unit tests covering `startBreastFeed`, `createEvent` (manual `breast_feed`), `startBottleFeed`, `logBottleFeed`, `logDiaper`, `logSpitUp` (keeps sleep active), backdated events (keeps sleep active), and twin isolation. | M1 | survey |
| 5 | E2E tests update & new coverage | Update `e2e/tests/tier1-domain-and-tracking.spec.ts:810`, `e2e/tests/tier2-boundaries-tracking.spec.ts:582`, and `e2e/tests/tier3-combinations.spec.ts:417` to expect active sleep to end on feed/diaper; add E2E assertions that `spit_up` keeps active sleep running. | M1 | survey |

## Interface Contracts
### `putEventAtomic` (`apps/web/src/lib/store.ts`)
- `AUTO_END_SLEEP_TYPES = new Set<TrackingEvent['type']>(['breast_feed', 'bottle_feed', 'diaper'])`
- When `op === 'upsert'` and `AUTO_END_SLEEP_TYPES.has(event.type)`:
  - Within the same `['events', 'outbox']` `readwrite` transaction, query `by-babyId` for `event.babyId`.
  - For every non-deleted `sleep` event with `endedAt === null` and `Date.parse(sleep.startedAt) <= Date.parse(event.startedAt)`:
    - Parse updated sleep via `TrackingEventSchema.parse({ ...sleep, endedAt: event.startedAt, updatedAt: event.updatedAt, updatedByUserId: event.updatedByUserId })`.
    - Write updated sleep to `events` and `makeOutboxItem('event', endedSleep.id, 'upsert', ...)` to `outbox`.
- `notifyStoreChange()` fires once after `tx.done`.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Auto-End Active Sleep on New State | Features 1–5 (single Explorer → Worker → Verification Wave cycle) | none | DONE (Iteration 1 PASS: 81/81 unit, 158/158 E2E, CLEAN audit) |
