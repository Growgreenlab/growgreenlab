-- Grow Green Lab Community v1
-- Rooms, messages, reactions, membership, moderation

-- ============ ROOMS ============
create table if not exists public.community_rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text default '',
  ticker text, -- null for general rooms, e.g. 'VEEA' for per-ticker rooms
  is_public boolean not null default true,
  message_preview boolean not null default true, -- unauth visitors can read messages
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ============ MESSAGES ============
create table if not exists public.community_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.community_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 2000),
  reply_to uuid references public.community_messages(id) on delete set null,
  is_edited boolean not null default false,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists community_messages_room_idx on public.community_messages (room_id, created_at desc);

-- ============ REACTIONS ============
create table if not exists public.community_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.community_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);

-- ============ MEMBERS / ROLES ============
create table if not exists public.community_members (
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.community_rooms(id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'moderator', 'admin')),
  joined_at timestamptz not null default now(),
  primary key (user_id, room_id)
);

-- ============ BANS ============
create table if not exists public.community_bans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid references public.community_rooms(id) on delete cascade, -- null = global ban
  reason text default '',
  banned_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (user_id, room_id)
);

-- ============ RLS ============
alter table public.community_rooms enable row level security;
alter table public.community_messages enable row level security;
alter table public.community_reactions enable row level security;
alter table public.community_members enable row level security;
alter table public.community_bans enable row level security;

-- Helper: is the user a mod/admin of a room (or global admin)?
create or replace function public.community_is_mod(p_room_id uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.community_members
    where user_id = auth.uid()
      and (room_id = p_room_id or room_id = '00000000-0000-0000-0000-000000000000')
      and role in ('moderator', 'admin')
  );
$$;

-- Helper: is the user banned from a room (or globally)?
create or replace function public.community_is_banned(p_room_id uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.community_bans
    where user_id = auth.uid()
      and (room_id = p_room_id or room_id is null)
  );
$$;

-- ROOMS: everyone can read; only global admins can write
create policy "rooms_public_read" on public.community_rooms
  for select using (true);
create policy "rooms_admin_write" on public.community_rooms
  for all using (
    exists (select 1 from public.community_members
      where user_id = auth.uid()
        and room_id = '00000000-0000-0000-0000-000000000000'
        and role = 'admin')
  );

-- MESSAGES: read public rooms (if preview enabled); write only signed-in, not banned
create policy "messages_read" on public.community_messages
  for select using (
    exists (select 1 from public.community_rooms r
      where r.id = room_id and r.is_public and r.message_preview)
    or
    exists (select 1 from public.community_members m
      where m.user_id = auth.uid() and m.room_id = community_messages.room_id)
    or
    public.community_is_mod(room_id)
  );
create policy "messages_insert" on public.community_messages
  for insert with check (
    auth.uid() is not null
    and auth.uid() = user_id
    and not public.community_is_banned(room_id)
    and (
      exists (select 1 from public.community_rooms r where r.id = room_id and r.is_public)
      or exists (select 1 from public.community_members m
        where m.user_id = auth.uid() and m.room_id = community_messages.room_id)
    )
  );
create policy "messages_update" on public.community_messages
  for update using (
    (auth.uid() = user_id and not public.community_is_banned(room_id))
    or public.community_is_mod(room_id)
  );
create policy "messages_delete" on public.community_messages
  for delete using (
    auth.uid() = user_id
    or public.community_is_mod(room_id)
  );

-- REACTIONS: read public; write only signed-in, not banned
create policy "reactions_read" on public.community_reactions
  for select using (true);
create policy "reactions_insert" on public.community_reactions
  for insert with check (
    auth.uid() is not null
    and auth.uid() = user_id
    and exists (select 1 from public.community_messages m
      where m.id = message_id and not public.community_is_banned(m.room_id))
  );
create policy "reactions_delete" on public.community_reactions
  for delete using (auth.uid() = user_id);

-- MEMBERS: users can see membership; join public rooms themselves; mods manage
create policy "members_read" on public.community_members
  for select using (true);
create policy "members_join_public" on public.community_members
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.community_rooms r
      where r.id = room_id and r.is_public)
  );
create policy "members_mod_manage" on public.community_members
  for all using (public.community_is_mod(room_id));

-- BANS: only mods can read/write
create policy "bans_mod_only" on public.community_bans
  for all using (
    public.community_is_mod(room_id)
    or (room_id is null and public.community_is_mod('00000000-0000-0000-0000-000000000000'))
  );

-- Seed default rooms
insert into public.community_rooms (name, slug, description, ticker, is_public)
values
  ('General', 'general', 'General trading discussion', null, true),
  ('Premarket Watch', 'premarket', 'Premarket movers and watchlists', null, true)
on conflict (slug) do nothing;
