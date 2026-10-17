-- Daily Replay Trade Drafts v1 (branch feature/dr-trade-capture)
-- *** PREPARED ONLY — NOT APPLIED ***
-- This file has NOT been run against any database except the local
-- PGlite SQL harness. Applying it waits for Karandeep's explicit
-- authorization (paste into the Supabase SQL editor, per DEPLOY.md).
-- It is additive only: ONE new table (daily_replay_trade_drafts)
-- with its indexes and owner RLS policies. No existing table,
-- function, policy or row is touched; no existing rows are
-- rewritten, backfilled, or relabelled. Pre-feature attempts simply
-- have no draft rows, and every read path treats "no draft row" as
-- legacy behavior (the trade is visible exactly as today).
--
-- Design notes:
--   * A draft is the durable per-cycle record written when a Daily
--     Replay position cycle closes, BEFORE the attempt completes:
--     identity + lifecycle status + reconciliation anchors only.
--     Fills, timeline, plan evidence and R keep being derived by the
--     shipped modules from the attempt's events / the session's
--     fills — this table stores no second copy of them.
--   * Draft identity is attempt-scoped (the journal session does not
--     exist yet at cycle close): draft_key is
--     dr:{attempt_id}:g{reset_generation}:c{cycle_index}, with
--     cycle_index the 1-based close order WITHIN its reset
--     generation. reset_generation is the count of session_reset
--     events before the cycle: a reset wipes the engine's fills, so
--     only final-generation drafts can ever map to journal trades;
--     earlier-generation drafts become 'superseded', never finalized.
--   * Finalization is a flag on this row only — it never writes
--     journal rows. Journal materialization stays inside
--     dr_complete_attempt at attempt completion (untouched), and the
--     journal read path excludes cycles whose draft is still
--     'draft'. The reconciler records the finalized link in
--     finalized_session_id / finalized_trade_key once known.
--   * Writer idempotency: unique (attempt_id, reset_generation,
--     cycle_index) is the upsert key; unique (user_id, draft_key)
--     keeps the attempt-scoped key itself collision-free.
--   * NO delete policy: drafts are records; lifecycle is status,
--     not deletion — the same append-only stance as
--     daily_replay_events and strategy_versions.
-- Rollback (pre-launch): drop table public.daily_replay_trade_drafts;
-- nothing else references it.

-- ============ DAILY REPLAY TRADE DRAFTS ============
create table if not exists public.daily_replay_trade_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt_id uuid not null
    references public.daily_replay_attempts(id) on delete cascade,
  -- Count of session_reset events preceding this cycle (>= 0).
  reset_generation int not null check (reset_generation >= 0),
  -- 1-based close order within the generation.
  cycle_index int not null check (cycle_index >= 1),
  -- dr:{attempt_id}:g{reset_generation}:c{cycle_index}
  draft_key text not null,
  status text not null default 'draft'
    check (status in ('draft', 'finalized', 'superseded')),
  -- Reconciliation anchors (match the evidence module's verifyPair
  -- inputs): the cycle's first entry fill and final exit fill.
  first_fill_candle_index int not null,
  first_fill_price numeric not null,
  first_fill_qty numeric not null,
  close_fill_candle_index int not null,
  -- Cycle realized P&L: position_closed realizedPnl plus any prior
  -- partial_exit realizedPnl, as recorded in the event stream.
  realized_pnl numeric not null,
  -- The cycle's slice of the Decision Timeline: first entry fill
  -- event seq -> position_closed event seq.
  event_first_seq int not null,
  event_last_seq int not null,
  -- Entry/exit auto-screenshot outcomes:
  -- {entry: {path, candle_index, status}, exit: {...}},
  -- status in captured|failed|skipped. Failures are recorded,
  -- never hidden.
  auto_capture jsonb not null default '{}'::jsonb,
  -- Filled by the completion-time reconciler when known.
  finalized_session_id uuid
    references public.replay_sessions(id) on delete set null,
  finalized_trade_key text,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (attempt_id, reset_generation, cycle_index),
  unique (user_id, draft_key)
);
create index if not exists daily_replay_trade_drafts_user_status_idx
  on public.daily_replay_trade_drafts (user_id, status, created_at desc);
create index if not exists daily_replay_trade_drafts_attempt_idx
  on public.daily_replay_trade_drafts (attempt_id);

alter table public.daily_replay_trade_drafts enable row level security;

drop policy if exists dr_trade_drafts_select_own on public.daily_replay_trade_drafts;
create policy dr_trade_drafts_select_own on public.daily_replay_trade_drafts
  for select to authenticated
  using (auth.uid() = user_id);

-- Insert additionally requires the attempt to be the caller's own —
-- the same exists-check shape as the events insert policy
-- (daily-replay-v1.sql), so a draft can never be attached to another
-- user's attempt even with a forged attempt_id.
drop policy if exists dr_trade_drafts_insert_own on public.daily_replay_trade_drafts;
create policy dr_trade_drafts_insert_own on public.daily_replay_trade_drafts
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.daily_replay_attempts a
      where a.id = attempt_id and a.user_id = auth.uid()
    )
  );

drop policy if exists dr_trade_drafts_update_own on public.daily_replay_trade_drafts;
create policy dr_trade_drafts_update_own on public.daily_replay_trade_drafts
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
-- NO delete policy: with RLS enabled, deletes are denied for
-- everyone — a draft's lifecycle is its status, never deletion.
