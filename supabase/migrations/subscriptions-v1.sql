-- Subscriptions v1 (branch feature/subscriptions)
-- *** PREPARED ONLY — NOT APPLIED ***
-- This file has NOT been run against any database except the local
-- PGlite SQL harness. Applying it waits for Karandeep's explicit
-- rollout authorization (paste into the Supabase SQL editor, per
-- DEPLOY.md), per the release checklist in
-- docs/subscriptions-release-checklist.md.
--
-- =====================================================================
-- D11 TAX GATE (MANDATORY PRE-LAUNCH GATE)
-- Live billing must not be enabled until tax treatment and
-- registration requirements are reviewed (D11). Stripe Tax is NOT
-- integrated by this migration or by the billing code that ships with
-- it; prices are tax-exclusive. Enabling live mode, live prices, or
-- live webhook endpoints before that review is a launch-blocker, not
-- a configuration detail.
-- =====================================================================
--
-- Design (audit: ~/workspace/subscription-architecture-audit-2026-10-18.md
-- §4 quota map, §5 enforcement design; decisions D1–D13 as finalized
-- 2026-10-18):
--   * Plans: Free = 3 qualifying trades / calendar day + 7 qualifying
--     journal entries / calendar month; Pro (CAD $9.99/mo,
--     $99.99/yr — D1 as amended at go-live) = unlimited. No trial (D10). Stripe-default
--     proration (D13).
--   * Counting is by CREATION MOMENT (server time), never trade_date
--     (D4), in America/New_York day/month buckets (D3). Deletes and
--     supersedes never refund quota (D9). Guests are unchanged — the
--     guest limit system is separate and untouched (D2).
--   * One journal entry = one grouped logical trade. A Daily Replay
--     trade is ONE entry across its whole life: the DAILY quota is
--     consumed when its draft row is created at position close, the
--     MONTHLY quota when the draft is finalized; session completion
--     (dr_complete_attempt) consumes nothing — it only re-keys the
--     entry that finalization already counted.
--   * CSV imports count like any other creation (D5), with a ONE-TIME
--     historical import allowance of 100 entries per account consumed
--     BEFORE quota. Imports run through one security-definer RPC
--     (import_real_trades) so a batch is refused atomically — the
--     whole import rolls back rather than half-importing.
--   * Entitlement is ONE function (sub_is_pro): status 'active' ->
--     pro; 'past_due' -> pro until current_period_end + 7 days (D6
--     grace, alongside Stripe Smart Retries); 'canceled' -> pro until
--     current_period_end (cancel-at-period-end keeps paid access);
--     everything else (incomplete, unpaid, no row) -> not pro.
--   * Enforcement lives in the database, in the same transaction as
--     the guarded write: BEFORE INSERT trigger on journal_real_trades,
--     BEFORE INSERT + finalize-flip triggers on
--     daily_replay_trade_drafts, and the save_replay_session RPC for
--     simulator saves (the one path whose wholesale fill rewrites
--     defeat triggers — audit §5.3). The usage ledger's primary key
--     (user_id, kind, logical_key) makes every consume idempotent:
--     retries, duplicate requests, multiple tabs and replay
--     workflows converge on one ledger row per logical trade.
--   * Billing tables are owner-SELECT only under RLS. ALL writes come
--     from security-definer functions or the service role (the Stripe
--     webhook route). No client can write its own entitlement or
--     counters. No card data is stored anywhere (Stripe hosts it).
--
-- Rollback (pre-launch): drop the triggers, functions and tables this
-- file creates (in reverse order); no existing rows are modified by
-- this migration, and removing it restores pre-feature behavior
-- exactly (the app ships dark: with no usage_status RPC and no
-- rollout timestamp configured, every billing surface self-disables).

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

drop trigger if exists trg_sub_quota_draft_insert on public.daily_replay_trade_drafts;
create trigger trg_sub_quota_draft_insert
  before insert on public.daily_replay_trade_drafts
  for each row execute function public.sub_quota_draft_insert();

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

drop trigger if exists trg_sub_quota_draft_finalize on public.daily_replay_trade_drafts;
create trigger trg_sub_quota_draft_finalize
  before update on public.daily_replay_trade_drafts
  for each row
  when (old.status = 'draft' and new.status = 'finalized')
  execute function public.sub_quota_draft_finalize();

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
