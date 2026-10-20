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

-- ============ ACCESS GRANTS: TABLES (access-grants-v1) ====
-- Mirrored from supabase/migrations/access-grants-v1.sql — see
-- that file for the full design notes. NO seed data here either:
-- admins and owner grants are seeded via the SQL editor only.
-- ============ ADMINS ============
-- Who may operate the grants system. Seeded ONLY via SQL editor /
-- service role. RLS enabled with NO policies on purpose: the table
-- is invisible to every client role; the security-definer helper
-- is_app_admin() is the only read path, and it answers only about
-- the CALLER.
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ============ PROMO CODES ============
-- Plaintext codes are NEVER stored — only the sha-256 hex of the
-- normalized (trimmed, uppercased) code. Codes are >= 10 chars from
-- an unambiguous alphabet (enforced in admin_create_promo), so the
-- hash is not a practical enumeration target even if leaked.
create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  label text,
  duration_days integer not null check (duration_days > 0),
  expires_at timestamptz,
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  redeemed_count integer not null default 0 check (redeemed_count >= 0),
  per_user_limit integer not null default 1 check (per_user_limit > 0),
  active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ============ ACCESS GRANTS ============
-- One row per grant of complimentary access. A grant is ACTIVE iff
-- starts_at <= now, revoked_at is null, and (expires_at is null or
-- now < expires_at) — evaluated at read time by sub_has_active_grant.
create table if not exists public.access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('owner','admin','promo','trial')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references auth.users(id),
  promo_code_id uuid references public.promo_codes(id),
  note text,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > starts_at),
  -- Owner access is permanent by construction.
  check (source <> 'owner' or expires_at is null)
);
create index if not exists access_grants_user_idx
  on public.access_grants (user_id, starts_at, expires_at)
  where revoked_at is null;

-- ============ PROMO REDEMPTIONS ============
-- The authoritative count for cap enforcement (checked under the
-- per-code advisory lock in redeem_promo_code; promo_codes.
-- redeemed_count is maintained as a display mirror of this count).
create table if not exists public.promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references public.promo_codes(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  grant_id uuid not null references public.access_grants(id),
  redeemed_at timestamptz not null default now()
);
create index if not exists promo_redemptions_code_user_idx
  on public.promo_redemptions (code_id, user_id);

-- ============ AUDIT LOG (append-only) ============
-- Written inside the same transaction as the action it records.
-- No client policies: invisible to anon/authenticated; readable by
-- admins only through admin_read_audit(). No UPDATE/DELETE path is
-- granted to any API role — the log is evidence.
create table if not exists public.access_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  action text not null check (action in
    ('grant','revoke','redeem','redeem_failed','promo_create','promo_deactivate','admin_add')),
  target_user_id uuid,
  grant_id uuid,
  promo_code_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists access_audit_actor_idx
  on public.access_audit_log (actor_user_id, action, created_at desc);

-- ============ RLS ============
-- access_grants: owner SELECT-own only (mirrors the subscriptions
-- tables); writes happen ONLY inside the security-definer functions
-- below or via the service role / SQL editor.
-- promo_codes, promo_redemptions, app_admins, access_audit_log:
-- RLS on with NO policies at all — no client access, by design.
alter table public.app_admins enable row level security;
alter table public.promo_codes enable row level security;
alter table public.access_grants enable row level security;
alter table public.promo_redemptions enable row level security;
alter table public.access_audit_log enable row level security;

drop policy if exists access_grants_select_own on public.access_grants;
create policy access_grants_select_own on public.access_grants
  for select to authenticated using (auth.uid() = user_id);

-- ============ OWNER-GRANT IMMUTABILITY (DB-level wall) ============
-- Second wall behind admin_revoke_grant's refusal: ANY update that
-- tries to revoke an owner grant, re-source it, or move it to a
-- different user raises — for every role, including future definer
-- functions. (A deliberate SQL-editor DELETE remains possible;
-- that is the documented owner-removal escape hatch.)
create or replace function public.access_grants_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.source = 'owner' then
    if new.revoked_at is not null and old.revoked_at is null then
      raise exception 'owner grants cannot be revoked' using errcode = 'GGL03';
    end if;
    if new.source <> 'owner' or new.user_id <> old.user_id then
      raise exception 'owner grants are immutable' using errcode = 'GGL03';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_access_grants_guard on public.access_grants;
create trigger trg_access_grants_guard
  before update on public.access_grants
  for each row execute function public.access_grants_guard();

-- ============ PERIOD BUCKETS (America/New_York) ============
create or replace function public.sub_et_day(p_now timestamptz)
returns date language sql immutable as
$$ select (p_now at time zone 'America/New_York')::date $$;

create or replace function public.sub_et_month(p_now timestamptz)
returns date language sql immutable as
$$ select date_trunc('month', (p_now at time zone 'America/New_York'))::date $$;

-- ============ ENTITLEMENT: THE ONE is_pro ============
-- Paid status map (audit §5.4 + finalized D6) lives VERBATIM in
-- sub_paid_is_pro below; sub_is_pro = paid OR a live access
-- grant (access-grants-v1). Mirrored from the migration.
-- ============ HELPERS ============
-- Is the CALLER an app admin? Mirrors community_is_mod()'s shape.
create or replace function public.is_app_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_admins where user_id = auth.uid()
  );
$$;

-- The ORIGINAL sub_is_pro body, verbatim from subscriptions-v1.sql —
-- the paid entitlement, factored out so it lives in exactly one
-- place. sub_is_pro (below) = this OR a live grant. Rollback
-- restores sub_is_pro to precisely this body (see rollback file).
create or replace function public.sub_paid_is_pro(
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

-- The single definition of a LIVE grant: started, not revoked,
-- not expired at p_now. Read-time evaluation — no cron, no sweeps.
create or replace function public.sub_has_active_grant(
  p_user uuid,
  p_now timestamptz default now()
) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.access_grants g
    where g.user_id = p_user
      and g.revoked_at is null
      and g.starts_at <= p_now
      and (g.expires_at is null or p_now < g.expires_at)
  );
$$;

-- ============ ENTITLEMENT: sub_is_pro (same name + signature) ====
-- The one behavioral edit of this migration: paid OR granted.
-- sub_consume, every quota trigger/RPC and every client gate call
-- this function, so complimentary access flows everywhere paid Pro
-- flows — and nowhere else.
create or replace function public.sub_is_pro(
  p_user uuid,
  p_now timestamptz default now()
) returns boolean
language sql stable security definer set search_path = public as $$
  select public.sub_paid_is_pro(p_user, p_now)
      or public.sub_has_active_grant(p_user, p_now);
$$;

-- ============ ACCESS SOURCE (display provenance) =================
-- Which source currently makes the user Pro — precedence:
-- paid -> owner -> admin -> promo -> trial -> free. Display and
-- diagnostics only; enforcement never consults this function.
create or replace function public.access_source(
  p_user uuid,
  p_now timestamptz default now()
) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if public.sub_paid_is_pro(p_user, p_now) then
    return 'paid';
  end if;
  return coalesce((
    select g.source
    from public.access_grants g
    where g.user_id = p_user
      and g.revoked_at is null
      and g.starts_at <= p_now
      and (g.expires_at is null or p_now < g.expires_at)
    order by case g.source
      when 'owner' then 0 when 'admin' then 1
      when 'promo' then 2 else 3 end
    limit 1
  ), 'free');
end;
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
  v_source text;
  v_grant_exp timestamptz;
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

  v_source := public.access_source(v_user, p_now);
  if v_source in ('owner', 'admin', 'promo', 'trial') then
    select (case when bool_or(g.expires_at is null) then null
                 else max(g.expires_at) end)
      into v_grant_exp
      from public.access_grants g
     where g.user_id = v_user
       and g.revoked_at is null
       and g.starts_at <= p_now
       and (g.expires_at is null or p_now < g.expires_at);
  end if;

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
    ) end,
    'access_source', v_source,
    'access_expires_at', v_grant_exp
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

-- ============ ACCESS GRANTS: RPCs (access-grants-v1) ========
-- ============ REDEEM A PROMO CODE (self-only) ====================
-- The target is ALWAYS auth.uid() — there is no parameter that
-- could name another user. Stacking with a paid subscription or
-- another grant is ALLOWED (Karandeep decision 1, 2026-10-19): the
-- grant is created alongside whatever else applies and never
-- touches Stripe state. Every failure returns the identical
-- {ok:false, error:'promo_invalid'} payload; the distinguishing
-- reason is written to the audit log only.
create or replace function public.redeem_promo_code(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz := now();
  v_norm text;
  v_hash text;
  v_code public.promo_codes%rowtype;
  v_failed integer;
  v_reason text;
  v_user_redemptions integer;
  v_total_redemptions integer;
  v_grant_id uuid;
  v_expires timestamptz;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'promo_invalid');
  end if;

  -- Throttle FIRST, before any lookup work: at most 10 failed
  -- attempts per user per rolling hour (decision 2). Throttled
  -- attempts are also logged as failures, so continued hammering
  -- keeps the window saturated — the lockout lifts one hour after
  -- attempts stop. NOTE the deliberate semantic: the 11th attempt
  -- fails even when the code presented is valid.
  select count(*) into v_failed
    from public.access_audit_log
   where actor_user_id = v_user
     and action = 'redeem_failed'
     and created_at > v_now - interval '1 hour';
  if v_failed >= 10 then
    insert into public.access_audit_log (actor_user_id, action, detail)
    values (v_user, 'redeem_failed', jsonb_build_object('reason', 'throttled'));
    return jsonb_build_object('ok', false, 'error', 'promo_invalid');
  end if;

  v_norm := upper(trim(coalesce(p_code, '')));
  v_hash := encode(sha256(v_norm::bytea), 'hex');

  select * into v_code from public.promo_codes where code_hash = v_hash;
  if not found then
    v_reason := 'unknown_code';
  elsif not v_code.active then
    v_reason := 'inactive';
  elsif v_code.expires_at is not null and v_now >= v_code.expires_at then
    v_reason := 'code_expired';
  end if;

  if v_reason is null then
    -- Serialize redeemers of THIS code (same advisory-lock pattern
    -- as sub_consume) so concurrent redemptions cannot both slip
    -- under max_redemptions; caps are checked against fresh counts
    -- read under the lock.
    perform pg_advisory_xact_lock(hashtext('promo:' || v_code.id::text));
    select count(*) into v_total_redemptions
      from public.promo_redemptions where code_id = v_code.id;
    select count(*) into v_user_redemptions
      from public.promo_redemptions
     where code_id = v_code.id and user_id = v_user;
    if v_code.max_redemptions is not null
       and v_total_redemptions >= v_code.max_redemptions then
      v_reason := 'exhausted';
    elsif v_user_redemptions >= v_code.per_user_limit then
      v_reason := 'per_user_limit';
    end if;
  end if;

  if v_reason is not null then
    insert into public.access_audit_log
      (actor_user_id, action, promo_code_id, detail)
    values (v_user, 'redeem_failed', v_code.id,
            jsonb_build_object('reason', v_reason));
    return jsonb_build_object('ok', false, 'error', 'promo_invalid');
  end if;

  v_expires := v_now + make_interval(days => v_code.duration_days);
  insert into public.access_grants
    (user_id, source, starts_at, expires_at, created_by, promo_code_id, note)
  values (v_user, 'promo', v_now, v_expires, null, v_code.id, v_code.label)
  returning id into v_grant_id;

  insert into public.promo_redemptions (code_id, user_id, grant_id)
  values (v_code.id, v_user, v_grant_id);

  update public.promo_codes
     set redeemed_count = v_total_redemptions + 1
   where id = v_code.id;

  insert into public.access_audit_log
    (actor_user_id, action, target_user_id, grant_id, promo_code_id, detail)
  values (v_user, 'redeem', v_user, v_grant_id, v_code.id,
          jsonb_build_object('label', v_code.label, 'expires_at', v_expires));

  return jsonb_build_object(
    'ok', true, 'source', 'promo',
    'grant_id', v_grant_id, 'expires_at', v_expires);
end;
$$;

-- ============ ADMIN: GRANT / REVOKE ==============================
-- Both REQUIRE is_app_admin() for the caller. There is no path —
-- here or anywhere — that creates source='owner' rows or admins;
-- owner grants and the first admin are seeded via the SQL editor.
create or replace function public.admin_grant_access(
  p_target_user uuid,
  p_source text,
  p_duration_days integer default null,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_id uuid;
begin
  if not public.is_app_admin() then
    raise exception 'forbidden: admin access required' using errcode = '42501';
  end if;
  if p_source not in ('admin', 'trial') then
    raise exception 'admin_grant_access: source must be ''admin'' or ''trial'' (owner grants are seeded via SQL only; promo grants come only from redemption)';
  end if;
  if p_duration_days is not null and p_duration_days <= 0 then
    raise exception 'admin_grant_access: duration_days must be positive, or null for permanent';
  end if;
  if not exists (select 1 from auth.users where id = p_target_user) then
    raise exception 'admin_grant_access: target user does not exist';
  end if;
  insert into public.access_grants
    (user_id, source, starts_at, expires_at, created_by, note)
  values (p_target_user, p_source, v_now,
          case when p_duration_days is null then null
               else v_now + make_interval(days => p_duration_days) end,
          v_actor, p_note)
  returning id into v_id;
  insert into public.access_audit_log
    (actor_user_id, action, target_user_id, grant_id, detail)
  values (v_actor, 'grant', p_target_user, v_id,
          jsonb_build_object('source', p_source,
                             'duration_days', p_duration_days,
                             'note', p_note));
  return v_id;
end;
$$;

-- Revocation preserves the row (and history) — it only stamps
-- revoked_at, which the live-grant predicate reads. Owner grants
-- are refused HERE (with the refusal audit-logged in the same
-- transaction) and, independently, by the guard trigger above if
-- any other path ever attempts the update.
create or replace function public.admin_revoke_grant(p_grant_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_grant public.access_grants%rowtype;
begin
  if not public.is_app_admin() then
    raise exception 'forbidden: admin access required' using errcode = '42501';
  end if;
  select * into v_grant from public.access_grants where id = p_grant_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'grant_not_found');
  end if;
  if v_grant.source = 'owner' then
    insert into public.access_audit_log
      (actor_user_id, action, target_user_id, grant_id, detail)
    values (v_actor, 'revoke', v_grant.user_id, v_grant.id,
            jsonb_build_object('result', 'refused_owner_grant'));
    return jsonb_build_object('ok', false, 'error', 'owner_grant_protected');
  end if;
  if v_grant.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_revoked');
  end if;
  update public.access_grants set revoked_at = now() where id = p_grant_id;
  insert into public.access_audit_log
    (actor_user_id, action, target_user_id, grant_id, detail)
  values (v_actor, 'revoke', v_grant.user_id, v_grant.id,
          jsonb_build_object('source', v_grant.source));
  return jsonb_build_object('ok', true, 'grant_id', p_grant_id);
end;
$$;

-- ============ ADMIN: PROMO CODES =================================
-- Only the sha-256 hash of the normalized code is stored; the
-- plaintext exists in this call and nowhere else, ever. Codes must
-- be >= 10 chars of [A-Z0-9_-] after normalization — generate them
-- long and random (12+ chars recommended).
create or replace function public.admin_create_promo(
  p_code text,
  p_label text,
  p_duration_days integer,
  p_max_redemptions integer default null,
  p_per_user_limit integer default 1,
  p_expires_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_norm text := upper(trim(coalesce(p_code, '')));
  v_id uuid;
begin
  if not public.is_app_admin() then
    raise exception 'forbidden: admin access required' using errcode = '42501';
  end if;
  if v_norm !~ '^[A-Z0-9][A-Z0-9_-]{9,63}$' then
    raise exception 'admin_create_promo: code must be 10-64 chars of A-Z, 0-9, dash, underscore';
  end if;
  if p_duration_days is null or p_duration_days <= 0 then
    raise exception 'admin_create_promo: duration_days must be positive';
  end if;
  if p_max_redemptions is not null and p_max_redemptions <= 0 then
    raise exception 'admin_create_promo: max_redemptions must be positive or null (unlimited)';
  end if;
  if p_per_user_limit is null or p_per_user_limit <= 0 then
    raise exception 'admin_create_promo: per_user_limit must be positive';
  end if;
  insert into public.promo_codes
    (code_hash, label, duration_days, expires_at, max_redemptions,
     per_user_limit, created_by)
  values (encode(sha256(v_norm::bytea), 'hex'), p_label, p_duration_days,
          p_expires_at, p_max_redemptions, p_per_user_limit, v_actor)
  returning id into v_id;
  insert into public.access_audit_log
    (actor_user_id, action, promo_code_id, detail)
  values (v_actor, 'promo_create', v_id,
          jsonb_build_object('label', p_label,
                             'duration_days', p_duration_days,
                             'max_redemptions', p_max_redemptions,
                             'per_user_limit', p_per_user_limit,
                             'expires_at', p_expires_at));
  return v_id;
end;
$$;

-- Deactivation stops NEW redemptions only. Grants already redeemed
-- keep running to their own expiry — clawing one back is an
-- explicit per-grant revoke, never a side effect.
create or replace function public.admin_deactivate_promo(p_code_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_hit boolean;
begin
  if not public.is_app_admin() then
    raise exception 'forbidden: admin access required' using errcode = '42501';
  end if;
  update public.promo_codes set active = false
   where id = p_code_id and active;
  v_hit := found;
  if v_hit then
    insert into public.access_audit_log
      (actor_user_id, action, promo_code_id, detail)
    values (v_actor, 'promo_deactivate', p_code_id, '{}'::jsonb);
  end if;
  return v_hit;
end;
$$;

-- ============ ADMIN: READ HELPERS (admin-gated) ==================
create or replace function public.admin_list_grants(
  p_target_user uuid default null
) returns setof public.access_grants
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_app_admin() then
    raise exception 'forbidden: admin access required' using errcode = '42501';
  end if;
  return query
    select * from public.access_grants
     where p_target_user is null or user_id = p_target_user
     order by created_at desc
     limit 500;
end;
$$;

create or replace function public.admin_list_promos()
returns setof public.promo_codes
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_app_admin() then
    raise exception 'forbidden: admin access required' using errcode = '42501';
  end if;
  return query
    select * from public.promo_codes order by created_at desc limit 500;
end;
$$;

create or replace function public.admin_read_audit(
  p_limit integer default 100
) returns setof public.access_audit_log
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_app_admin() then
    raise exception 'forbidden: admin access required' using errcode = '42501';
  end if;
  return query
    select * from public.access_audit_log
     order by created_at desc
     limit least(greatest(coalesce(p_limit, 100), 1), 1000);
end;
$$;

-- ============ GRANTS =============================================
-- User-facing RPCs: EXECUTE for authenticated only (anon revoked —
-- Supabase default privileges would otherwise grant both). Admin
-- RPCs self-check is_app_admin() internally, so the EXECUTE grant
-- alone confers nothing. Internal helpers are revoked from every
-- API role and run only inside other definer functions, mirroring
-- the subscriptions-v1 pattern. usage_status keeps its existing
-- grant (CREATE OR REPLACE preserves it); it is re-asserted here
-- for clarity.
revoke all on function public.is_app_admin() from public, anon;
grant execute on function public.is_app_admin() to authenticated;
revoke all on function public.redeem_promo_code(text) from public, anon;
grant execute on function public.redeem_promo_code(text) to authenticated;
revoke all on function public.admin_grant_access(uuid, text, integer, text) from public, anon;
grant execute on function public.admin_grant_access(uuid, text, integer, text) to authenticated;
revoke all on function public.admin_revoke_grant(uuid) from public, anon;
grant execute on function public.admin_revoke_grant(uuid) to authenticated;
revoke all on function public.admin_create_promo(text, text, integer, integer, integer, timestamptz) from public, anon;
grant execute on function public.admin_create_promo(text, text, integer, integer, integer, timestamptz) to authenticated;
revoke all on function public.admin_deactivate_promo(uuid) from public, anon;
grant execute on function public.admin_deactivate_promo(uuid) to authenticated;
revoke all on function public.admin_list_grants(uuid) from public, anon;
grant execute on function public.admin_list_grants(uuid) to authenticated;
revoke all on function public.admin_list_promos() from public, anon;
grant execute on function public.admin_list_promos() to authenticated;
revoke all on function public.admin_read_audit(integer) from public, anon;
grant execute on function public.admin_read_audit(integer) to authenticated;
grant execute on function public.usage_status(timestamptz) to authenticated;
-- Internal helpers: owner-only, exactly like sub_consume et al.
revoke all on function public.sub_paid_is_pro(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.sub_has_active_grant(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.access_source(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.access_grants_guard() from public, anon, authenticated;
