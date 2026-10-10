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
