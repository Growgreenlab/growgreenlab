-- Access Grants v1 — ROLLBACK
-- Undoes supabase/migrations/access-grants-v1.sql completely.
-- *** PREPARED ONLY — run only on Karandeep's explicit instruction ***
--
-- Effects:
--   1. sub_is_pro and usage_status are restored to their EXACT
--      subscriptions-v1 bodies (reproduced verbatim below, sourced
--      from supabase/migrations/subscriptions-v1.sql — the same
--      bodies also live in supabase/schema.sql).
--   2. Every object access-grants-v1 created is dropped: the admin
--      / redeem / helper functions, the owner-guard trigger, and
--      the five tables (app_admins, promo_codes, access_grants,
--      promo_redemptions, access_audit_log).
--   3. NOTHING else is touched: subscriptions, usage_ledger,
--      import_allowance, billing_customers and all user content are
--      byte-identical before and after. Grants were never rows in
--      public.subscriptions, so no Stripe state can be disturbed.
--
-- DATA WARNING: dropping the tables destroys the grants, promo
-- codes, redemptions and the audit log. If the audit trail must be
-- kept, export public.access_audit_log (and access_grants) BEFORE
-- running this file.
--
-- SOFTER ALTERNATIVE (no schema change): revoke every non-owner
-- grant and deactivate every promo code —
--   update public.access_grants set revoked_at = now()
--    where revoked_at is null and source <> 'owner';
--   update public.promo_codes set active = false;
-- Complimentary access ends immediately; the schema stays in place
-- for a later re-enable, and history is preserved.

-- ============ 1. RESTORE ORIGINAL FUNCTION BODIES ===============
-- Original sub_is_pro (subscriptions-v1.sql, verbatim):
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

-- Original usage_status (subscriptions-v1.sql, verbatim):
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

-- usage_status keeps the EXECUTE grant subscriptions-v1 gave it
-- (CREATE OR REPLACE preserves grants; restated for completeness):
grant execute on function public.usage_status(timestamptz) to authenticated;

-- ============ 2. DROP ACCESS-GRANTS OBJECTS =====================
drop trigger if exists trg_access_grants_guard on public.access_grants;
drop function if exists public.admin_read_audit(integer);
drop function if exists public.admin_list_promos();
drop function if exists public.admin_list_grants(uuid);
drop function if exists public.admin_deactivate_promo(uuid);
drop function if exists public.admin_create_promo(text, text, integer, integer, integer, timestamptz);
drop function if exists public.admin_revoke_grant(uuid);
drop function if exists public.admin_grant_access(uuid, text, integer, text);
drop function if exists public.redeem_promo_code(text);
drop function if exists public.access_source(uuid, timestamptz);
drop function if exists public.sub_has_active_grant(uuid, timestamptz);
drop function if exists public.sub_paid_is_pro(uuid, timestamptz);
drop function if exists public.is_app_admin();
drop function if exists public.access_grants_guard();
drop table if exists public.access_audit_log;
drop table if exists public.promo_redemptions;
drop table if exists public.access_grants;
drop table if exists public.promo_codes;
drop table if exists public.app_admins;
