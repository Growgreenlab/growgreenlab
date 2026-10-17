-- Daily Replay Strategies v1 (branch feature/dr-strategy-export)
-- *** PREPARED ONLY — NOT APPLIED ***
-- This file has NOT been run against any database. Applying it waits
-- for Karandeep's explicit authorization (paste into the Supabase SQL
-- editor, per DEPLOY.md). It is additive:
--   * two new tables (strategies, strategy_versions),
--   * one nullable column + two indexes on daily_replay_attempts,
--   * the replay_sessions.source CHECK widened with 'daily_replay'
--     (no existing row is changed — widening only permits a new value),
--   * dr_create_attempt recreated with an optional strategy parameter
--     (existing two-argument calls keep working: the new parameter has
--     a default),
--   * two new security-definer functions: dr_allocate_strategy_version
--     and dr_complete_attempt.
-- No existing table, policy or row is otherwise touched, and
-- dr_finish_attempt is KEPT (see the note at dr_complete_attempt): the
-- completion path moves to the new transactional RPC, but the old
-- function stays available so an older deployed client can never be
-- stranded mid-flight.
--
-- Design notes:
--   * A strategy is identity only (name / notes / archive flag). All
--     rules live on strategy_versions, which are IMMUTABLE at the
--     database level: the table has owner SELECT + INSERT policies and
--     deliberately NO update/delete policies, so a version, once
--     created, cannot be rewritten by anyone through the API.
--   * "Editing" a strategy's rules means allocating the next version
--     (dr_allocate_strategy_version) — atomically, under the strategy
--     row lock, so concurrent allocations can never collide on the
--     unique (strategy_id, version) constraint.
--   * Attempts are BORN with their strategy version (set inside
--     dr_create_attempt, validated against the caller's ownership), so
--     a finished attempt's strategy is never ambiguous. The column is
--     nullable: every pre-feature attempt, and every attempt locked
--     without choosing a strategy, keeps NULL = "no strategy
--     recorded". Nothing is backfilled, ever.
--   * Completion is transactional and idempotent
--     (dr_complete_attempt): the attempt row is locked FOR UPDATE;
--     a retry or a concurrent second call sees status = 'finished'
--     and returns the EXISTING session id without inserting anything.
--     One attempt can therefore never produce two journal sessions.

-- ============ STRATEGIES (identity only) ============
create table if not exists public.strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  notes text,
  -- Archive, never hard-delete: archived strategies keep resolving on
  -- every historical attempt that references one of their versions.
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists strategies_user_idx
  on public.strategies (user_id, created_at desc);

alter table public.strategies enable row level security;

-- Journal-style owner policy: a user manages only their own strategies.
drop policy if exists strategies_owner_all on public.strategies;
create policy strategies_owner_all on public.strategies
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============ STRATEGY VERSIONS (immutable definitions) ============
create table if not exists public.strategy_versions (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null
    references public.strategies(id) on delete cascade,
  -- Denormalized owner (mirrors session_trades.user_id) so ownership
  -- checks inside definer functions and RLS stay one-column simple.
  user_id uuid not null references auth.users(id) on delete cascade,
  version int not null check (version > 0),
  setup_type text not null
    check (setup_type in ('hod_breakout', 'ema_pullback', 'vwap_pullback', 'custom')),
  entry_rules text,
  stop_rules text,
  target_rules text,
  exit_rules text,
  -- Optional market-condition filters, structured (may be '{}').
  market_filters jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  unique (strategy_id, version)
);
create index if not exists strategy_versions_user_idx
  on public.strategy_versions (user_id, strategy_id, version);

alter table public.strategy_versions enable row level security;

drop policy if exists strategy_versions_select_own on public.strategy_versions;
create policy strategy_versions_select_own on public.strategy_versions
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists strategy_versions_insert_own on public.strategy_versions;
create policy strategy_versions_insert_own on public.strategy_versions
  for insert to authenticated
  with check (auth.uid() = user_id);
-- NO update/delete policies: with RLS enabled, updates and deletes are
-- denied for everyone — a version is immutable at the database level,
-- the same append-only stance as daily_replay_events.

-- ============ ATTEMPT → STRATEGY VERSION LINK ============
alter table public.daily_replay_attempts
  add column if not exists strategy_version_id uuid
    references public.strategy_versions(id) on delete set null;

create index if not exists daily_replay_attempts_session_idx
  on public.daily_replay_attempts (session_id);
create index if not exists daily_replay_attempts_strategy_idx
  on public.daily_replay_attempts (strategy_version_id);

-- ============ SESSION SOURCE: 'daily_replay' ============
-- Daily Replay completions save their journal session with the
-- explicit source 'daily_replay' from now on (they previously saved
-- as 'twelvedata', indistinguishable from Trade Lab sessions).
-- Widening the CHECK only ADDS a permitted value: every existing row
-- keeps exactly the source it already has — nothing is relabeled.
alter table public.replay_sessions
  drop constraint if exists replay_sessions_source_check;
alter table public.replay_sessions
  add constraint replay_sessions_source_check
  check (source in ('sample', 'twelvedata', 'csv', 'daily_replay'));

-- ============ CREATE ATTEMPT (extended: optional strategy) ============
-- The old (uuid, int) signature is dropped and recreated with a
-- defaulted third parameter, so existing callers — including the
-- currently deployed client, which calls with named arguments
-- p_dataset_id / p_start_index — keep working unchanged.
drop function if exists public.dr_create_attempt(uuid, int);
create or replace function public.dr_create_attempt(
  p_dataset_id uuid,
  p_start_index int,
  p_strategy_version_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_count int;
  v_candles jsonb;
  v_attempt_id uuid;
  v_prefix jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select user_id, candle_count into v_owner, v_count
  from public.daily_replay_datasets
  where id = p_dataset_id;
  if not found then
    raise exception 'dataset not found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'permission denied: not your dataset';
  end if;
  -- The strategy version, when one is bound, must be the caller's own.
  if p_strategy_version_id is not null then
    if not exists (
      select 1 from public.strategy_versions sv
      where sv.id = p_strategy_version_id and sv.user_id = auth.uid()
    ) then
      raise exception 'permission denied: not your strategy version';
    end if;
  end if;
  select candles into v_candles
  from public.daily_replay_dataset_candles
  where dataset_id = p_dataset_id;
  if v_candles is null then
    raise exception 'dataset candles not uploaded';
  end if;
  if jsonb_array_length(v_candles) <> v_count then
    raise exception 'stored candle count does not match the dataset registry';
  end if;
  if p_start_index < 0 or p_start_index > v_count - 1 then
    raise exception 'start_index % out of range [0, %]', p_start_index, v_count - 1;
  end if;

  insert into public.daily_replay_attempts
    (user_id, dataset_id, start_index, position, strategy_version_id)
  values
    (auth.uid(), p_dataset_id, p_start_index, p_start_index,
     p_strategy_version_id)
  returning id into v_attempt_id;

  select coalesce(jsonb_agg(e.elem order by e.idx), '[]'::jsonb)
  into v_prefix
  from (
    select elem, (ord - 1) as idx
    from jsonb_array_elements(v_candles) with ordinality as t(elem, ord)
  ) e
  where e.idx <= p_start_index;

  return jsonb_build_object(
    'attempt_id', v_attempt_id,
    'position', p_start_index,
    'candles', v_prefix
  );
end;
$$;

-- ============ ALLOCATE STRATEGY VERSION (atomic) ============
-- Creates the next version of a strategy the caller owns and returns
-- the inserted row. The strategy row is locked FOR UPDATE first, so
-- two concurrent allocations serialize and can never compute the same
-- next version number (the unique constraint is the backstop).
create or replace function public.dr_allocate_strategy_version(
  p_strategy_id uuid,
  p_setup_type text,
  p_entry_rules text default null,
  p_stop_rules text default null,
  p_target_rules text default null,
  p_exit_rules text default null,
  p_market_filters jsonb default '{}'::jsonb,
  p_notes text default null
)
returns public.strategy_versions
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_next int;
  v_row public.strategy_versions;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select user_id into v_owner
  from public.strategies
  where id = p_strategy_id
  for update;
  if not found then
    raise exception 'strategy not found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'permission denied: not your strategy';
  end if;
  if p_setup_type not in ('hod_breakout', 'ema_pullback', 'vwap_pullback', 'custom') then
    raise exception 'invalid setup_type: %', p_setup_type;
  end if;

  select coalesce(max(version), 0) + 1 into v_next
  from public.strategy_versions
  where strategy_id = p_strategy_id;

  insert into public.strategy_versions
    (strategy_id, user_id, version, setup_type, entry_rules, stop_rules,
     target_rules, exit_rules, market_filters, notes)
  values
    (p_strategy_id, auth.uid(), v_next, p_setup_type, p_entry_rules,
     p_stop_rules, p_target_rules, p_exit_rules,
     coalesce(p_market_filters, '{}'::jsonb), p_notes)
  returning * into v_row;
  return v_row;
end;
$$;

-- ============ COMPLETE ATTEMPT (transactional, idempotent) ============
-- Replaces the client's three-step completion (insert session →
-- insert fills → dr_finish_attempt) with ONE atomic operation:
--
--   1. The attempt row is selected FOR UPDATE — a concurrent second
--      completion blocks here until the first transaction commits.
--   2. If the attempt is already finished, its EXISTING session id is
--      returned and nothing is inserted: retries are safe by
--      construction, at the database level.
--   3. Otherwise the journal session (source 'daily_replay', ticker /
--      date read from the attempt's own dataset — never trusted from
--      the payload), its fills, and the attempt's finished mark are
--      written in the same transaction. Any failure rolls everything
--      back: no orphan session, no partial fills, attempt stays
--      active and completable.
--
-- dr_finish_attempt is intentionally KEPT in the database (it shipped
-- in daily-replay-v1 and is live): older deployed clients may still
-- call it. New clients complete exclusively through this function.
create or replace function public.dr_complete_attempt(
  p_attempt_id uuid,
  p_candles jsonb,
  p_start_index int default null,
  p_final_cash numeric default null,
  p_realized_pnl numeric default null,
  p_fills jsonb default '[]'::jsonb
)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt public.daily_replay_attempts;
  v_ticker text;
  v_trade_date date;
  v_session_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  -- Lock the attempt row: concurrent completions serialize here.
  select * into v_attempt
  from public.daily_replay_attempts
  where id = p_attempt_id
  for update;
  if not found then
    raise exception 'attempt not found';
  end if;
  if v_attempt.user_id <> auth.uid() then
    raise exception 'permission denied: not your attempt';
  end if;

  -- Idempotent replay: already finished → hand back the session that
  -- the first completion created; insert nothing.
  if v_attempt.status = 'finished' then
    if v_attempt.session_id is null then
      raise exception 'attempt is finished but has no session link';
    end if;
    return v_attempt.session_id;
  end if;
  if v_attempt.status <> 'active' then
    raise exception 'attempt is not active';
  end if;

  if p_candles is null or jsonb_typeof(p_candles) <> 'array' then
    raise exception 'candles must be a jsonb array';
  end if;
  if p_fills is not null and jsonb_typeof(p_fills) <> 'array' then
    raise exception 'fills must be a jsonb array';
  end if;

  select ticker, trade_date into v_ticker, v_trade_date
  from public.daily_replay_datasets
  where id = v_attempt.dataset_id;
  if not found then
    raise exception 'dataset not found';
  end if;

  insert into public.replay_sessions
    (user_id, ticker, trade_date, source, candles, start_index,
     final_cash, realized_pnl)
  values
    (v_attempt.user_id, v_ticker, v_trade_date, 'daily_replay',
     p_candles, coalesce(p_start_index, v_attempt.start_index),
     p_final_cash, p_realized_pnl)
  returning id into v_session_id;

  insert into public.session_trades
    (session_id, user_id, side, qty, price, candle_index, candle_time,
     realized_pnl, note)
  select
    v_session_id,
    v_attempt.user_id,
    f.side,
    f.qty,
    f.price,
    f.candle_index,
    f.candle_time,
    coalesce(f.realized_pnl, 0),
    f.note
  from jsonb_to_recordset(coalesce(p_fills, '[]'::jsonb)) as f(
    side text,
    qty numeric,
    price numeric,
    candle_index int,
    candle_time timestamptz,
    realized_pnl numeric,
    note text
  );

  update public.daily_replay_attempts
  set status = 'finished',
      finished_at = now(),
      session_id = v_session_id
  where id = p_attempt_id;

  return v_session_id;
end;
$$;

-- ============ GRANTS ============
revoke all on function public.dr_create_attempt(uuid, int, uuid) from public;
revoke all on function public.dr_allocate_strategy_version(uuid, text, text, text, text, text, jsonb, text) from public;
revoke all on function public.dr_complete_attempt(uuid, jsonb, int, numeric, numeric, jsonb) from public;

grant execute on function public.dr_create_attempt(uuid, int, uuid) to authenticated;
grant execute on function public.dr_allocate_strategy_version(uuid, text, text, text, text, text, jsonb, text) to authenticated;
grant execute on function public.dr_complete_attempt(uuid, jsonb, int, numeric, numeric, jsonb) to authenticated;
