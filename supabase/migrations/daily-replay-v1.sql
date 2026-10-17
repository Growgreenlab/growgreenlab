-- Daily Replay v1 (branch daily-replay)
-- *** PREPARED ONLY — NOT APPLIED ***
-- This file has NOT been run against any database. Applying it waits
-- for Karandeep's explicit authorization (paste into the Supabase SQL
-- editor, per DEPLOY.md). It is additive: three new tables + five
-- security-definer functions; no existing table, policy, or function
-- is touched.
--
-- Design — server-sealed candles:
--   daily_replay_datasets          per-user dataset registry (RLS: owner
--                                  select + insert, like the journal tables)
--   daily_replay_dataset_candles   the full candle array as jsonb.
--                                  RLS is ENABLED WITH NO POLICIES AT ALL:
--                                  direct PostgREST access is denied for
--                                  everyone. The only way in or out is the
--                                  security-definer dr_* functions below.
--   daily_replay_attempts          one locked replay attempt. RLS owner
--                                  SELECT only — there is deliberately NO
--                                  insert/update/delete policy, so a client
--                                  can never write its own position. All
--                                  mutations happen inside the dr_*
--                                  functions, which check ownership and
--                                  clamp the position server-side.
--
-- Candle format: jsonb array of {t,o,h,l,c,v} objects in engine order
-- (epoch-ms timestamps, chronological) — the same shape replay_sessions
-- stores. Slicing by index uses jsonb_array_elements WITH ORDINALITY;
-- at <= ~960 candles per dataset this is comfortably fast.

-- ============ DATASETS ============
create table if not exists public.daily_replay_datasets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  trade_date date not null,
  timeframe int not null default 1, -- minutes per candle
  source text not null default 'twelvedata',
  candle_count int not null check (candle_count > 0),
  created_at timestamptz not null default now()
);
create index if not exists daily_replay_datasets_user_idx
  on public.daily_replay_datasets (user_id, trade_date desc);

alter table public.daily_replay_datasets enable row level security;

drop policy if exists dr_datasets_select_own on public.daily_replay_datasets;
create policy dr_datasets_select_own on public.daily_replay_datasets
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists dr_datasets_insert_own on public.daily_replay_datasets;
create policy dr_datasets_insert_own on public.daily_replay_datasets
  for insert to authenticated
  with check (auth.uid() = user_id);

-- ============ DATASET CANDLES (sealed — no policies, on purpose) ============
create table if not exists public.daily_replay_dataset_candles (
  dataset_id uuid primary key
    references public.daily_replay_datasets(id) on delete cascade,
  candles jsonb not null
);

alter table public.daily_replay_dataset_candles enable row level security;
-- NO POLICIES ARE CREATED FOR THIS TABLE. With RLS enabled and zero
-- policies, PostgREST denies every direct read/write to anon and
-- authenticated roles. Only the security-definer functions below
-- (running as the table owner) can touch it. Do not add a policy here
-- without re-auditing the Daily Replay sealing model.

-- ============ ATTEMPTS ============
create table if not exists public.daily_replay_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dataset_id uuid not null
    references public.daily_replay_datasets(id) on delete cascade,
  start_index int not null check (start_index >= 0),
  position int not null check (position >= 0),
  status text not null default 'active'
    check (status in ('active', 'finished', 'abandoned')),
  starting_balance numeric not null default 100000,
  -- Journal link: the replay_sessions row saved when the attempt
  -- finished. Set only by dr_finish_attempt.
  session_id uuid references public.replay_sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists daily_replay_attempts_user_idx
  on public.daily_replay_attempts (user_id, created_at desc);

alter table public.daily_replay_attempts enable row level security;

drop policy if exists dr_attempts_select_own on public.daily_replay_attempts;
create policy dr_attempts_select_own on public.daily_replay_attempts
  for select to authenticated
  using (auth.uid() = user_id);
-- NO insert/update/delete policies: attempts are created, advanced, and
-- finished exclusively inside the dr_* functions below.

-- ============ HELPERS ============
-- Shared ownership loader for the attempt functions. Not granted to
-- anyone: callable only from inside the security-definer functions.
create or replace function public.dr_attempt_for_owner(p_attempt_id uuid)
returns public.daily_replay_attempts
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt public.daily_replay_attempts;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select * into v_attempt
  from public.daily_replay_attempts
  where id = p_attempt_id;
  if not found then
    raise exception 'attempt not found';
  end if;
  if v_attempt.user_id <> auth.uid() then
    raise exception 'permission denied: not your attempt';
  end if;
  return v_attempt;
end;
$$;
revoke all on function public.dr_attempt_for_owner(uuid) from public;

-- ============ UPLOAD ============
-- Stores the full candle array for a dataset the caller owns. Goes
-- through this function so the candles table needs no insert policy.
create or replace function public.dr_upload_candles(
  p_dataset_id uuid,
  p_candles jsonb
)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_expected int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select user_id, candle_count into v_owner, v_expected
  from public.daily_replay_datasets
  where id = p_dataset_id;
  if not found then
    raise exception 'dataset not found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'permission denied: not your dataset';
  end if;
  if p_candles is null or jsonb_typeof(p_candles) <> 'array' then
    raise exception 'candles must be a jsonb array';
  end if;
  if jsonb_array_length(p_candles) <> v_expected then
    raise exception 'candle count mismatch: dataset declares %, upload has %',
      v_expected, jsonb_array_length(p_candles);
  end if;
  insert into public.daily_replay_dataset_candles (dataset_id, candles)
  values (p_dataset_id, p_candles)
  on conflict (dataset_id) do update set candles = excluded.candles;
end;
$$;

-- ============ CREATE ATTEMPT ============
-- Locks the starting candle. Position starts AT the locked candle and
-- the caller receives only candles [0..start_index]: history before the
-- start plus the starting candle itself. Nothing later exists in the
-- response — that is the seal.
create or replace function public.dr_create_attempt(
  p_dataset_id uuid,
  p_start_index int
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
    (user_id, dataset_id, start_index, position)
  values
    (auth.uid(), p_dataset_id, p_start_index, p_start_index)
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

-- ============ ADVANCE ============
-- The ONLY way a position moves. Steps are clamped to [1, 60] and the
-- new position to the last candle; the response carries only the newly
-- revealed candles (old position + 1 .. new position).
create or replace function public.dr_advance_attempt(
  p_attempt_id uuid,
  p_steps int
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt public.daily_replay_attempts;
  v_count int;
  v_candles jsonb;
  v_steps int;
  v_new_position int;
  v_new_candles jsonb;
begin
  v_attempt := public.dr_attempt_for_owner(p_attempt_id);
  if v_attempt.status <> 'active' then
    raise exception 'attempt is not active';
  end if;

  select candle_count into v_count
  from public.daily_replay_datasets
  where id = v_attempt.dataset_id;
  select candles into v_candles
  from public.daily_replay_dataset_candles
  where dataset_id = v_attempt.dataset_id;
  if v_candles is null then
    raise exception 'dataset candles not uploaded';
  end if;

  v_steps := least(60, greatest(1, coalesce(p_steps, 1)));
  v_new_position := least(v_attempt.position + v_steps, v_count - 1);

  if v_new_position > v_attempt.position then
    update public.daily_replay_attempts
    set position = v_new_position
    where id = p_attempt_id;
  end if;

  select coalesce(jsonb_agg(e.elem order by e.idx), '[]'::jsonb)
  into v_new_candles
  from (
    select elem, (ord - 1) as idx
    from jsonb_array_elements(v_candles) with ordinality as t(elem, ord)
  ) e
  where e.idx > v_attempt.position and e.idx <= v_new_position;

  return jsonb_build_object(
    'position', v_new_position,
    'candles', v_new_candles,
    'finished', v_new_position >= v_count - 1
  );
end;
$$;

-- ============ GET REVEALED (resume / re-sync) ============
create or replace function public.dr_get_revealed(p_attempt_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt public.daily_replay_attempts;
  v_candles jsonb;
  v_prefix jsonb;
begin
  v_attempt := public.dr_attempt_for_owner(p_attempt_id);
  select candles into v_candles
  from public.daily_replay_dataset_candles
  where dataset_id = v_attempt.dataset_id;
  if v_candles is null then
    raise exception 'dataset candles not uploaded';
  end if;

  select coalesce(jsonb_agg(e.elem order by e.idx), '[]'::jsonb)
  into v_prefix
  from (
    select elem, (ord - 1) as idx
    from jsonb_array_elements(v_candles) with ordinality as t(elem, ord)
  ) e
  where e.idx <= v_attempt.position;

  return jsonb_build_object(
    'position', v_attempt.position,
    'candles', v_prefix
  );
end;
$$;

-- ============ FINISH ============
create or replace function public.dr_finish_attempt(
  p_attempt_id uuid,
  p_session_id uuid
)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt public.daily_replay_attempts;
begin
  v_attempt := public.dr_attempt_for_owner(p_attempt_id);
  if v_attempt.status <> 'active' then
    raise exception 'attempt is not active';
  end if;
  update public.daily_replay_attempts
  set status = 'finished',
      finished_at = now(),
      session_id = p_session_id
  where id = p_attempt_id;
  return p_attempt_id;
end;
$$;

-- ============ GRANTS ============
revoke all on function public.dr_upload_candles(uuid, jsonb) from public;
revoke all on function public.dr_create_attempt(uuid, int) from public;
revoke all on function public.dr_advance_attempt(uuid, int) from public;
revoke all on function public.dr_get_revealed(uuid) from public;
revoke all on function public.dr_finish_attempt(uuid, uuid) from public;

grant execute on function public.dr_upload_candles(uuid, jsonb) to authenticated;
grant execute on function public.dr_create_attempt(uuid, int) to authenticated;
grant execute on function public.dr_advance_attempt(uuid, int) to authenticated;
grant execute on function public.dr_get_revealed(uuid) to authenticated;
grant execute on function public.dr_finish_attempt(uuid, uuid) to authenticated;
