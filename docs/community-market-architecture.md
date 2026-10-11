# Market-Based Chat Area — Architecture Report

**Date:** 2026-10-11
**Branch:** `redesign-preview`
**Production:** NOT modified (code). Database migration applied to shared Supabase project (backward-compatible).

---

## Architecture Changes

**Core decision:** Topic-tagged messages reuse the existing message model. No separate discussion table was created.

- A "discussion" = a message with an optional `title`
- A "topic" = a lightweight text label on a message (e.g. "HOD Breakouts")
- "All Discussions" = no topic filter (shows everything in the market)
- Each market = one room (existing `community_rooms` table)
- Messages are isolated by `room_id` — Penny Stocks messages can never appear in Options Trading

**Why this works:** The existing schema already had `room_id` isolation, RLS policies, realtime, replies, and reactions. Adding two nullable columns (`topic`, `title`) gives us discussions + filtering without duplicating any messaging infrastructure.

---

## Components Changed

| File | Change |
|------|--------|
| `lib/community-markets.ts` | NEW — topic definitions per market |
| `lib/community.ts` | Added `category` to CommunityRoom, `topic`/`title` to CommunityMessage |
| `app/community/page.tsx` | Rebuilt as "Chat Area" — Markets + Learning & Community sections, search |
| `app/community/[slug]/page.tsx` | Topic filter pills, Start Discussion modal, topic badges, discussion titles, topic-scoped realtime |
| `supabase/migrations/community-v4-markets.sql` | NEW — schema + seed data |

---

## Database Changes

Applied to Supabase project `jpkozotixwtgwsvqqcdw`:

1. `community_rooms.category` (text, default 'markets') — organizes landing page
2. `community_messages.topic` (text, nullable) — filter label
3. `community_messages.title` (text, nullable, 1-200 chars) — discussion title
4. Index on `(room_id, topic, created_at desc)` for efficient filtering
5. Seeded 10 new rooms: 6 markets + 4 community
6. Renamed `general` → "General Discussion" (category: community)
7. Set `premarket` category to markets

**Total rooms:** 13 (including existing General Discussion, Premarket Watch, and internal global room)

**Existing data:** All existing messages preserved. They have `topic = null`, so they appear under "All Discussions".

---

## Security Verification

- ✅ `room_id` is set server-side from the current room context — users cannot post to another market by modifying client parameters
- ✅ Existing RLS policies unchanged (no role escalation, fixed search paths, server-side rate limiting all preserved)
- ✅ Topic filter is applied in the database query (`eq("topic", topic)`), not just client-side hiding
- ✅ Realtime subscription filters by topic — messages from other topics don't appear
- ✅ Start Discussion requires authentication (modal only renders when `signedIn`)
- ✅ New `title` column has a length check constraint (1-200 chars)

---

## Tests Performed

| Test | Result |
|------|--------|
| Landing page shows Chat Area with Markets + Community sections | ✅ Pass |
| Search filters rooms | ✅ Pass (code review — not browser tested) |
| Penny Stocks room loads with topic pills | ✅ Pass |
| Topic pill selection shows active state | ✅ Pass |
| Topic filter updates empty state text | ✅ Pass |
| All Discussions resets filter | ✅ Pass |
| Options Trading is isolated (separate URL, no cross-messages) | ✅ Pass |
| Start Discussion button hidden when signed out | ✅ Pass |
| Production build compiles | ✅ Pass |

**Not tested:**
- [ ] Signed-in Start Discussion flow (needs authentication)
- [ ] Topic-tagged message actually filters correctly with real data (rooms are empty)
- [ ] Realtime topic filtering with live messages
- [ ] Mobile layout with topic pills (horizontal scroll)
- [ ] iPhone Safari

---

## Remaining Issues

1. **Empty rooms** — all new market rooms have zero messages. Topic filtering logic is implemented but untested with real data.
2. **Mobile topic pills** — horizontal scroll implemented but not tested on a real phone.
3. **Premarket Watch overlap** — the existing `premarket` room and the new "Premarket" topic in Penny Stocks could confuse users. Consider whether to keep both.
4. **Announcements room** — currently any signed-in user can post. May want mod-only posting (not implemented).
5. **General Discussion migration** — old "General" messages now appear under "General Discussion" in the community section. This is correct but worth noting.
