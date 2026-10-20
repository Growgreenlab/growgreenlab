-- Access Grants v1 (branch feature/access-grants)
-- *** PREPARED ONLY — NOT APPLIED ***
-- This file has NOT been run against any database except the local
-- PGlite SQL harness. Applying it waits for Karandeep's explicit
-- approval of the final verification report (paste into the Supabase
-- SQL editor AFTER subscriptions-v1.sql, which is already live).
-- Design: ~/workspace/growgreenlab-owner-access-audit-2026-10-19.md §7
-- (approved 2026-10-19 with the amendments noted below).
--
-- What this adds — complimentary access WITHOUT a second billing
-- system and WITHOUT ever touching Stripe state:
--   * public.access_grants — owner/admin/promo/trial grants. The
--     ONLY behavioral change to entitlement: sub_is_pro() keeps its
--     name, signature and paid-status map VERBATIM (factored into
--     sub_paid_is_pro below) and ORs in "has a live grant". Every
--     quota trigger, RPC, counter and client gate already consults
--     sub_is_pro / usage_status, so nothing else changes.
--   * public.promo_codes — codes stored ONLY as sha-256 hashes.
--   * public.promo_redemptions — one row per successful redemption.
--   * public.app_admins — who may grant/revoke/create promos. RLS on,
--     NO policies: no client can read or write it. The first admin is
--     seeded via the SQL editor at deploy time (see
--     docs/subscriptions-release-checklist.md, "Access grants"
--     section). There is deliberately NO function, RPC or UI path
--     that creates an admin — self-promotion is impossible by
--     construction (the community-v1 lesson, audit §2).
--   * public.access_audit_log — append-only evidence, written in the
--     same transaction as every grant / revoke / redeem action.
--
-- Karandeep's binding decisions (2026-10-19):
--   1. STACKING IS ALLOWED (this OVERRIDES audit §7.3/§7.5's
--      refuse-when-paid proposal): redeeming a promo while a paid
--      subscription is active succeeds and creates the grant. Grants
--      NEVER modify, cancel, extend or replace Stripe billing or
--      renewal dates — they live only in access_grants, and the
--      webhook can never touch them (grants are never rows in
--      public.subscriptions).
--   2. Failed-redemption throttle: 10 failed attempts per user per
--      rolling hour, enforced inside redeem_promo_code BEFORE any
--      code lookup. Throttled attempts are themselves logged as
--      failures, so sustained hammering keeps the window saturated;
--      the lockout lifts one hour after the attempts stop. The 11th
--      attempt inside the window fails with the SAME generic error —
--      even if the code presented is valid.
--   3. Owner access is structural, not a convention: source='owner'
--      rows must have expires_at NULL (CHECK), the revoke RPC
--      refuses them, and a BEFORE UPDATE trigger raises if ANY path
--      tries to set revoked_at (or change source/user) on an owner
--      row. Removing owner access requires a deliberate SQL-editor
--      DELETE — the documented escape hatch.
--   4. Expiry / revocation are READ-TIME evaluations. Nothing is
--      ever deleted or rewritten when access ends; the user simply
--      falls back to whatever else applies (paid sub, another grant,
--      or Free). Usage-ledger history is never re-counted.
--   5. NO SEED DATA in this file. The repo is PUBLIC: no user ids,
--      no emails. Owner/admin seeding is a separate one-time
--      SQL-editor step at deploy time (checklist §Access grants).
--
-- Failure indistinguishability (redeem): EVERY failure — signed
-- out, throttled, unknown code, inactive code, expired code,
-- exhausted cap, per-user limit — returns the identical payload
-- {ok:false, error:'promo_invalid'}. Internal reasons are recorded
-- in access_audit_log only, where callers cannot read them.
--
-- Rollback: supabase/migrations/access-grants-v1.rollback.sql
-- (restores the original sub_is_pro / usage_status bodies verbatim
-- and drops everything this file creates). Soft rollback: revoke
-- all non-owner grants — complimentary access ends, paid behavior
-- is untouched.

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

-- ============ READ MODEL: USAGE STATUS (extended, additive) ======
-- The subscriptions-v1 body VERBATIM plus two new keys —
-- access_source and access_expires_at. Every pre-existing key,
-- type and value is unchanged; existing clients ignore unknown
-- keys, and loadEntitlement's shape checks still pass. When Pro
-- comes from a grant, access_expires_at is the moment grant-based
-- access fully ends (the latest expiry among live grants); it is
-- null when access is paid, permanent (any live grant with no
-- expiry), or absent.
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
