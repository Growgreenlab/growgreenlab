-- Community v4: Market-based architecture
-- Adds room categories, message topics/titles for discussions
-- Reuses existing message model — no separate discussion table

-- ============================================================
-- Room categories for landing page organization
-- ============================================================
alter table public.community_rooms
  add column if not exists category text not null default 'markets';

-- ============================================================
-- Message topics and discussion titles
-- topic: lightweight filter label (e.g. 'HOD Breakouts')
-- title: set when user starts a formal discussion
-- ============================================================
alter table public.community_messages
  add column if not exists topic text,
  add column if not exists title text check (title is null or char_length(title) between 1 and 200);

create index if not exists community_messages_room_topic_idx
  on public.community_messages (room_id, topic, created_at desc);

-- ============================================================
-- Seed market rooms
-- ============================================================
insert into public.community_rooms (name, slug, description, category, is_public)
values
  ('Penny Stocks', 'penny-stocks', 'Penny stock breakouts, premarket movers, low float plays', 'markets', true),
  ('Stock Market', 'stock-market', 'Large/mid cap stocks, earnings, swing trading', 'markets', true),
  ('Options Trading', 'options-trading', 'Calls, puts, strategies, Greeks, expiration plays', 'markets', true),
  ('Futures Trading', 'futures-trading', 'Index futures, price action, scalping', 'markets', true),
  ('Forex', 'forex', 'Currency pairs, economic events, FX technicals', 'markets', true),
  ('Crypto', 'crypto', 'Bitcoin, altcoins, crypto market trends', 'markets', true),
  ('Trading Psychology', 'trading-psychology', 'Mindset, discipline, emotional control', 'community', true),
  ('Trading Education', 'trading-education', 'Learn strategies, concepts, and market mechanics', 'community', true),
  ('Beginners', 'beginners', 'New trader questions and guidance', 'community', true),
  ('Announcements', 'announcements', 'Official Grow Green Lab updates', 'community', true)
on conflict (slug) do nothing;

-- Organize existing rooms
update public.community_rooms set category = 'community', name = 'General Discussion'
  where slug = 'general';
update public.community_rooms set category = 'markets'
  where slug = 'premarket';
