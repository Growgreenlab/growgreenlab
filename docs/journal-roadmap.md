# Trade Journal — Real-Market Implementation Plan

**Date:** 2026-10-11 | **Branch:** redesign-preview | **Status:** Planning (no code changes)

## What Already Exists (do not rebuild)

| Feature | Status | Location |
|---|---|---|
| Manual real-trade entry (+ Add Real Trade) | ✅ Live | `app/journal/page.tsx` → writes `journal_real_trades` + `journal_real_fills` |
| FIFO fill accounting (long/short) | ✅ Live | `lib/journal.ts` → `calcRealTrade` |
| Multiple entries & partial exits | ✅ Live | Fill-based model |
| Per-fill fees, net P&L | ✅ Live | `fees` column on fills |
| Broker CSV import (Webull auto-detect + any-broker mapping) | ✅ Live | Import form in journal page |
| Duplicate prevention (`import_hash`) | ✅ Live | Unique partial index |
| Source filters (All / Simulator / Real Market) | ✅ Live | Journal UI tabs |
| Per-source analytics | ✅ Live | `calcMetrics` with source filter |
| Trade DNA annotations | ✅ Live | `journal_trade_meta` (shared) |
| R-multiple, risk/reward, HOD classification | ✅ Live | `calcRealTrade` |

## Gaps Identified (audit 2026-10-11)

### 1. `status` column is dead (Low)
Both manual entry and import leave `status` defaulting to `'open'`.
The UI derives closure from `calc.isClosed`, never reads `rt.status`.
**Plan:** Update `status` on trade close in `doImport` and the manual save path,
or drop the column in a future migration. No schema change tonight.

### 2. N+1 query on journal load (Medium)
Up to ~700 sequential fill queries per page load (200 sessions + 500 real trades).
**Plan:** Batch with `.in("session_id", ids)` / `.in("trade_id", ids)` or use
nested selects. Requires careful testing — deferred, not tonight's scope.

### 3. `journal_manual_trades` is orphaned (Info)
Table exists in schema but is unreferenced; the manual form writes to
`journal_real_trades`/`journal_real_fills`.
**Plan:** Drop in a future migration after confirming no backfill needed.
Do NOT create a second trade-recording system — the fills model is canonical.

### 4. R-multiple understated on partial exits (Low)
`initialRisk` uses total entry qty while `netRealized` covers only closed portion.
**Plan:** Pro-rate initial risk to the closed quantity when computing R for
partial exits. Small `lib/journal.ts` change, needs unit tests.

### 5. RLS fill policy doesn't verify trade ownership (Low)
`journal_real_fills` policy checks `auth.uid() = user_id` but not that
`trade_id` belongs to the same user. Impact is data pollution, not leakage.
**Plan:** Add `EXISTS (SELECT 1 FROM journal_real_trades rt WHERE rt.id = trade_id
AND rt.user_id = auth.uid())` to the policy. Schema change — needs explicit
approval, not tonight.

## Non-Goals
- No second trade-recording system. The `journal_real_trades` + `journal_real_fills`
  model handles manual entry, broker import, partials, and fees uniformly.
- No schema changes tonight (per audit constraints).
