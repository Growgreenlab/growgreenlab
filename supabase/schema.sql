-- Trade Replay Lab v2 schema
-- Run this in your Supabase project's SQL editor (Dashboard -> SQL Editor -> New query).

-- Profiles: one row per auth user (created automatically on signup).
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

-- Auto-create a profile when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Replay sessions: one row per saved simulator session.
-- `candles` stores the full candle array as JSONB so a session can be
-- reloaded exactly as it was replayed.
create table if not exists public.replay_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  trade_date date not null,
  source text not null check (source in ('sample', 'twelvedata', 'csv')),
  candles jsonb not null,
  start_index integer not null default 0,
  final_cash numeric,
  realized_pnl numeric,
  created_at timestamptz not null default now()
);

-- Individual simulated fills belonging to a session.
create table if not exists public.session_trades (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.replay_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  side text not null check (side in ('buy', 'sell')),
  qty numeric not null,
  price numeric not null,
  candle_index integer not null,
  candle_time timestamptz,
  realized_pnl numeric not null default 0,
  note text,
  created_at timestamptz not null default now()
);

-- Row Level Security: users can only touch their own rows.
alter table public.profiles enable row level security;
alter table public.replay_sessions enable row level security;
alter table public.session_trades enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "own sessions" on public.replay_sessions;
create policy "own sessions" on public.replay_sessions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own session trades" on public.session_trades;
create policy "own session trades" on public.session_trades
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Helpful index for the "My Sessions" list (newest first per user).
create index if not exists replay_sessions_user_created
  on public.replay_sessions (user_id, created_at desc);
create index if not exists session_trades_session
  on public.session_trades (session_id);

-- Psychology Guard: cross-browser lockout persistence (signed-in users).
alter table public.profiles
  add column if not exists guard_lockout_expiry timestamptz,
  add column if not exists guard_lockout_threshold numeric,
  add column if not exists guard_lockout_started_at timestamptz;

-- Psychology Guard: guest cross-browser lockout (device fingerprint).
-- Not bulletproof (VPN/incognito/new device bypasses), but stops casual browser-switching.
create table if not exists public.guest_guard_lockouts (
  fingerprint text primary key,
  expiry timestamptz not null,
  threshold numeric,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.guest_guard_lockouts enable row level security;
drop policy if exists "public guard lockout" on public.guest_guard_lockouts;
create policy "public guard lockout" on public.guest_guard_lockouts
  for all using (true) with check (true);

-- Guest trade limit: 5 new positions per day (fingerprint-based).
create table if not exists public.guest_trade_usage (
  fingerprint text not null,
  trade_date date not null default current_date,
  count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (fingerprint, trade_date)
);
alter table public.guest_trade_usage enable row level security;
drop policy if exists "public guest usage" on public.guest_trade_usage;
create policy "public guest usage" on public.guest_trade_usage
  for all using (true) with check (true);

-- Remaining trades for a fingerprint today.
create or replace function public.guest_trades_remaining(fp text)
returns int as $$
declare c int;
begin
  select count into c from public.guest_trade_usage
  where fingerprint = fp and trade_date = current_date;
  if not found then return 5; end if;
  return greatest(0, 5 - c);
end;
$$ language plpgsql security definer;

-- Atomically consume one trade. Returns true if consumed, false if at limit.
create or replace function public.try_consume_guest_trade(fp text, max_trades int)
returns boolean as $$
declare current_count int;
begin
  select count into current_count from public.guest_trade_usage
  where fingerprint = fp and trade_date = current_date
  for update;
  if not found then
    insert into public.guest_trade_usage (fingerprint, trade_date, count)
    values (fp, current_date, 1);
    return true;
  end if;
  if current_count >= max_trades then
    return false;
  end if;
  update public.guest_trade_usage
  set count = count + 1, updated_at = now()
  where fingerprint = fp and trade_date = current_date;
  return true;
end;
$$ language plpgsql security definer;

-- Persistent account balance (carries P&L across sessions)
alter table public.profiles add column if not exists account_balance numeric not null default 100000;

-- Trade Journal Phase 1: annotations for simulator trades + manual trade storage.

-- Per-trade annotations (Trade DNA, psychology, grades) for simulator trades.
-- Trade data itself comes from session_trades; this stores the human layer.
-- trade_key is deterministic: "{session_id}:{sequence}" where sequence is the
-- Nth position cycle (flat -> open -> flat) in that session. Idempotent.
create table if not exists public.journal_trade_meta (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.replay_sessions(id) on delete cascade,
  trade_key text not null,
  setup_tag text,
  hod_class text check (hod_class in ('clean', 'weak', 'failed', 'anticipation')),
  strategy_id uuid, -- FK to public.strategies(id) is added by supabase/migrations/journal-strategy-annotation-v1.sql
  setup_class text,
  strategy_custom_label text,
  entry_trigger text,
  exec_grade text check (exec_grade in ('A', 'B', 'C', 'D')),
  entry_reasoning text,
  exit_reasoning text,
  followed_plan boolean,
  confidence integer check (confidence between 1 and 10),
  emotional_tags text[] not null default '{}',
  mistakes text[] not null default '{}',
  notes text,
  lessons text,
  would_take_again boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, trade_key)
);

-- Manual trades (external/live trades not from the simulator).
create table if not exists public.journal_manual_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  trade_date date not null,
  direction text not null check (direction in ('long', 'short')),
  entry_price numeric not null,
  exit_price numeric,
  qty numeric not null,
  entry_time timestamptz,
  exit_time timestamptz,
  stop_loss numeric,
  target numeric,
  fees numeric not null default 0,
  realized_pnl numeric,
  setup_tag text,
  hod_class text check (hod_class in ('clean', 'weak', 'failed', 'anticipation')),
  exec_grade text check (exec_grade in ('A', 'B', 'C', 'D')),
  entry_reasoning text,
  exit_reasoning text,
  followed_plan boolean,
  confidence integer check (confidence between 1 and 10),
  emotional_tags text[] not null default '{}',
  mistakes text[] not null default '{}',
  notes text,
  lessons text,
  would_take_again boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.journal_trade_meta enable row level security;
alter table public.journal_manual_trades enable row level security;

drop policy if exists "own journal meta" on public.journal_trade_meta;
create policy "own journal meta" on public.journal_trade_meta
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own manual trades" on public.journal_manual_trades;
create policy "own manual trades" on public.journal_manual_trades
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists journal_meta_user_key on public.journal_trade_meta (user_id, trade_key);
create index if not exists journal_meta_session on public.journal_trade_meta (session_id);
create index if not exists journal_manual_user_date on public.journal_manual_trades (user_id, trade_date desc);

-- Trade Journal: real-market trades (external brokers).
-- Fills-based design: one trade has many fills (multiple entries, partial exits).
-- Never written by the simulator pipeline; completely separate from session_trades.

create table if not exists public.journal_real_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  company_name text,
  broker text,
  trade_date date not null,
  direction text not null check (direction in ('long', 'short')),
  strategy text,
  status text not null default 'open' check (status in ('open', 'closed')),
  stop_loss numeric,
  target numeric,
  float_shares numeric,
  relative_volume numeric,
  market_conditions text,
  level2_tas_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.journal_real_fills (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null references public.journal_real_trades(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  side text not null check (side in ('buy', 'sell')),
  qty numeric not null check (qty > 0),
  price numeric not null check (price > 0),
  fill_time timestamptz,
  fees numeric not null default 0 check (fees >= 0),
  note text,
  created_at timestamptz not null default now()
);

alter table public.journal_real_trades enable row level security;
alter table public.journal_real_fills enable row level security;

drop policy if exists "own real trades" on public.journal_real_trades;
create policy "own real trades" on public.journal_real_trades
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own real fills" on public.journal_real_fills;
create policy "own real fills" on public.journal_real_fills
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists journal_real_trades_user_date on public.journal_real_trades (user_id, trade_date desc);
create index if not exists journal_real_fills_trade on public.journal_real_fills (trade_id);
create index if not exists journal_real_fills_user on public.journal_real_fills (user_id);

-- Broker CSV import: duplicate prevention via deterministic fill hash.
alter table public.journal_real_fills
  add column if not exists import_hash text;
create unique index if not exists journal_real_fills_import_hash
  on public.journal_real_fills (user_id, import_hash)
  where import_hash is not null;

-- Daily Replay trade drafts: per-cycle durable drafts written when a
-- Daily Replay position cycle closes (identity + status + anchors
-- only; see supabase/migrations/daily-replay-trade-drafts-v1.sql,
-- PREPARED ONLY — not applied). Mirror of that migration for fresh
-- installs. NOTE: this base schema predates the Daily Replay tables —
-- daily_replay_attempts is created by the daily-replay-v1 migration,
-- which runs AFTER this file in the migration stack — so the mirror
-- is created inside an existence guard: on a stack run the migration
-- file creates the table, and on any database where the attempts
-- table already exists this block creates the identical table here.
do $drafts_guard$
begin
  if exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'daily_replay_attempts'
  ) then
    execute $sql$
      create table if not exists public.daily_replay_trade_drafts (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references auth.users(id) on delete cascade,
        attempt_id uuid not null
          references public.daily_replay_attempts(id) on delete cascade,
        reset_generation int not null check (reset_generation >= 0),
        cycle_index int not null check (cycle_index >= 1),
        draft_key text not null,
        status text not null default 'draft'
          check (status in ('draft', 'finalized', 'superseded')),
        first_fill_candle_index int not null,
        first_fill_price numeric not null,
        first_fill_qty numeric not null,
        close_fill_candle_index int not null,
        realized_pnl numeric not null,
        event_first_seq int not null,
        event_last_seq int not null,
        auto_capture jsonb not null default '{}'::jsonb,
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
    $sql$;
    -- NO delete policy (same as the migration): lifecycle is status.
  end if;
end;
$drafts_guard$;

-- Subscriptions v1: billing mirror + quota ledger + enforcement
-- (see supabase/migrations/subscriptions-v1.sql, PREPARED ONLY — not
-- applied; D11 TAX GATE lives in that file's header and in
-- docs/subscriptions-release-checklist.md: live billing must not be
-- enabled until tax treatment and registration requirements are
-- reviewed). Mirror for fresh installs. The two draft triggers are
-- existence-guarded like the drafts mirror above: on a stack run the
-- subscriptions migration creates them once the drafts table exists.
-- ============ BILLING: STRIPE CUSTOMER MAP ============
create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);

-- ============ BILLING: SUBSCRIPTION STATE (Stripe mirror) ============
-- One row per Stripe subscription (a user can accumulate rows over
-- time: canceled, resubscribed). Stripe is the source of truth; this
-- table is its local mirror, written ONLY by the webhook route via
-- the service role. stripe_event_created is the out-of-order guard:
-- an event older than the last applied one never rewrites the row.
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_subscription_id text not null unique,
  stripe_customer_id text not null,
  status text not null,
  price_id text,
  interval text check (interval in ('month', 'year')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  stripe_event_created timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_user_idx
  on public.subscriptions (user_id, updated_at desc);

-- ============ BILLING: WEBHOOK IDEMPOTENCY LEDGER ============
create table if not exists public.stripe_events_processed (
  event_id text primary key,
  type text not null,
  created timestamptz,
  received_at timestamptz not null default now()
);

-- ============ QUOTA: USAGE LEDGER ============
-- period_day / period_month are the America/New_York buckets of the
-- consume moment (D3/D4) — stored on the row so counting a period is
-- a straight equality lookup and historical rows never move buckets.
create table if not exists public.usage_ledger (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('daily_trade', 'monthly_entry')),
  logical_key text not null,
  period_day date not null,
  period_month date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, logical_key)
);
create index if not exists usage_ledger_period_idx
  on public.usage_ledger (user_id, kind, period_day, period_month);

-- ============ QUOTA: ONE-TIME HISTORICAL IMPORT ALLOWANCE ============
create table if not exists public.import_allowance (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted integer not null default 100 check (granted >= 0),
  used integer not null default 0 check (used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============ RLS: owner SELECT only; no client writes ============
alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.stripe_events_processed enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.import_allowance enable row level security;

drop policy if exists billing_customers_select_own on public.billing_customers;
create policy billing_customers_select_own on public.billing_customers
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists usage_ledger_select_own on public.usage_ledger;
create policy usage_ledger_select_own on public.usage_ledger
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists import_allowance_select_own on public.import_allowance;
create policy import_allowance_select_own on public.import_allowance
  for select to authenticated using (auth.uid() = user_id);
-- stripe_events_processed: RLS on, NO policies — service role only.
-- No INSERT/UPDATE/DELETE policies on any of these tables: clients can
-- never write entitlement or counters; writers are the security-
-- definer functions below and the service-role webhook route.

-- ============ PERIOD BUCKETS (America/New_York) ============
create or replace function public.sub_et_day(p_now timestamptz)
returns date language sql immutable as
$$ select (p_now at time zone 'America/New_York')::date $$;

create or replace function public.sub_et_month(p_now timestamptz)
returns date language sql immutable as
$$ select date_trunc('month', (p_now at time zone 'America/New_York'))::date $$;

-- ============ ENTITLEMENT: THE ONE is_pro ============
-- Status map (audit §5.4 + finalized D6):
--   active   -> pro
--   past_due -> pro until current_period_end + 7 days (grace)
--   canceled -> pro until current_period_end (paid-through date)
--   anything else / no row -> not pro
create or replace function public.sub_is_pro(
  p_user uuid,
  p_now timestamptz default now()
) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user
      and (
        s.status = 'active'
        or (s.status = 'past_due'
            and s.current_period_end is not null
            and p_now < s.current_period_end + interval '7 days')
        or (s.status = 'canceled'
            and s.current_period_end is not null
            and p_now < s.current_period_end)
      )
  );
$$;

-- ============ QUOTA: CONSUME (atomic, idempotent) ============
-- Returns 'pro' (nothing recorded), 'already' (this logical key was
-- counted before — a retry/tab/replay, proceed), or 'consumed'.
-- Raises errcode GGL01 with a JSON DETAIL when the cap is reached;
-- because every caller runs inside the guarded write's transaction,
-- the raise rolls the whole write back — no partial trade, no
-- partial count. The per-user advisory lock serializes consumes so
-- concurrent requests cannot both slip under the cap; the ledger PK
-- collapses duplicate logical keys.
create or replace function public.sub_consume(
  p_user uuid,
  p_kind text,
  p_logical_key text,
  p_now timestamptz default now()
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_limit integer;
  v_used integer;
  v_day date := public.sub_et_day(p_now);
  v_month date := public.sub_et_month(p_now);
begin
  if p_kind = 'daily_trade' then v_limit := 3;
  elsif p_kind = 'monthly_entry' then v_limit := 7;
  else raise exception 'sub_consume: unknown kind %', p_kind; end if;

  perform pg_advisory_xact_lock(hashtext('sub:' || p_user::text));

  if public.sub_is_pro(p_user, p_now) then
    return 'pro';
  end if;

  if exists (
    select 1 from public.usage_ledger
    where user_id = p_user and kind = p_kind and logical_key = p_logical_key
  ) then
    return 'already';
  end if;

  if p_kind = 'daily_trade' then
    select count(*) into v_used from public.usage_ledger
    where user_id = p_user and kind = p_kind and period_day = v_day;
  else
    select count(*) into v_used from public.usage_ledger
    where user_id = p_user and kind = p_kind and period_month = v_month;
  end if;

  if v_used >= v_limit then
    raise exception 'quota_limit_reached'
      using errcode = 'GGL01',
        detail = json_build_object(
          'kind', p_kind, 'limit', v_limit, 'used', v_used,
          'logical_key', p_logical_key
        )::text;
  end if;

  insert into public.usage_ledger (user_id, kind, logical_key, period_day, period_month)
  values (p_user, p_kind, p_logical_key, v_day, v_month);
  return 'consumed';
end;
$$;

-- ============ QUOTA: IMPORT ALLOWANCE CLAIM ============
-- One unit of the one-time historical import allowance, or false when
-- exhausted. Claimed BEFORE quota inside import_real_trades; a
-- claimed unit means that imported entry consumes neither quota.
create or replace function public.sub_claim_import_unit(
  p_user uuid
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_claimed boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext('sub:' || p_user::text));
  insert into public.import_allowance (user_id) values (p_user)
  on conflict (user_id) do nothing;
  update public.import_allowance
     set used = used + 1, updated_at = now()
   where user_id = p_user and used < granted
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

-- ============ ENFORCEMENT: REAL TRADE INSERT TRIGGER ============
-- The journal_real_trades row insert IS the birth of the trade and
-- the journal entry (audit §4.2) — it consumes one unit of each
-- quota, keyed real:{id}. Edits update the same row (no insert, no
-- consume); deletes never refund (D9). Inserts made by the
-- import_real_trades RPC are skipped here — that RPC does its own
-- allowance-then-quota accounting inside its transaction.
create or replace function public.sub_quota_real_trade()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.sub_import_rpc', true), '') = 'on' then
    return new;
  end if;
  perform public.sub_consume(new.user_id, 'daily_trade', 'real:' || new.id::text);
  perform public.sub_consume(new.user_id, 'monthly_entry', 'real:' || new.id::text);
  return new;
end;
$$;

drop trigger if exists trg_sub_quota_real_trade on public.journal_real_trades;
create trigger trg_sub_quota_real_trade
  before insert on public.journal_real_trades
  for each row execute function public.sub_quota_real_trade();

-- ============ ENFORCEMENT: DR DRAFT INSERT + FINALIZE TRIGGERS ============
-- Draft creation at position close = the DR trade's birth (daily
-- quota). The drafts table's unique (attempt_id, reset_generation,
-- cycle_index) collapses retries/resume/reconcile into a single
-- INSERT; upsert no-ops aside, the ledger key is the draft_key
-- itself, so the consume is exactly-once by construction.
create or replace function public.sub_quota_draft_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.sub_consume(new.user_id, 'daily_trade', new.draft_key);
  return new;
end;
$$;

do $sub_guard$
begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='daily_replay_trade_drafts') then
    drop trigger if exists trg_sub_quota_draft_insert on public.daily_replay_trade_drafts;
    create trigger trg_sub_quota_draft_insert
      before insert on public.daily_replay_trade_drafts
      for each row execute function public.sub_quota_draft_insert();
  end if;
end;
$sub_guard$;
-- Finalization is the exact moment a DR trade becomes a journal
-- entry (finalization gates visibility). The client's guarded flip
-- (status='draft' in the WHERE clause) fires this trigger exactly
-- once; a rejected consume rolls the flip back, so a trade can never
-- become visible-but-uncounted or counted-but-invisible.
create or replace function public.sub_quota_draft_finalize()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.sub_consume(new.user_id, 'monthly_entry', new.draft_key);
  return new;
end;
$$;

do $sub_guard$
begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='daily_replay_trade_drafts') then
    drop trigger if exists trg_sub_quota_draft_finalize on public.daily_replay_trade_drafts;
    create trigger trg_sub_quota_draft_finalize
      before update on public.daily_replay_trade_drafts
      for each row
      when (old.status = 'draft' and new.status = 'finalized')
      execute function public.sub_quota_draft_finalize();
  end if;
end;
$sub_guard$;
-- NOTE: dr_complete_attempt intentionally gets NO quota code.
-- Completion only re-keys entries already counted at finalization;
-- counting there would double-count every finalized trade. A
-- regression test pins this (SQL harness: completion consumes zero).

-- ============ IMPORT RPC: atomic batch import ============
-- Replaces the client's per-group insert loop (audit §4.2/§5.2): the
-- whole batch runs in ONE transaction. Groups whose fills are all
-- already imported (import_hash dedupe) insert nothing and consume
-- nothing. Every NEW group first claims a one-time allowance unit;
-- once the allowance is exhausted it consumes daily + monthly quota.
-- Any cap raise aborts the ENTIRE import — no partial history, no
-- partial counts. Returns {imported, skipped} like the old loop.
-- p_groups: [{ticker, broker, trade_date, direction,
--             fills: [{side, qty, price, fees, fill_time, hash}]}]
create or replace function public.import_real_trades(p_groups jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_group jsonb;
  v_fill jsonb;
  v_new_fills jsonb;
  v_trade_id uuid;
  v_imported integer := 0;
  v_skipped integer := 0;
begin
  if v_user is null then
    raise exception 'import_real_trades: not signed in';
  end if;
  perform set_config('app.sub_import_rpc', 'on', true);

  for v_group in select * from jsonb_array_elements(coalesce(p_groups, '[]'::jsonb))
  loop
    -- New fills only: a fill counts as new when it carries a hash
    -- this user has not imported before (mirrors the client's
    -- pre-fetch dedupe exactly, but race-free inside the txn).
    select coalesce(jsonb_agg(f), '[]'::jsonb) into v_new_fills
    from jsonb_array_elements(coalesce(v_group->'fills', '[]'::jsonb)) f
    where coalesce(f->>'hash', '') <> ''
      and not exists (
        select 1 from public.journal_real_fills rf
        where rf.user_id = v_user and rf.import_hash = f->>'hash'
      );
    if jsonb_array_length(v_new_fills) = 0 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.journal_real_trades
      (user_id, ticker, broker, trade_date, direction, strategy)
    values (
      v_user,
      v_group->>'ticker',
      v_group->>'broker',
      (v_group->>'trade_date')::date,
      v_group->>'direction',
      'Imported'
    )
    returning id into v_trade_id;

    -- Accounting: one-time allowance first, then quota (D5).
    if not public.sub_claim_import_unit(v_user) then
      perform public.sub_consume(v_user, 'daily_trade', 'real:' || v_trade_id::text);
      perform public.sub_consume(v_user, 'monthly_entry', 'real:' || v_trade_id::text);
    end if;

    for v_fill in select * from jsonb_array_elements(v_new_fills)
    loop
      insert into public.journal_real_fills
        (trade_id, user_id, side, qty, price, fees, fill_time, import_hash)
      values (
        v_trade_id,
        v_user,
        v_fill->>'side',
        (v_fill->>'qty')::numeric,
        (v_fill->>'price')::numeric,
        coalesce((v_fill->>'fees')::numeric, 0),
        nullif(v_fill->>'fill_time', '')::timestamptz,
        v_fill->>'hash'
      );
    end loop;
    v_imported := v_imported + 1;
  end loop;

  return jsonb_build_object('imported', v_imported, 'skipped', v_skipped);
end;
$$;

-- ============ SIMULATOR SAVE RPC (audit §5.3) ============
-- The signed-in simulator save rewrites a session's fills wholesale
-- (delete-all + re-insert), which no trigger can count. This RPC is
-- the trusted choke point instead: ONE transaction that upserts the
-- session, replaces the fills (same semantics as the legacy client
-- path), regroups the fills into closed position cycles SERVER-SIDE
-- with the same flat->flat walk as lib/journal.ts
-- groupFillsIntoTrades, consumes quota for each NEW grouped trade
-- key {session_id}:{sequence} (daily + monthly — a saved sim trade
-- is a journal entry), and persists the account balance the client
-- computed with its existing delta guard (the number arrives as
-- p_account_balance and is stored verbatim — the delta logic is
-- ported, not redesigned). Re-saves consume nothing: every key is
-- already in the ledger. A cap raise rolls the whole save back — the
-- session keeps its last saved state.
-- p_session: {ticker, trade_date, source, candles, start_index,
--             final_cash, realized_pnl}
-- p_fills: engine-order array [{side, qty, price, candleIndex,
--          time (ms epoch), realizedPnl, note}]
create or replace function public.save_replay_session(
  p_session_id uuid,
  p_session jsonb,
  p_fills jsonb,
  p_account_balance numeric
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_session_id uuid;
  v_fill jsonb;
  v_pos numeric := 0;
  v_in_cycle boolean := false;
  v_seq integer := 0;
begin
  if v_user is null then
    raise exception 'save_replay_session: not signed in';
  end if;

  if p_session_id is null then
    insert into public.replay_sessions
      (user_id, ticker, trade_date, source, candles, start_index, final_cash, realized_pnl)
    values (
      v_user,
      p_session->>'ticker',
      (p_session->>'trade_date')::date,
      p_session->>'source',
      p_session->'candles',
      coalesce((p_session->>'start_index')::integer, 0),
      (p_session->>'final_cash')::numeric,
      (p_session->>'realized_pnl')::numeric
    )
    returning id into v_session_id;
  else
    update public.replay_sessions set
      ticker = p_session->>'ticker',
      trade_date = (p_session->>'trade_date')::date,
      source = p_session->>'source',
      candles = p_session->'candles',
      start_index = coalesce((p_session->>'start_index')::integer, 0),
      final_cash = (p_session->>'final_cash')::numeric,
      realized_pnl = (p_session->>'realized_pnl')::numeric
    where id = p_session_id and user_id = v_user
    returning id into v_session_id;
    if v_session_id is null then
      raise exception 'save_replay_session: session not found';
    end if;
  end if;

  delete from public.session_trades where session_id = v_session_id;

  -- Insert fills in engine (array) order and regroup in the same
  -- pass: the walk mirrors groupFillsIntoTrades — position is the
  -- signed sum of qty (buy +, sell -); a cycle closes when the
  -- position returns to flat; open-at-end cycles never count.
  for v_fill in
    select value from jsonb_array_elements(coalesce(p_fills, '[]'::jsonb)) with ordinality as t(value, ord) order by t.ord
  loop
    insert into public.session_trades
      (session_id, user_id, side, qty, price, candle_index, candle_time, realized_pnl, note)
    values (
      v_session_id,
      v_user,
      v_fill->>'side',
      (v_fill->>'qty')::numeric,
      (v_fill->>'price')::numeric,
      (v_fill->>'candleIndex')::integer,
      case when v_fill->>'time' is not null
           then to_timestamp((v_fill->>'time')::numeric / 1000.0)
           else null end,
      coalesce((v_fill->>'realizedPnl')::numeric, 0),
      nullif(v_fill->>'note', '')
    );

    if v_fill->>'side' = 'buy' then
      v_pos := v_pos + (v_fill->>'qty')::numeric;
    else
      v_pos := v_pos - (v_fill->>'qty')::numeric;
    end if;
    v_in_cycle := true;
    if abs(v_pos) < 0.000000001 and v_in_cycle then
      v_seq := v_seq + 1;
      perform public.sub_consume(v_user, 'daily_trade', v_session_id::text || ':' || v_seq::text);
      perform public.sub_consume(v_user, 'monthly_entry', v_session_id::text || ':' || v_seq::text);
      v_in_cycle := false;
    end if;
  end loop;

  -- Balance: the client's delta-guarded absolute value, stored
  -- verbatim in the same transaction (audit §5.3 — ported, not
  -- redesigned). NULL means "leave the balance alone" (DR saves never
  -- call this RPC).
  if p_account_balance is not null then
    update public.profiles set account_balance = p_account_balance
    where id = v_user;
  end if;

  return v_session_id;
end;
$$;

-- ============ READ MODEL: USAGE STATUS (UI counters + gates) ============
-- Returns NULL when signed out. The client treats a missing/failed
-- RPC call as "billing not configured" and keeps every billing
-- surface dark — the same probe pattern as the strategy features.
create or replace function public.usage_status(p_now timestamptz default now())
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_pro boolean;
  v_day date := public.sub_et_day(p_now);
  v_month date := public.sub_et_month(p_now);
  v_trades integer;
  v_entries integer;
  v_allow_left integer;
  v_sub public.subscriptions%rowtype;
begin
  if v_user is null then return null; end if;
  v_pro := public.sub_is_pro(v_user, p_now);

  select count(*) into v_trades from public.usage_ledger
  where user_id = v_user and kind = 'daily_trade' and period_day = v_day;
  select count(*) into v_entries from public.usage_ledger
  where user_id = v_user and kind = 'monthly_entry' and period_month = v_month;
  select greatest(granted - used, 0) into v_allow_left
  from public.import_allowance where user_id = v_user;
  select * into v_sub from public.subscriptions
  where user_id = v_user order by updated_at desc limit 1;

  return jsonb_build_object(
    'configured', true,
    'is_pro', v_pro,
    'plan', case when v_pro then 'pro' else 'free' end,
    'trades_used', v_trades,
    'trades_limit', 3,
    'trades_remaining', case when v_pro then null else greatest(3 - v_trades, 0) end,
    'entries_used', v_entries,
    'entries_limit', 7,
    'entries_remaining', case when v_pro then null else greatest(7 - v_entries, 0) end,
    'import_allowance_remaining', coalesce(v_allow_left, 100),
    'day_reset_at', (((v_day + 1)::timestamp) at time zone 'America/New_York'),
    'month_reset_at', (((v_month + interval '1 month')::date::timestamp) at time zone 'America/New_York'),
    'subscription', case when v_sub.id is null then null else jsonb_build_object(
      'status', v_sub.status,
      'interval', v_sub.interval,
      'current_period_end', v_sub.current_period_end,
      'cancel_at_period_end', v_sub.cancel_at_period_end
    ) end
  );
end;
$$;

-- ============ GRANTS ============
-- Client-callable RPCs (authenticated): the read model and the two
-- write choke points. Internal helpers are owner-only: triggers and
-- the definer RPCs above call them; clients cannot call them
-- directly to forge or drain counters.
revoke all on function public.usage_status(timestamptz) from public, anon;
grant execute on function public.usage_status(timestamptz) to authenticated;
revoke all on function public.import_real_trades(jsonb) from public, anon;
grant execute on function public.import_real_trades(jsonb) to authenticated;
revoke all on function public.save_replay_session(uuid, jsonb, jsonb, numeric) from public, anon;
grant execute on function public.save_replay_session(uuid, jsonb, jsonb, numeric) to authenticated;
-- Internal helpers: revoked from every API role (Supabase default
-- privileges would otherwise grant EXECUTE to authenticated at
-- creation time). Only the function owner — i.e. the security-
-- definer triggers/RPCs above and the service role — can run them.
revoke all on function public.sub_consume(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.sub_claim_import_unit(uuid) from public, anon, authenticated;
revoke all on function public.sub_is_pro(uuid, timestamptz) from public, anon, authenticated;
