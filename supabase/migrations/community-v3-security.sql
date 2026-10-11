-- Community security hardening: role escalation, search_path, server-side rate limiting
-- Applied: 2026-10-11

-- ============================================================
-- FIX 1: Role escalation — members_join_public must force role='member'
-- ============================================================
drop policy if exists "members_join_public" on public.community_members;
create policy "members_join_public" on public.community_members
  for insert with check (
    auth.uid() = user_id
    and role = 'member'
    and exists (select 1 from public.community_rooms r
      where r.id = room_id and r.is_public)
  );

-- ============================================================
-- FIX 2: SECURITY DEFINER functions need fixed search_path
-- ============================================================
create or replace function public.community_is_mod(p_room_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.community_members
    where user_id = auth.uid()
      and (room_id = p_room_id or room_id = '00000000-0000-0000-0000-000000000000')
      and role in ('moderator', 'admin')
  );
$$;

create or replace function public.community_is_banned(p_room_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.community_bans
    where user_id = auth.uid()
      and (room_id = p_room_id or room_id is null)
  );
$$;

-- ============================================================
-- FIX 3: Server-side rate limiting — max 10 messages per 60 seconds
-- ============================================================
create or replace function public.community_check_rate_limit()
returns boolean
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  -- Allow if fewer than 10 messages in the last 60 seconds
  return (
    select count(*) < 10
    from public.community_messages
    where user_id = auth.uid()
      and created_at > now() - interval '60 seconds'
  );
end;
$$;

-- Add rate limit check to the messages_insert policy
drop policy if exists "messages_insert" on public.community_messages;
create policy "messages_insert" on public.community_messages
  for insert with check (
    auth.uid() is not null
    and auth.uid() = user_id
    and not public.community_is_banned(room_id)
    and public.community_check_rate_limit()
    and (
      exists (select 1 from public.community_rooms r where r.id = room_id and r.is_public)
      or exists (select 1 from public.community_members m
        where m.user_id = auth.uid() and m.room_id = community_messages.room_id)
    )
  );

-- Also fix the cleanup function search_path (was created without it)
create or replace function public.community_cleanup_old_messages()
returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  retention_days integer;
  deleted_count integer;
begin
  select message_retention_days into retention_days
  from public.community_settings limit 1;

  if retention_days is null then retention_days := 7; end if;

  delete from public.community_messages
  where created_at < now() - (retention_days || ' days')::interval;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
