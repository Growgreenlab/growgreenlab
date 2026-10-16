# Trading Academy — Stage 1 Audit (2026-10-15)

Branch: `trading-academy` (created from `breakout-drills` tip `a96ac9a`).
Production `main`: `61ed4ae` — untouched by this audit.
Scope: **audit only.** No feature code, no schema changes, no database
connections were made. Every claim below cites repo evidence; anything the
repo cannot prove is marked UNVERIFIED.

---

## 1. Repository state

- Branch `trading-academy`, working tree clean at audit start. Recent
  commits are the drills stack (`a96ac9a`, `e8b3208`, `85ae203`, `4d1c722`,
  `b679961`, …) on top of production `61ed4ae`.
- No `vercel.json` in the repo. Deployment mapping is by Vercel project
  convention (documented in `DEPLOY.md` and observed across all prior
  work): `main` → production (growgreenlab.com); every other branch →
  its own preview URL (`growgreenlab-git-<branch>-growgreen1.vercel.app`).
  The Academy preview will therefore be
  `growgreenlab-git-trading-academy-growgreen1.vercel.app` once pushed.
- Stack (from `package.json`): Next.js 15.1 (App Router), React 19,
  TypeScript 5.7 (strict), `@supabase/ssr` + `@supabase/supabase-js`,
  `lightweight-charts` 5.2.1. **No test runner, no lint config beyond
  `next lint`, no CSS framework** — styling is hand-written CSS in
  `app/globals.css` plus inline styles, tests are standalone `tsx`
  scripts (see §6).
- Scripts: `dev`, `build` (`next build`), `start`, `lint`. No `test`
  script — suites are run individually (see §7).

## 2. Routes, layout, navigation, design system

**Routes under `app/` (complete list):**
`app/page.tsx` (`/`), `app/replay/page.tsx`, `app/journal/page.tsx`,
`app/sessions/page.tsx`, `app/login/page.tsx`,
`app/auth/callback/route.ts`, `app/community/page.tsx`,
`app/community/[slug]/page.tsx`, `app/drills/page.tsx`,
`app/drills/focused/page.tsx`, `app/drills/[id]/page.tsx`,
`app/sitemap.ts`, `app/layout.tsx`, `app/globals.css`.
**There is no `/academy` route. Status: NOT IMPLEMENTED (expected).**

**Layout/chrome:**
- `app/layout.tsx` — root layout: Inter font, full SEO/OG metadata,
  Google Analytics (G-KRK0LVTTGS), wraps everything in
  `components/SiteChrome.tsx`.
- `components/SiteChrome.tsx` — renders `components/Header.tsx` +
  `<main class="wrap">` + a one-line footer; it *suppresses* chrome on
  `/community/*` (full-screen chat). The footer is a single disclaimer
  line — there is **no footer link list** anywhere in the codebase.
- `components/Header.tsx` — nav links live in ONE place: the
  `NAV_LINKS` const (lines 7–15): Replay Lab `/replay`, Trade Journal
  `/journal`, Community `/community`, Features `/#features`,
  How It Works `/#how-it-works`, Pricing `/#pricing`, About `/#about`.
  The same array feeds both the desktop bar and the mobile menu.
  Header also owns auth display (see §3) and a "Launch Simulator" CTA.
- **Drills nav history (matters for the combined go-live):** the
  Breakout Drills links were deliberately removed from the homepage,
  this nav, and the footer in the redesign (production `61ed4ae`).
  `/drills` exists only on the `breakout-drills` lineage (this branch
  included). Consequence: adding an **Academy** nav entry = one line in
  `NAV_LINKS`; restoring a **Drills** entry at go-live = one more line
  in the same array (+ homepage panel, a product decision for the user,
  not an audit assumption).

**Design tokens (`app/globals.css`):** two `:root` blocks — a legacy one
(line 5) and the current `--ggl-*` system (line 704):
`--ggl-bg #080B0E`, `--ggl-bg2 #0D1217`, `--ggl-card #0D141A`,
`--ggl-elev #111920`, `--ggl-text #F5F6F7`, `--ggl-text2 #B5BDC5`,
`--ggl-muted #7F8993`, `--ggl-border #252D35`, `--ggl-green #42D879`,
`--ggl-green-mut #74B985`. Shared primitives: `.ggl-btn` (+`-primary`,
`-ghost`, `-outline`), `.ggl-card`, `.ggl-panel`, `.ggl-nav*`.
This is exactly the charcoal + restrained-emerald direction the Academy
spec requires — the Academy should consume these tokens, not introduce
a parallel palette.
**Media patterns:** `@media (max-width: 1023px)`, `960px`, `640px`
throughout; a dedicated `@media (max-width: 480px)` block at line 965
(header fit, ≥44px tap targets — added for the drills landing);
`@media (max-width: 900px)` stacking blocks live inline in the drills
pages (`<style>` tags), not in globals; `prefers-reduced-motion`
support exists (line 448). Academy components should follow the
globals-token + page-scoped-`<style>` pattern already in use.

## 3. Auth, sessions, guest behavior

- **Clients:** `lib/supabaseClient.ts` (browser,
  `createBrowserClient` from `@supabase/ssr`, guarded by
  `isSupabaseConfigured()`) and `lib/supabaseServer.ts` (server,
  cookie-based). Env: `NEXT_PUBLIC_SUPABASE_URL` /
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`. No service-role key anywhere in
  client code. No `.env.local` in the repo.
- **Session detection:** no global auth context/provider exists. Each
  consumer creates the browser client and calls
  `supabase.auth.getUser()` + `onAuthStateChange` itself — `Header.tsx`
  (lines 25–36: email + `user_metadata.display_name`) is the canonical
  pattern, replay/journal pages repeat it. The Academy must follow the
  same per-component pattern (or be the first to add a small shared
  hook — a Stage 2 decision, not an assumption).
- **Middleware:** `middleware.ts` refreshes the session cookie but
  `PROTECTED = []` — **auth enforcement is disabled by design**; the
  matcher only covers `/replay/*` and `/sessions/*`. Nothing gates
  routes today.
- **Guest behavior today:** Replay Lab is fully usable signed-out
  (guest trade limit: `lib/guestTrades.ts`, 5 new positions/day,
  localStorage key `ggl_guest_trades` + server guard tables).
  Drills are fully usable signed-out; cycle progress is localStorage
  only (`lib/drills/cycle.ts`, key `ggl-drill-pool-v1`).
  The Journal is the exception: nav tab visible to everyone, content
  requires sign-in (`app/journal/page.tsx` line 103: "Please sign in to
  view your trade journal."). `/login` offers email+password, magic
  link, create account, continue-as-guest.
- **Profiles:** `public.profiles` (`supabase/schema.sql` lines 5–10:
  `id uuid → auth.users`, `email`, `created_at`) auto-created by the
  `handle_new_user` trigger. Usage in code is light (display names in
  community come from auth metadata). There is no general "user
  profile/settings" surface to extend.

## 4. Supabase data — what exists, and what the Academy needs

**Tables the codebase uses** (`.from(...)` call sites + DDL in
`supabase/schema.sql` and `supabase/migrations/community-v*.sql`):
`profiles`, `replay_sessions`, `session_trades`,
`journal_trade_meta`, `journal_manual_trades`, `journal_real_trades`,
`journal_real_fills`, `community_rooms`, `community_messages`,
`community_reactions`, `community_members`, `community_bans`,
`community_settings`, `guest_guard_lockouts`, `guest_trade_usage`.

**RLS pattern (repo-verified, consistent):** every user-owned table
enables RLS and gets ONE owner policy of the exact shape (see
`journal_trade_meta`, schema.sql lines 221–229):

```sql
create policy "own journal meta" on public.journal_trade_meta
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

with `user_id uuid not null references auth.users(id) on delete
cascade`, a `unique(user_id, <natural key>)` where upserts are needed,
and a `(user_id, …)` index. Community tables add role-aware policies
(`members_join_public` forces `role='member'`, moderator/admin
policies) — the precedent if Academy ever needs shared content, which
v1 does not. SQL lives in the repo (`supabase/schema.sql` is the
cumulative file; `supabase/migrations/` holds feature deltas) and is
applied manually via the Supabase SQL editor per `DEPLOY.md` — there
is no migration runner.

**Storage:** the journal screenshots feature uses a private
`journal-screenshots` bucket with owner-folder paths and signed URLs
in the shipped product, **but the bucket's DDL/policies are NOT in
this repo** (created via the dashboard) — repo evidence proves the
pattern is "private bucket + owner prefix + signed URL", and the live
policies themselves are UNVERIFIED from repo alone. The Academy v1
needs no storage.

**Academy data design (following the journal precedent exactly):**
- `public.academy_progress` — one row per (user, lesson):
  `id uuid pk`, `user_id uuid not null → auth.users on delete cascade`,
  `lesson_id text not null` (matches the typed content registry id),
  `status text check in ('started','completed','mastered')`,
  `best_score numeric` (0–100), `attempts int not null default 0`,
  `last_position jsonb` (resume state, e.g. current step),
  `updated_at`/`created_at`, `unique(user_id, lesson_id)`,
  index on `(user_id, lesson_id)`. RLS: the "own …" policy verbatim.
- `public.academy_journal` — decision-journal reflections:
  `id uuid pk`, `user_id … cascade`, `lesson_id text`,
  `prompt_key text`, `response text`, `created_at`. Same RLS.
  Private by the same policy; never selected across users.
- **Assessment integrity:** scores are computed by pure, tested
  client-side logic (the drills model — `lib/drills/scoring.ts` +
  verify suites). RLS guarantees a user can only write their OWN rows;
  it cannot prove a score was honestly earned, and the spec's
  "never trust a client-side completion flag" is honored the same way
  the platform already honors it for drills/journal: progress is a
  personal learning record, not a credential; nothing downstream
  (payments, public leaderboards) consumes it. If that ever changes,
  server-side re-grading from submitted answers becomes necessary —
  flagged as a known limitation, not built in v1.
- **Guests:** progress persists in localStorage under a versioned key
  following the existing conventions (`ggl-drill-pool-v1`,
  `ggl_guest_trades`): proposed `ggl-academy-v1` holding the same
  shape as the server rows. **Guest→account merge rule (design):** on
  first signed-in load, for each lesson keep the BETTER state
  (mastered > completed > started; higher best_score; max attempts
  summed is wrong — take max attempts to avoid double counting);
  never overwrite an existing server row with a weaker guest state;
  clear the guest key only after the upsert succeeds. This mirrors
  "authenticated data wins on conflict" and avoids duplicates via the
  `unique(user_id, lesson_id)` upsert.
- Migration delivery: one new file
  `supabase/migrations/academy-v1.sql` (+ mirror into `schema.sql`),
  applied by the user in the SQL editor at go-live, same as every
  prior feature. **Applying it is a production DB change — it requires
  the user's explicit go at release time; this audit does not apply
  anything.**

## 5. Reuse inventory

- **Charts — the key decision.** Two candle renderers exist:
  - `components/LwcChart.tsx` (lightweight-charts, ~large): props
    require `candles`, `revealedCount`, `sessionKey`, `countdown`,
    `lastPrice`, `brackets`, drag callbacks, and the full drawings
    system. It is a *replay terminal*: crosshair sync, incremental
    push planning (`lib/chartPush.ts`), drawing layers. Using it for a
    lesson means simulating a replay session around a handful of
    candles — heavy, stateful, and semantically wrong for a static
    or slider-driven single candle.
  - `components/CandleChart.tsx`: a hand-rolled canvas terminal chart
    (zoom/pan/fills/overlays) — also a terminal, also wrong-shaped
    for lessons.
  - **RECOMMENDATION: build a small purpose-built SVG candle renderer**
    (`components/academy/CandleSvg.tsx`, Stage 3). Reasons: (1) the
    flagship lesson needs ONE candle whose body/wicks morph with
    sliders at 60fps and a formation animation from a price path —
    pure functions of OHLC/path state, trivially rendered as SVG rects
    and lines; (2) SVG gives free accessibility (titles, aria-labels,
    text labels for O/H/L/C that a canvas/chart lib cannot expose),
    which the spec explicitly requires; (3) zero new dependencies,
    no chart-instance lifecycle, no risk to the two production
    terminals; (4) the same component serves multi-candle lesson
    diagrams later. LwcChart stays untouched for Replay/Drills.
- **Candle/OHLC math:** `lib/types.ts` `Candle` (`{t,o,h,l,c,v}`).
  Pure helpers today: `lib/drills/candleGen.ts`
  (`generateScenarioCandles` + `RegimeSpec`/`BreakoutShaping`),
  `lib/price.ts`, `lib/risk.ts` (position sizing / R math — direct
  reuse for World 8 calculators later). No existing OHLC-validation
  or candle-classification helper exists — Stage 3 creates
  `lib/academy/candle.ts` (invariants, classification, geometry) as a
  pure module in the established style.
- **Deterministic RNG:** `mulberry32` exists in THREE private copies
  (`lib/marketData.ts:73`, `lib/drills/candleGen.ts:14`,
  `lib/drills/orderflow.ts:87`) — never exported/shared. Lesson demos
  should import a seeded generator; Stage 2/3 may add
  `lib/academy/rng.ts` with the same algorithm rather than disturb the
  existing copies (they are pinned by 2,264 checks).
- **Test pattern:** pure `lib/**` modules + `lib/drills/verify-*.ts`
  standalone scripts run via `npx -y tsx <file>`, each printing
  `=== X RESULT: N passed, M failed ===`. Nine suites exist (listed
  in §7). Academy logic follows the identical pattern
  (`lib/academy/verify-*.ts`) — no new test infrastructure.
- **Typed content-as-data pattern:** `lib/drills/scenarios.ts` —
  typed definition records (`ScenarioDef`) compiled by a builder into
  runtime objects, content fully separated from the page. This is the
  model for the Academy's typed lesson schema (Stage 2:
  `lib/academy/content.ts` registry + `lib/academy/types.ts`).
- **Existing academy/quiz/lesson code:** searched
  `academy|curriculum|course|quiz|lesson` across `app/`, `components/`,
  `lib/` — **zero matches outside drills' internal wording. Nothing
  exists to reuse or conflict with. Confirmed greenfield.**
- **Other reusable pieces:** `components/Level2Panel.tsx` /
  `TimeSalesPanel.tsx` (SIMULATED-labeled order-flow displays —
  reusable for World 7 lessons later), `lib/drills/orderflow.ts`
  (deterministic synthetic book/tape generator), the drills'
  Evidence-style teaching composition (evaluation.ts) as the voice/
  structure precedent for Evidence Board feedback.

## 6. Content/lesson infrastructure facts

- tsconfig path alias: `@/*` → repo root (`"./*"`), though the
  codebase mostly uses relative imports (`../../lib/…`) — follow the
  relative-import convention of neighboring files.
- Docs live in `docs/` as dated markdown audits/delivery reports
  (this file follows that convention).
- No CMS, no MDX, no content pipeline: all content is typed TS data
  (drills scenarios) or JSX. The Academy lesson schema will be typed
  TS for the same reason — compile-time validation, zero infra.

## 7. Baselines (actually run on this branch, 2026-10-15)

Drills verify suites (`npx -y tsx lib/drills/<suite>.ts`):

| Suite | Result |
|---|---|
| verify | 89 passed, 0 failed |
| verify-sim | 359 passed, 0 failed |
| verify-blind | 400 passed, 0 failed |
| verify-fixes | 110 passed, 0 failed |
| verify-flow | 138 passed, 0 failed |
| verify-flowpath | 165 passed, 0 failed |
| verify-pool | 225 passed, 0 failed |
| verify-e2e | 156 passed, 0 failed |
| verify-eval | 622 passed, 0 failed |
| **Total** | **2,264 passed, 0 failed** |

`npx tsc --noEmit` — exit 0. `npm run build` — exit 0.
These are the regression floor for every Academy stage: any stage
that moves any number is a regression by definition.

## 8. Risks

1. **Shared chrome blast radius.** `Header.tsx`/`SiteChrome.tsx`/
   `globals.css` are used by every page. The Academy nav entry is a
   one-line array addition (low risk), but globals.css token or
   `.wrap` changes would site-wide — Stage 2 must scope Academy CSS
   under `.ggl-academy*` class prefixes / page `<style>` blocks, as
   the drills pages already do.
2. **Combined go-live coupling.** This branch carries BOTH the
   finished drills stack (unmerged) and the Academy. The user's plan
   is a single combined go-live. Implication: the Academy merge
   inherits the known drills↔main LwcChart merge conflicts
   (chartPush planner wins, keep `fitOnLoad`) — unchanged by Academy
   work as long as Academy does not touch `LwcChart.tsx` (the SVG
   recommendation in §5 exists partly for this reason).
3. **Branch preview ≠ phone.** All mobile verification in this
   project is construction + the user's device pass (browser harness
   is desktop-width). Academy slider/numeric controls on small
   screens carry the same UNVERIFIED-until-device-pass status.
4. **localStorage-only guest progress is per-device** and clearable;
   the UI must say so plainly (spec §11). Keys must be versioned
   (`ggl-academy-v1`) to allow future shape changes without corrupting
   existing learners' state — the drills pool (`ggl-drill-pool-v1`)
   is the precedent, including its parse-tolerant loader.
5. **Assessment honesty ceiling** (see §4): RLS isolates owners; it
   cannot verify earned scores. Acceptable for a personal learning
   record; documented, not hidden.
6. **Content correctness risk.** Lesson copy teaches market concepts;
   errors here are product defects. Mitigation: the spec's
   Fact/Interpretation/Overreach/Needs-More-Data taxonomy is built
   into the content schema itself (every Evidence Board item carries
   its context + rationale), and challenge answer keys derive from
   the same pure candle math the tests pin — never hand-typed prose
   answers that can drift from the math.
7. **No AI integration exists in the codebase** (no `app/api`
  routes, no provider keys). The spec's optional AI tutor has no
   secure existing integration to reuse — **recommend: skip for this
   release**; explanation assessment uses the deterministic rubric
   route (structured choices + concept-tagged free text with
   rubric-keyword/concept matching that accepts varied phrasing,
   never exact-string).

## 9. Staged plan (smallest safe path)

### Stage 2 — Academy foundation (no curriculum breadth)
New files:
- `lib/academy/types.ts` — typed lesson schema (objectives, steps,
  prerequisites, mastery config), Evidence Board item types,
  progress types.
- `lib/academy/content.ts` — the lesson registry (initially: World 2
  flagship lesson only, plus Worlds map metadata with honest
  `planned` status for the rest — no empty shells).
- `lib/academy/progress.ts` — progress store: localStorage adapter
  (`ggl-academy-v1`) + Supabase adapter (upsert into
  `academy_progress`/`academy_journal` when signed in) + the
  guest→account merge rule from §4. Pure merge logic, testable.
- `lib/academy/verify-progress.ts` — suites for merge rules, state
  machine (started/completed/mastered), threshold logic (default
  80%, configurable).
- `app/academy/page.tsx` — learning map (worlds list, statuses,
  recommended next action, resume).
- `app/academy/[lessonId]/page.tsx` — lesson shell rendering the
  typed steps; unknown/planned lessons render an honest "planned"
  state.
- `components/Header.tsx` — ONE line: `{ label: "Academy", href:
  "/academy" }` in `NAV_LINKS`.
- `supabase/migrations/academy-v1.sql` — the two tables + RLS +
  indexes (written, NOT applied — application is a go-live action
  requiring the user's explicit approval).
Gate: baselines §7 unchanged; new suites green; tsc/build exit 0;
browser QA of map + shell as guest and signed-in.

### Stage 3 — Candlestick Mastery flagship (World 2)
New files:
- `lib/academy/candle.ts` — pure OHLC invariants
  (`Low ≤ min(O,C) ≤ max(O,C) ≤ High` enforced by clamping policy),
  classification (bullish/bearish/doji with explicit tolerance),
  range/body/wick geometry, formation-from-price-path reducer.
- `lib/academy/verify-candle.ts` — invariant/boundary/classification/
  geometry/formation tests incl. invalid-input handling.
- `components/academy/CandleSvg.tsx` — the SVG renderer (single +
  small multi-candle), labeled O/H/L/C, aria-complete.
- `components/academy/CandleBuilder.tsx` — sliders + numeric inputs
  bound to `candle.ts` (no invalid state reachable), challenge engine
  (build-a-bullish/bearish/doji/long-wick…, seeded variation),
  formation demo player (play/pause/step/reset from a seeded price
  path; path-not-recoverable explainer).
- `components/academy/EvidenceBoard.tsx` — the reusable
  Fact/Interpretation/Overreach/Needs-More-Data classifier with
  commit-then-reveal feedback, retries, concept tags feeding the
  misconception tracker in `progress.ts`.
- Lesson content for World 2 in `lib/academy/content.ts` (steps:
  intro → formation demo → builder free play → guided challenges →
  Evidence Board → explanation prompts (structured rubric) →
  mastery assessment at the 80% default → decision journal
  reflection → contextual link to Breakout Drills).
Gate: full §7 baselines + new candle/evidence/progress suites;
browser QA end-to-end as guest (progress survives reload) and
signed-in (progress persists server-side, account isolation by RLS
design + the established owner-policy test pattern); accessibility
pass on the builder (keyboard-operable sliders, visible focus,
non-color-only bullish/bearish encoding — direction is also carried
by O/C labels and body position, not color alone).

### Later stages (per master spec, sequenced, not designed here)
Worlds 1, 3, 4 (Stage 5) reusing the Stage 2/3 components; Worlds
5–8 (Stage 6, `lib/risk.ts` calculators + orderflow reuse); Worlds
9–11 (Stage 7, contextual drill links from `lib/drills/catalog.ts`
slugs — never pre-revealing classifications); World 12 (Stage 8).

## 10. Status labels & recommendation

- Academy routes/components/content: **Not Implemented** (greenfield,
  confirmed by search).
- Reuse base (design tokens, auth pattern, RLS precedent, test
  pattern, typed-content pattern): **Implemented** (in the platform)
  and sufficient — no platform work blocks the Academy.
- Baselines: **Tested** — 2,264/2,264, tsc 0, build 0, on this branch.
- Migration design: **Implemented as a design** in §4; the SQL file
  itself is Stage 2 work; applying it is **Blocked** on the user's
  go-live approval (by policy, not by any technical obstacle).
- Chart renderer: **Recommendation — purpose-built SVG** (§5).
- AI tutor: **Not Implemented — recommended skip** (no existing
  secure integration; §8.7).

**GO recommendation: proceed to Stage 2 (foundation) and Stage 3
(Candlestick Mastery flagship) exactly as staged in §9.** Nothing in
the audit blocks them; the drills baselines give a hard regression
floor; the only production-affecting act (applying the migration and
merging) stays gated on the user's explicit combined go-live
approval, alongside the drills.
