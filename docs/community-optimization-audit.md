# Community Chat Optimization Audit

**Date:** 2026-10-11
**Branch:** `community-v1`
**Scope:** Audit existing implementation, optimize for low server load and low Supabase costs. No rebuild.

---

## What Already Worked

| Area | Status |
|------|--------|
| RLS policies (13 policies) | ✅ Enforced server-side, visitors read-only |
| Realtime scoped to active room | ✅ Single channel per room, unsubscribes on unmount |
| Message length limit (2000 chars) | ✅ DB check constraint + input maxLength |
| Auth-gated writes | ✅ RLS + frontend checks |
| Service role key | ✅ Never exposed to client |
| Room index `(room_id, created_at desc)` | ✅ Already existed |

---

## Issues Found and Fixed

### 1. N+1 Query Bomb (CRITICAL)

**Before:** Loading a room with 50 messages fired ~150+ database queries:
- 1 query for messages
- Up to 50 queries for author names (one per unique user, partially cached)
- Up to 50 queries for reply previews (one per message with reply_to)
- Up to 50 queries for reactions (one per message)
- Plus `auth.getUser()` called inside the reaction loop for every emoji

**After:** 4 queries total regardless of message count:
1. Messages (paginated, 50)
2. Author profiles (batched `.in()` for uncached users only)
3. Reply previews (batched `.in()`)
4. All reactions (single `.in(message_ids)` query)

**Expected impact:** ~97% reduction in database queries per room load. No specific cost savings claimed — actual Supabase billing depends on plan and usage patterns.

### 2. Full Reload on Every Event (HIGH)

**Before:** Every new message, reaction, edit, or delete triggered `loadMessages()` which re-fetched all messages + all N+1 queries.

**After:**
- New message → optimistic append + single-message enrich (deduplicated by ID)
- Reaction toggle → updates only that message's reactions locally
- Delete → removes from local state (realtime UPDATE also handles it)
- Realtime INSERT → appends single enriched message
- Realtime UPDATE → patches single message or removes if soft-deleted

### 3. No Pagination (MEDIUM)

**Before:** Loaded 200 messages with no way to load more.

**After:** Loads 50 latest. "Load older messages" button fetches previous 50 using cursor-based pagination (`created_at < oldest`). `hasOlder` flag hides button when exhausted.

### 4. No Rate Limiting (MEDIUM)

**Before:** No protection against rapid-fire sends.

**After:** 2-second client-side cooldown between messages. Note: this is UX-level only — server-side rate limiting would require a Postgres function or Edge Function. RLS still enforces auth.

### 5. No Message Retention (MEDIUM)

**Before:** Messages stored forever, unbounded table growth.

**After:**
- `community_settings` table with `message_retention_days` (default: 7)
- `community_cleanup_old_messages()` function — idempotent, uses `SECURITY DEFINER`
- Reactions cascade on delete; `reply_to` set to null automatically
- **Pending:** pg_cron scheduling (extension not installed — needs one-click enable in dashboard)

### 6. Missing Indexes (LOW)

Added:
- `community_reactions_message_idx` on `(message_id)`
- `community_messages_reply_idx` on `(reply_to)` partial
- `community_messages_created_idx` on `(created_at)` for cleanup
- `community_bans_user_idx` on `(user_id)` for ban checks

---

## What Was NOT Changed

- UI design and layout (identical)
- RLS policies (already correct)
- Auth flow (unchanged)
- Room structure (unchanged)
- No new infrastructure, no paid services
- No attachments feature (was never implemented — no storage costs)

---

## Remaining Risks

1. **pg_cron not enabled** — cleanup function exists but isn't scheduled. Needs dashboard enable + `cron.schedule()` call.
2. **Client-side rate limit only** — a determined user could bypass the 2s cooldown via direct API calls. RLS still blocks unauthenticated writes. Server-side rate limiting would need a Postgres trigger or Edge Function.
3. **No connection pooling config** — using default Supabase client settings. Fine for current scale.
4. **Realtime reconnect** — Supabase client handles reconnects automatically. No custom retry logic added.
5. **Large rooms** — pagination handles this, but rooms with 10k+ messages will still have slower "load older" as offset grows. Cursor-based (current) is better than offset-based.

---

## Test Results

### Visitor Path (unauthenticated)
- [x] Rooms load ("General", "Premarket Watch")
- [x] Sign-in prompt on message box click
- [x] Send button disabled without auth
- [x] Return-after-login URLs correct

### Performance
- [x] Production build passes (`npm run build`)
- [x] TypeScript compiles with no errors
- [ ] Load test with 50+ messages (pending — needs test data)
- [ ] Concurrent user test (pending — needs two signed-in sessions)
- [ ] Reconnect test (pending — manual)

### Security
- [x] RLS policies verified in migration
- [x] Anonymous INSERT rejected by policy (not just UI)
- [x] Service role key not in client bundle

---

## Files Changed

- `app/community/[slug]/page.tsx` — pagination, batched queries, realtime append, rate limit
- `supabase/migrations/community-v2-optimization.sql` — indexes, settings table, cleanup function
- `docs/community-optimization-audit.md` — this report

## Database Changes Applied

- 4 new indexes
- `community_settings` table (1 row: 7-day retention)
- `community_cleanup_old_messages()` function
- Realtime enabled for `community_messages` (was missing)

---

## Next Steps (Needs Karandeep)

1. **Enable pg_cron** in Supabase dashboard (Database → Extensions)
2. **Schedule cleanup**: run `select cron.schedule('community-cleanup-daily', '0 3 * * *', $$select public.community_cleanup_old_messages()$$);`
3. **QA the preview** — verify pagination, realtime, reactions
4. **Approve merge** to production when satisfied
