-- Community v5: admin-only posting rooms (Announcements)
-- Rooms flagged admin_only_posting accept inserts only from moderators/admins
-- (community_is_mod honors the global admin scope). Everyone can still read.
-- Approved by Karandeep 2026-10-12.

alter table public.community_rooms
  add column if not exists admin_only_posting boolean not null default false;

update public.community_rooms
  set admin_only_posting = true
  where slug = 'announcements';

-- messages_insert: v3 policy (auth + not banned + rate limit + public/member room)
-- plus: admin-only rooms require mod/admin.
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
    and (
      not exists (select 1 from public.community_rooms r
        where r.id = room_id and r.admin_only_posting)
      or public.community_is_mod(room_id)
    )
  );
