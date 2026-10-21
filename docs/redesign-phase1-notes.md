# Redesign Phase 1 — notes (public pages in the light theme)

Branch: `redesign-phase1-public`, stacked on `redesign-phase0-foundations`
(8811faa). NOT merged. Authority: Direction v2 + decisions D1–D8 (all
approved 2026-10-20). Phase 0 notes: `docs/redesign-phase0-notes.md`.

## What shipped (pixels only — behavior unchanged)

`data-theme="light"` is stamped ONLY on fully migrated roots, per the
Phase 0 warning: `<header>`, `<footer>`, the homepage root, the
/pricing root, the /login root. All Phase 1 paint lives in ONE new
section of `app/globals.css` (`PHASE1:BEGIN/END`, after the UIKIT
section): scoped `[data-theme="light"]` overrides that repaint the
legacy `ggl-*` / `.card` / `.btn` / `.input` rules with v2 tokens.
Layout is inherited from the legacy rules — the section changes
paint, not boxes (one exception: the mobile stagebar's dark
translucent background inside the legacy ≤900px media query is
repainted by a scoped media rule).

1. **Shared chrome** — header/nav + mobile menu + footer are light
   on EVERY route (they are stamped; bodies of un-migrated pages are
   untouched — this is the expected Phase 1 transition state).
   White nav, navy links, active state = accent-ink label + 2px
   accent underline (new; Header is now pathname-aware — the
   /journal vs /journal?tab=analytics distinction is read from the
   live URL client-side, deliberately NOT useSearchParams, so the
   root-layout component gains no Suspense bailout). Sign In =
   secondary, Start Practicing = navy (D8: product actions navy).
2. **Logo (D4)** — new `components/BrandLogo.tsx`: an inline-SVG
   adaptation of the existing mark (G-swoosh arc, ascending bars,
   leaf) — arc + wordmark in `--ink-900`, bars + leaf in `--up-ink`
   (heritage "lab green", which per Direction v2 appears only
   inside the logo). Replaces the dark-era PNG in header + footer.
   The PNG asset and the layout's favicon/OG references to it are
   deliberately unchanged (asset still exists; icon refresh is a
   brand-asset call for the owner).
3. **Homepage** — full light repaint of the existing premium
   ("Process Rail") page: same sections, same order, same copy.
   Eyebrows → accent-ink, rail active marker → accent-500, text
   links → navy with accent underline, founder accent span →
   accent-ink, founder rule → accent-500. Founder section verbatim,
   exactly once, after Connect and before the Access band
   (DOM-probed: count 1; y-order Connect < Founder < Access; About
   strip text absent; no Drills content in the page body).
   Hero/panel imagery (D6) replaced with FRESH captures of the
   current production build taken 2026-10-21 from the branch build
   itself: `public/shot-replay.png` (simulator chart, sample
   session, position open), `public/shot-order.png` (order panel
   with the fill in the ledger), `public/shot-journal.png`
   (journal Analytics — Risk & Consistency + R Distribution +
   Daily P&L). The product UI inside them is still the dark UI —
   that is the approved D2 end-state for chart scenes, framed by
   the light page. Alt texts unchanged (still accurate).
4. **/pricing** — plan cards on the kit (`.ui-card`), Pro Yearly
   keeps its production emphasis: accent-600 border + accent-soft
   header band (title + price) + PRO badge (`.ui-badge-pro`).
   Subscribe CTAs = `.ui-btn-accent` (D8 commercial accent),
   "manage billing" = navy primary, Free CTA = secondary, the
   checkout notice = kit `Banner` (info). Prices byte-identical:
   Free $0; Pro CAD $9.99/mo; $99.99/yr; badge "Save $19.89/yr
   (~17%) vs monthly" (DOM-probed). Checkout wiring, the
   subscribe-resume effect, and entitlement logic untouched —
   markup/classes only.
5. **/login** — card/inputs/buttons repainted via the scoped
   legacy-class overrides; the mode tabs and magic-link toggle
   buttons were converted from dark-era inline styles to token
   classes (`.auth-tab`, `.auth-textbtn`, `.auth-guest-link`).
   All three modes (password / sign-up / magic link), the resend
   flow, error/sent states, and the `next`-param handling are
   code-identical. There is no separate /signup route in the app
   (sign-up is a /login mode) and /auth/callback is a logic-only
   route with no UI — nothing to restyle there.
6. **Page wash** — stamped page roots paint the v2 `--bg` across
   the full viewport via a `position: fixed` ::before (the roots
   live inside the 1320px wrap; without it the dark body framed
   every light page and short pages showed a dark band above the
   footer). The FOOTER's wash is absolute over its own box only —
   a fixed wash there would wrongly lighten dark pages.

## Deliberately NOT in this phase

- /sessions, /billing, /admin/access — audit Phase 3 account
  cluster (bodies untouched; chrome applies). /community — audit
  Phase 7 (the chat route renders without chrome by design; the
  community index gets the light chrome only). /journal, /replay,
  /drills bodies — later phases. /design-system — kept as-is.
- The viewport `maximumScale=1` (audit §5.6) and the ≤860px
  drills-CTA rule are untouched (later-phase / out-of-scope).

## Verification (branch build, stub env, this machine)

- `tsc --noEmit` clean; `next build` passes (20 routes).
- Lib suites: 26/26 green, counts identical to Phase 0 baselines
  (designTokens 31/0 included — the PHASE1 section sits outside
  the UIKIT markers and references tokens, so the Phase 0 guards
  hold). Drills: 2,264/0. SQL harnesses: 72/72/104.
- DOM harnesses: verify-journal 79/0, verify-strategy-annotation
  48/0. verify-subscribe 18/1 and verify-quota-gate (uncaught
  /replay navigation timeout in its Daily-Replay lock flow) were
  ARBITRATED against a pristine main (622082b) build in a separate
  worktree: both fail IDENTICALLY on main in this environment
  (same case, same line, zero assertion failures) — a pre-existing
  environment behavior (signed-in document loads stall against the
  unreachable stub host), not a Phase 1 regression. The six
  pre-existing red DOM harnesses (verify-dr, verify-drafts,
  verify-strategy, verify-desktop-resize, verify-zoom,
  verify-export-seeded) likewise show zero assertion failures and
  timeout deaths on BOTH branch and main — identical.
- Screenshots: ~/workspace/qa-harness/captures/phase1/ — every
  restyled page at 1440×900, 1229×691 (owner viewport) and 390px,
  plus homepage full-page, mobile menu, login signup/magic modes,
  pricing notice + signed-in states, and chrome-effect shots of
  /journal, /drills, /billing — all visually inspected. (The
  full-page homepage capture shows dark side bands in its lower
  tiles: a Playwright fullPage stitching artifact with fixed
  backgrounds — the scrolled viewport capture of the same section
  shows the margins fully light.)
- Two stub-environment limits, both in untouched code paths:
  (a) /sessions does SSR data fetching that stalls against the
  local stub host (its header/footer are the same components
  proven on /journal, /drills, /billing — no separate shot);
  (b) the /pricing checkout-cancelled notice never fires under
  the stub because the stub's entitlement RPC never resolves
  non-null — the notice is rendered by the Phase-0-proven kit
  `Banner` and its trigger logic is unmodified. Real-device pass
  is the owner's, as always.

## Merge gate

Owner QA on the Vercel preview, then merge on his explicit word —
same contract as Phase 0. Production/main untouched by this branch.
