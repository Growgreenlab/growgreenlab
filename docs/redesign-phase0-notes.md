# Redesign Phase 0 — Foundations (branch `redesign-phase0-foundations`)

Base: `main` @ `622082b`. Direction: `growgreenlab-redesign-direction-v2-2026-10-20.md`
(owner-approved 2026-10-20, all 8 decisions as recommended). Audit map:
`growgreenlab-redesign-audit-2026-10-20.md` §10 Phase 0, as revised by Direction v2 §5
(Phase 0 shrinks: ONE light theme + one bounded stage scope; no dual theme sets,
no adaptive chrome).

## Scope delivered

1. **Token architecture** — `app/tokens.css`, imported after `globals.css` in
   `app/layout.tsx`. Every v2 token is defined ONLY inside an opt-in scope:
   - `[data-theme="light"]` — the v2 light platform theme (Direction v2 §2,
     Palette A — Lavender per D3): surfaces/ink spine, accent scale, trading
     semantics (light candle pair `#089981`/`#F23645` per D5), banner tints,
     radii, spacing, type scale, elevations, `--scrim`.
   - `[data-stage]` — the bounded dark chart-stage scope (§3, D2): stage
     surfaces/ink/grid + the platform's EXISTING candle pair
     `#2EBD85`/`#F6465D` preserved as `--chart-up/down` overrides (D5 split pair).
   Existing pages are untouched by the mechanism: legacy tokens in `globals.css`
   remain in force everywhere; the new names that collide with legacy names
   (`--bg`, `--border`) resolve to v2 values only inside a `data-theme` subtree
   (nearest-ancestor custom-property resolution), which no production page has.
2. **UI primitives** — `components/ui/` (Button, Card, Field Input/Select, Badge,
   Banner, Modal shell, Table primitives + barrel `index.ts`), styled by a single
   additive `.ui-*` section appended to `app/globals.css` (marked
   `UIKIT:BEGIN/END`; +126 lines, 0 deletions). Button variants per §2.6/D8:
   navy `primary` (product actions), `accent` (commercial only), `secondary`,
   `ghost`, `danger`, and trading-only `buy`/`sell`. Modal is a portal shell
   (role=dialog, aria-modal, focus trap, Esc/backdrop close, focus return) —
   existing production modals are NOT touched. No production page imports the kit yet.
3. **Specimen page** — `app/design-system/page.tsx` (+ client `Demo.tsx` for the
   modal): token swatches (spine, accent, semantics, stage), candle pairs on
   light and on stage, type scale, and every primitive incl. form error state,
   banners, badges, table with P&L cells. `robots: noindex`; not linked from
   any navigation; sitemap untouched.
4. **Leakage guards** — `lib/designTokens.test.ts` (**31 passed / 0 failed**):
   stage tokens defined only inside `[data-stage]`; `var(--stage-*)` referenced
   only by the `.ui-stage` rule; zero hardcoded color literals (hex/rgb/hsl) in
   `components/ui/**` and the UIKIT css section; adopted values pinned (D3
   accent `#6558C9`, D5 both candle pairs, D1 bg `#FAFAF8`).

## Decisions D1–D8, as honored in the foundations

- **D1 (journal light)** — the light theme is the platform default token set;
  no dark page theme exists in the architecture.
- **D2 (chart-stage exception)** — implemented as the single bounded
  `[data-stage]` scope; boundary per §3: chart canvas + on-scene panes only.
- **D3 (accent)** — Palette A Lavender tokenized; Palette B documented in the
  specimen as the non-adopted alternate (values not tokenized).
- **D4 (logo)** — no asset change in Phase 0 (brand assets land with the shell
  phase); nothing in the token system depends on it.
- **D5 (candles)** — split pair tokenized: light pair in the light scope,
  existing pair preserved inside the stage scope.
- **D6 (homepage hero)** — no homepage change in Phase 0.
- **D7 (no dark toggle v1)** — no toggle machinery, no stored preference:
  theming is a static scope attribute, exactly as decided.
- **D8 (commercial CTAs)** — Button `accent` variant exists solely for
  commercial actions; `primary` is navy.

## Zero-visual-change proof

Method: local production builds (stub Supabase env) of main and of this branch,
served identically; Playwright captures (`qa-harness/phase0-capture.mjs`,
guest stub, 1440×900, animations frozen identically in both builds) for
`/`, `/replay` (sample session + 8 candle steps), `/journal`, `/drills`,
`/billing`; pixel-diff via PIL with a per-channel threshold of 8.

| Capture | Changed px (>8) | Max delta | Verdict |
|---|---|---|---|
| home | 0 / 1,296,000 (0.0000%) | 0 | pixel-identical |
| journal | 0 (0.0000%) | 0 | pixel-identical |
| billing | 0 (0.0000%) | 0 | pixel-identical |
| replay | 0 (0.0000%) | 1 | identical within canvas AA noise |
| drills | 76 (0.0059%) | 106 | see below |

The drills delta is a 13×9 px patch of TEXT: "HOD Drill #058" (main capture)
vs "#023" (branch capture). `lib/drills/catalog.ts` seeds its selection with
`Math.random()` — the catalog shows a randomized drill on every load, on main
itself. Layout, colors, and all other pixels are identical. No pixel difference
is attributable to this branch.

## Drills verification suites — RELOCATED (audit §8.2 checklist item)

The suites the audit could not locate in `qa-harness/` or repo `scripts/`
live **in the repo** at `lib/drills/verify*.ts` — 9 files, run with
`npx -y tsx lib/drills/<file>`:

| Suite | Checks |
|---|---|
| verify.ts | 89 |
| verify-blind.ts | 400 |
| verify-e2e.ts | 156 |
| verify-eval.ts | 622 |
| verify-fixes.ts | 110 |
| verify-flow.ts | 138 |
| verify-flowpath.ts | 165 |
| verify-pool.ts | 225 |
| verify-sim.ts | 359 |
| **Total** | **2,264 — all passing, 0 failed** |

The project-record total (2,264) is confirmed exactly. Nothing was missing —
only mis-filed in the records (they are library suites, not harness scripts).

## Battery results (this branch)

- `tsc --noEmit`: clean. Production build: passes (`/design-system` prerenders).
- **Lib unit suites — 26 files, all green, 0 failures:**
  accessAdmin 35, billingServer 26, candleAccuracy 39, chartFit 70,
  crosshairMath 120, dailyReplay 197, dailyReplayOrders 58, dailyReplayResume 51,
  designTokens 31 (new), drChartContext 60, drDrafts 127, drEventFlush 40,
  drRepresentative 26, drTradeEvidence 50, drawings 31, edgeExport 303,
  edgeExportPackage 137, entitlements 59, journalAnalytics 109, journalCalc 69,
  quotaGate 32, strategies 21, strategyClassification 77, stripeWebhook 21,
  subscribeResume 46, StrategyTradedField 13.
  (Counts are THIS RUN's output. Two differ from the audit's recorded figures —
  accessAdmin 59 and drDrafts 131 — because those records came from unmerged
  feature branches with extended suites; on main the files are 35 and 127.
  This branch modifies no existing test file: `git diff` shows only additive
  changes.)
- **Drills suites: 2,264 passed / 0 failed** (table above).
- **SQL harnesses: green** — subscriptions 72/0, strategies 72/0,
  access-grants 104/0 (exact recorded counts).
- **DOM verify harnesses (qa-harness, stub build of this branch):**
  - Green: verify-journal **79/0**, verify-quota-gate **62/0** (audit record
    said 19 — stale; the live harness runs 62 checks), verify-subscribe
    **19/0**, verify-strategy-annotation **48/0**.
  - Red — **baseline-arbitrated**: verify-dr, verify-drafts, verify-strategy,
    verify-desktop-resize, verify-zoom, verify-export-seeded. All six were
    re-run against a pristine `main` worktree build (same stub env, same
    harness versions): **all six exit 1 on main too, with the same failure
    class** — an uncaught wait/locator timeout in a DR/chart/export flow and
    ZERO assertion failures on either build (verify-drafts logs only PASS
    lines — 93 in its fuller runs — and 0 FAILs before its timeout, on both). The stubs in these harnesses have
    drifted from current main code (they predate the Oct 18–19
    journal/access/quota merges). Not Phase 0 regressions: the branch
    changes no logic, no markup on those routes, and no stylesheet rule
    that applies to them; the failure set is byte-for-byte the same set
    before and after Phase 0.
  - Not runnable against main by design: verify-billing-id and
    verify-admin-promo-keys target the unmerged `feat-billing-account-id`
    and `feat-admin-promo-keys` branches (their UI does not exist in main
    source — verified by grep). They will gate when those branches merge.

## Phase 1 readiness

- Later phases opt a route in by stamping `data-theme="light"` on its root
  and swapping legacy classes/inline styles for kit components token by token;
  chart scenes additionally stamp `data-stage` on the chart frame element.
- The `--font`/next-font ambiguity (audit §2.1) is still open: primitives use
  `font: inherit`, so the kit is neutral to its resolution; the audit's
  computed-style verification remains a Phase 1 checklist item.
- The kit's breakpoints are not yet tokenized (audit breakpoint scale);
  primitives are fluid by construction, but page migrations in Phase 2+
  should adopt a breakpoint scale then — deliberately not invented here.

## Open risks

- DOM harness drift (above) means Phases 4–6 currently lack a green DR/drills
  DOM gate; the stub fixtures need a refresh pass before Phase 4 — flagged,
  not fixed here (out of Phase 0 scope, and the lib-level drills/DR suites
  — 2,264 + 306 checks — are green).
- `tokens.css` relies on nearest-ancestor resolution for the two colliding
  names (`--bg`, `--border`); any future code that stamps `data-theme` on a
  wrapper around legacy markup will re-skin that markup. Migration phases
  must stamp the attribute only on fully-migrated subtrees.
- The specimen route ships in the production bundle (noindex, unlinked).
  If the owner prefers it preview-only at the hosting level, gating it is a
  one-line follow-up — it contains no data and no privileged surface.

No production data, no migrations, no behavior changes. Not merged.
