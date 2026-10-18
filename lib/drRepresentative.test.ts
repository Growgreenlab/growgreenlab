/**
 * drRepresentative.test.ts — representative screenshot resolution
 * (Representative plan §6.2). Run: npx tsx lib/drRepresentative.test.ts
 *
 * Pins the precedence (user selection → captured entry → single-
 * attachment fallback → none), the exit-never-default rule, R2 path
 * validation (listed AND under an own prefix), the failed-entry
 * matrix (a capture record that says "failed" blocks silent
 * promotion), superseded → null, and the selection merge's
 * no-clobber guarantee.
 */
import {
  resolveRepresentative,
  withRepresentativeSelection,
  type ResolveRepresentativeInput,
} from "./drRepresentative";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}

const USER = "user-00000000-0000-0000-0000-000000000001";
const DRAFT = "dr:att-1:g0:c1";
const FINAL = "sess-1:1";
const DSEG = "dr_att-1_g0_c1";
const FSEG = "sess-1_1";
const ENTRY = `${USER}/${DSEG}/auto-entry-c6.png`;
const EXIT = `${USER}/${DSEG}/auto-exit-c10.png`;
const MANUAL = `${USER}/${DSEG}/manual-shot.png`;
const CANON = `${USER}/${FSEG}/review-shot.png`;
const FOREIGN_TRADE = `${USER}/dr_att-2_g0_c1/auto-entry-c6.png`;
const FOREIGN_USER = `user-99999999-9999-9999-9999-999999999999/${DSEG}/auto-entry-c6.png`;

const base = (over: Partial<ResolveRepresentativeInput>): ResolveRepresentativeInput => ({
  autoCapture: undefined,
  listedPaths: [],
  draftKey: DRAFT,
  finalizedTradeKey: FINAL,
  userId: USER,
  ...over,
});
const capturedEntry = { entry: { path: ENTRY, candleIndex: 5, status: "captured" } };
const capturedBoth = {
  entry: { path: ENTRY, candleIndex: 5, status: "captured" },
  exit: { path: EXIT, candleIndex: 9, status: "captured" },
};

/* ---- precedence ---- */
{
  const r = resolveRepresentative(base({
    autoCapture: { ...capturedBoth, representative: { path: MANUAL, selectedAt: "2026-10-17T00:00:00.000Z" } },
    listedPaths: [ENTRY, EXIT, MANUAL],
  }));
  check("selection beats captured entry", r?.path === MANUAL && r.source === "user_selected");
  check("selection of a non-capture path has no candle index", r?.candleIndex === null);
}
{
  const r = resolveRepresentative(base({
    autoCapture: { ...capturedBoth, representative: { path: EXIT, selectedAt: "2026-10-17T00:00:00.000Z" } },
    listedPaths: [ENTRY, EXIT],
  }));
  check("user may select the EXIT capture explicitly", r?.path === EXIT && r.source === "user_selected");
  check("selected exit carries its recorded candle index", r?.candleIndex === 9);
}
{
  const r = resolveRepresentative(base({ autoCapture: capturedBoth, listedPaths: [ENTRY, EXIT] }));
  check("captured entry is the default representative", r?.path === ENTRY && r.source === "auto_entry" && r.candleIndex === 5);
}
{
  const r = resolveRepresentative(base({
    autoCapture: { ...capturedBoth, representative: { path: `${USER}/${DSEG}/deleted.png`, selectedAt: "2026-10-17T00:00:00.000Z" } },
    listedPaths: [ENTRY, EXIT],
  }));
  check("stale selection falls through to the captured entry", r?.path === ENTRY && r.source === "auto_entry");
}

/* ---- exit is never a default ---- */
{
  const r = resolveRepresentative(base({
    autoCapture: { entry: { status: "failed" }, exit: { path: EXIT, candleIndex: 9, status: "captured" } },
    listedPaths: [EXIT],
  }));
  check("entry failed + exit captured -> none (exit never promoted)", r === null);
}
{
  const r = resolveRepresentative(base({
    autoCapture: { entry: { status: "skipped" }, exit: { path: EXIT, candleIndex: 9, status: "captured" } },
    listedPaths: [EXIT, MANUAL],
  }));
  check("entry skipped + exit + manual -> none", r === null);
}
{
  const r = resolveRepresentative(base({
    autoCapture: { entry: { path: ENTRY, candleIndex: 5, status: "captured" }, exit: { path: EXIT, candleIndex: 9, status: "captured" } },
    listedPaths: [EXIT],
  }));
  check("entry captured but file deleted -> none (no substitution)", r === null);
}

/* ---- D7 single-attachment fallback (no capture record at all) ---- */
{
  const r = resolveRepresentative(base({ autoCapture: undefined, listedPaths: [CANON] }));
  check("legacy, no record, one image -> single_attachment", r?.path === CANON && r.source === "single_attachment" && r.candleIndex === null);
}
{
  const r = resolveRepresentative(base({ autoCapture: null, listedPaths: [CANON, MANUAL] }));
  check("legacy, no record, two images -> none", r === null);
}
{
  const r = resolveRepresentative(base({ autoCapture: {}, listedPaths: [MANUAL] }));
  check("empty record, one image -> single_attachment", r?.path === MANUAL && r.source === "single_attachment");
}
{
  const r = resolveRepresentative(base({ autoCapture: undefined, listedPaths: [] }));
  check("no images at all -> none", r === null);
}

/* ---- R2 validation: foreign / stale paths rejected ---- */
{
  const r = resolveRepresentative(base({
    autoCapture: { ...capturedEntry, representative: { path: FOREIGN_TRADE, selectedAt: "2026-10-17T00:00:00.000Z" } },
    listedPaths: [ENTRY, FOREIGN_TRADE],
  }));
  check("selection under ANOTHER trade's prefix rejected -> falls to entry", r?.path === ENTRY && r.source === "auto_entry");
}
{
  const r = resolveRepresentative(base({
    autoCapture: { entry: { path: FOREIGN_USER, candleIndex: 5, status: "captured" } },
    listedPaths: [FOREIGN_USER],
  }));
  check("entry path under another USER's prefix rejected", r === null);
}
{
  const r = resolveRepresentative(base({
    autoCapture: capturedEntry,
    listedPaths: [EXIT, MANUAL],
  }));
  check("recorded entry path not in the listing -> not followed", r === null);
}
{
  // Post-mapping canonical prefix: the entry capture path recorded
  // under the DRAFT prefix still resolves after finalization renames
  // nothing — both prefixes are the trade's own.
  const r = resolveRepresentative(base({ autoCapture: capturedEntry, listedPaths: [ENTRY, CANON] }));
  check("draft-prefix entry resolves for the finalized trade", r?.path === ENTRY && r.source === "auto_entry");
}
{
  const r = resolveRepresentative(base({
    autoCapture: { entry: { path: CANON, candleIndex: 5, status: "captured" } },
    listedPaths: [CANON],
    draftKey: null,
  }));
  check("canonical-prefix entry resolves with no draft key", r?.path === CANON && r.source === "auto_entry");
}

/* ---- superseded ---- */
{
  const r = resolveRepresentative(base({
    autoCapture: capturedBoth,
    listedPaths: [ENTRY, EXIT],
    draftStatus: "superseded",
  }));
  check("superseded-generation draft -> null", r === null);
}

/* ---- selection merge: no clobber, idempotent ---- */
{
  const before = {
    entry: { path: ENTRY, candleIndex: 5, status: "captured" },
    exit: { path: EXIT, candleIndex: 9, status: "captured" },
  };
  const merged = withRepresentativeSelection(before, MANUAL, "2026-10-17T01:02:03.000Z");
  check("merge preserves the entry outcome", JSON.stringify((merged as any).entry) === JSON.stringify(before.entry));
  check("merge preserves the exit outcome", JSON.stringify((merged as any).exit) === JSON.stringify(before.exit));
  check("merge sets representative {path, selectedAt}",
    (merged as any).representative?.path === MANUAL && (merged as any).representative?.selectedAt === "2026-10-17T01:02:03.000Z");
  check("merge does not mutate the input", (before as any).representative === undefined);
  const again = withRepresentativeSelection(merged, MANUAL, "2026-10-17T01:02:03.000Z");
  check("re-selecting the same path is idempotent", JSON.stringify(again) === JSON.stringify(merged));
  const fromEmpty = withRepresentativeSelection(undefined, MANUAL, "2026-10-17T01:02:03.000Z");
  check("merge from an empty record works", (fromEmpty as any).representative?.path === MANUAL);
  const resolved = resolveRepresentative(base({ autoCapture: merged, listedPaths: [ENTRY, EXIT, MANUAL] }));
  check("merged record resolves to the selection", resolved?.path === MANUAL && resolved.source === "user_selected");
}

console.log(`drRepresentative tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
