/**
 * drawings.test.ts — tests for the pure drawing-interaction logic in
 * lib/drawings: anchorHitZone (which endpoint handle, if any, is under
 * the pointer) and drawingCursor (the Webull-style grab / grabbing /
 * move decision), plus the distToSegment behavior the hit tolerance
 * is built on. Run: npx tsx lib/drawings.test.ts
 *
 * anchorHitZone is the single classification used BOTH by pointerdown
 * (drag mode: body vs p1 vs p2) and by the hover cursor in LwcChart —
 * if the two ever disagreed, the cursor would promise a drag the
 * press doesn't deliver. These tests pin the shared semantics.
 */
import {
  anchorHitZone,
  drawingCursor,
  distToSegment,
  createDrawing,
  type Drawing,
} from "./drawings";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${name}`); }
}
const approx = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

/* ---------------- coordinate converters (linear test scales) -------- */
const T0 = 1_700_000_000_000;                 // arbitrary session start (ms)
const toX = (t: number) => (t - T0) / 6000;   // one 1-min candle = 10px
const toY = (p: number) => (10 - p) * 100;    // $1 = 100px, price up = y down
const TOL = 8;                                // mouse hit tolerance (px)

/* ---------------- anchorHitZone: trendline endpoints ---------------- */
// p1 -> (0, 500), p2 -> (100, 400)
const trend: Drawing = createDrawing("trendline", {
  p1: { time: T0, price: 5 },
  p2: { time: T0 + 600_000, price: 6 },
});
check("anchor: exactly on p1", anchorHitZone(trend, 0, 500, toX, toY, TOL) === "p1");
check("anchor: near p1 (dist ~4.2)", anchorHitZone(trend, 3, 503, toX, toY, TOL) === "p1");
check("anchor: exactly on p2", anchorHitZone(trend, 100, 400, toX, toY, TOL) === "p2");
check("anchor: near p2 (dist ~4.2)", anchorHitZone(trend, 97, 397, toX, toY, TOL) === "p2");
check("anchor: segment midpoint is body, not anchor", anchorHitZone(trend, 50, 450, toX, toY, TOL) === null);
check("anchor: just outside tol of p1 (9px)", anchorHitZone(trend, 9, 500, toX, toY, TOL) === null);
check("anchor: at exactly tol of p1 is NOT an anchor (strict <)", anchorHitZone(trend, 8, 500, toX, toY, TOL) === null);
check("anchor: far away", anchorHitZone(trend, 300, 100, toX, toY, TOL) === null);

// p1 wins when both endpoints are within tolerance (very short line),
// matching the pointerdown precedence (p1 checked first).
const stub: Drawing = createDrawing("trendline", {
  p1: { time: T0, price: 5 },
  p2: { time: T0 + 60_000, price: 5 },        // -> (10, 500)
});
check("anchor: overlapping endpoints prefer p1", anchorHitZone(stub, 5, 500, toX, toY, TOL) === "p1");
check("anchor: nearer p2 only", anchorHitZone(stub, 14, 500, toX, toY, TOL) === "p2");

/* ---------------- anchorHitZone: type coverage ---------------------- */
const rect: Drawing = createDrawing("rect", {
  p1: { time: T0, price: 5 },
  p2: { time: T0 + 600_000, price: 6 },
});
check("anchor: rect corner is p1", anchorHitZone(rect, 0, 500, toX, toY, TOL) === "p1");
check("anchor: rect corner is p2", anchorHitZone(rect, 100, 400, toX, toY, TOL) === "p2");

const arrow: Drawing = createDrawing("arrow", {
  p1: { time: T0, price: 5 },
  p2: { time: T0 + 600_000, price: 6 },
});
check("anchor: arrow tip is p2", anchorHitZone(arrow, 100, 400, toX, toY, TOL) === "p2");

const hline: Drawing = createDrawing("hline", { price: 5 });
check("anchor: hline has no anchors", anchorHitZone(hline, 0, 500, toX, toY, TOL) === null);

const vline: Drawing = createDrawing("vline", { time: T0, p1: { time: T0, price: 5 } });
check("anchor: vline has no anchors", anchorHitZone(vline, 0, 500, toX, toY, TOL) === null);

const incomplete: Drawing = createDrawing("trendline", { p1: { time: T0, price: 5 } });
check("anchor: missing p2 -> null", anchorHitZone(incomplete, 0, 500, toX, toY, TOL) === null);

const nullToX = () => null;
check("anchor: unconvertible coords -> null", anchorHitZone(trend, 0, 500, nullToX, toY, TOL) === null);

/* ---------------- drawingCursor: decision table --------------------- */
check("cursor: dragging + body -> grabbing", drawingCursor({ dragging: true, zone: "body" }) === "grabbing");
check("cursor: dragging + anchor -> grabbing", drawingCursor({ dragging: true, zone: "p1" }) === "grabbing");
check("cursor: dragging + no zone -> grabbing", drawingCursor({ dragging: true, zone: null }) === "grabbing");
check("cursor: hover body -> grab", drawingCursor({ dragging: false, zone: "body" }) === "grab");
check("cursor: hover p1 handle -> move", drawingCursor({ dragging: false, zone: "p1" }) === "move");
check("cursor: hover p2 handle -> move", drawingCursor({ dragging: false, zone: "p2" }) === "move");
check("cursor: hover nothing -> null (caller default)", drawingCursor({ dragging: false, zone: null }) === null);

/* ---------------- distToSegment: hit-threshold foundation ----------- */
// hitTestDrawing treats dist <= tol as a hit; tol is 8 (mouse) / 16 (touch).
check("dist: point on segment = 0", approx(distToSegment(50, 0, 0, 0, 100, 0), 0));
check("dist: perpendicular distance", approx(distToSegment(50, 8, 0, 0, 100, 0), 8));
check("dist: just inside mouse tol", distToSegment(50, 7.9, 0, 0, 100, 0) < TOL);
check("dist: just outside mouse tol", distToSegment(50, 8.1, 0, 0, 100, 0) > TOL);
check("dist: beyond endpoint clamps to endpoint", approx(distToSegment(130, 0, 0, 0, 100, 0), 30));
check("dist: degenerate segment = point distance", approx(distToSegment(5, 9, 5, 5, 5, 5), 4));
check("dist: diagonal midpoint", approx(distToSegment(50, 450, 0, 500, 100, 400), 0));

console.log(`drawings tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
