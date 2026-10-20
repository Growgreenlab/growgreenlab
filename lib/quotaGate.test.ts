/**
 * quotaGate.test.ts — buy-time daily-quota gate predicate tests.
 * Run: npx -y tsx lib/quotaGate.test.ts
 *
 * Pins: a signed-in Free user may open while (server dailyUsed +
 * sessionOpened) < 3 and is blocked the moment the combined count
 * reaches 3; Pro is never gated; guests are never gated by this
 * predicate (their own limit lives in lib/guestTrades).
 */
import { canOpenPosition, quotaCombinedUsed } from "./quotaGate";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  check(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, a === b);
}

const free = { signedIn: true, isPro: false };

/* ---------- the wall lands exactly on the 4th open ---------- */
eq("free 0 used, 0 opened -> open", canOpenPosition({ ...free, dailyUsed: 0, sessionOpened: 0 }), true);
eq("free 0 used, 1 opened -> open", canOpenPosition({ ...free, dailyUsed: 0, sessionOpened: 1 }), true);
eq("free 0 used, 2 opened -> open (3rd)", canOpenPosition({ ...free, dailyUsed: 0, sessionOpened: 2 }), true);
eq("free 0 used, 3 opened -> BLOCKED (4th)", canOpenPosition({ ...free, dailyUsed: 0, sessionOpened: 3 }), false);
eq("free 1 used, 1 opened -> open", canOpenPosition({ ...free, dailyUsed: 1, sessionOpened: 1 }), true);
eq("free 1 used, 2 opened -> BLOCKED", canOpenPosition({ ...free, dailyUsed: 1, sessionOpened: 2 }), false);
eq("free 2 used, 0 opened -> open (3rd)", canOpenPosition({ ...free, dailyUsed: 2, sessionOpened: 0 }), true);
eq("free 2 used, 1 opened -> BLOCKED", canOpenPosition({ ...free, dailyUsed: 2, sessionOpened: 1 }), false);
eq("free 3 used, 0 opened -> BLOCKED", canOpenPosition({ ...free, dailyUsed: 3, sessionOpened: 0 }), false);
eq("free 5 used -> BLOCKED", canOpenPosition({ ...free, dailyUsed: 5, sessionOpened: 0 }), false);

/* ---------- Pro is never gated ---------- */
eq("pro 0/0 -> open", canOpenPosition({ signedIn: true, isPro: true, dailyUsed: 0, sessionOpened: 0 }), true);
eq("pro 3/3 -> open", canOpenPosition({ signedIn: true, isPro: true, dailyUsed: 3, sessionOpened: 3 }), true);
eq("pro 99/99 -> open", canOpenPosition({ signedIn: true, isPro: true, dailyUsed: 99, sessionOpened: 99 }), true);

/* ---------- guests are untouched by this gate ---------- */
eq("guest 0/0 -> allowed by this gate", canOpenPosition({ signedIn: false, isPro: false, dailyUsed: 0, sessionOpened: 0 }), true);
eq("guest 3/3 -> allowed by this gate (guest limit owns guests)", canOpenPosition({ signedIn: false, isPro: false, dailyUsed: 3, sessionOpened: 3 }), true);
eq("guest 99/99 -> allowed by this gate", canOpenPosition({ signedIn: false, isPro: false, dailyUsed: 99, sessionOpened: 99 }), true);

/* ---------- limit handling ---------- */
eq("custom limit 5: 4+0 -> open", canOpenPosition({ ...free, dailyUsed: 4, sessionOpened: 0, dailyLimit: 5 }), true);
eq("custom limit 5: 4+1 -> BLOCKED", canOpenPosition({ ...free, dailyUsed: 4, sessionOpened: 1, dailyLimit: 5 }), false);
eq("limit 0 falls back to the free default (2 used -> open)", canOpenPosition({ ...free, dailyUsed: 2, sessionOpened: 0, dailyLimit: 0 }), true);

/* ---------- combined count + hostile inputs ---------- */
eq("combined 1+2 = 3", quotaCombinedUsed({ ...free, dailyUsed: 1, sessionOpened: 2 }), 3);
eq("combined 0+0 = 0", quotaCombinedUsed({ ...free, dailyUsed: 0, sessionOpened: 0 }), 0);
eq("NaN dailyUsed treated as 0 -> open", canOpenPosition({ ...free, dailyUsed: Number.NaN, sessionOpened: 0 }), true);
eq("negative counts treated as 0 -> open", canOpenPosition({ ...free, dailyUsed: -2, sessionOpened: -1 }), true);
eq("fractional counts floor (2.9 used counts as 2) -> open", canOpenPosition({ ...free, dailyUsed: 2.9, sessionOpened: 0 }), true);

console.log(`=== QUOTA GATE RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
