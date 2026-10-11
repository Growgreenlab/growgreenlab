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
