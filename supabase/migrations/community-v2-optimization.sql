-- Grow Green Lab Community v2: Performance Optimization
-- Message retention, indexes, cleanup function

-- ============ INDEXES ============
-- Speed up reaction lookups per message
create index if not exists community_reactions_message_idx
  on public.community_reactions (message_id);

-- Speed up reply preview lookups
create index if not exists community_messages_reply_idx
  on public.community_messages (reply_to)
  where reply_to is not null;

-- Speed up retention cleanup (already have room+created index, add standalone created_at)
create index if not exists community_messages_created_idx
  on public.community_messages (created_at);

-- Speed up ban checks
create index if not exists community_bans_user_idx
  on public.community_bans (user_id);

-- ============ MESSAGE RETENTION ============
-- Configurable retention period (default 7 days)
-- Stored in a settings table so it can be changed without code deploys

create table if not exists public.community_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into public.community_settings (key, value)
values ('message_retention_days', '7')
on conflict (key) do nothing;

alter table public.community_settings enable row level security;

-- Everyone can read settings; only global admins can change
create policy "settings_public_read" on public.community_settings
  for select using (true);
create policy "settings_admin_write" on public.community_settings
  for all using (
    exists (select 1 from public.community_members
      where user_id = auth.uid()
        and room_id = '00000000-0000-0000-0000-000000000000'
        and role = 'admin')
  );

-- Cleanup function: deletes messages older than retention period
-- Idempotent: safe to run multiple times, only deletes what matches
-- Cascades handle reactions (on delete cascade) and reply_to (on delete set null)
create or replace function public.community_cleanup_old_messages()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  retention_days integer;
  deleted_count integer;
begin
  -- Read retention setting, default 7 days
  select coalesce(nullif(value, '')::integer, 7) into retention_days
  from public.community_settings
  where key = 'message_retention_days';

  if retention_days is null then
    retention_days := 7;
  end if;

  -- Delete old messages (reactions cascade, reply_to set null automatically)
  delete from public.community_messages
  where created_at < now() - (retention_days || ' days')::interval;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- ============ ENABLE PG_CRON (if available) ============
-- Note: pg_cron must be enabled in Supabase dashboard under Database > Extensions
-- If pg_cron is available, uncomment to schedule daily cleanup at 3 AM UTC:
/*
select cron.schedule(
  'community-cleanup-daily',
  '0 3 * * *',
  $$select public.community_cleanup_old_messages()$$
);
*/

-- Manual cleanup can be run anytime via:
-- select public.community_cleanup_old_messages();
