/**
 * quotaGate.ts — the client-side "can this user open one more
 * position right now?" predicate for the subscription daily quota.
 *
 * WHY THIS EXISTS (2026-10-19): the database enforces the Free
 * plan's 3-trades/day cap only when a trade is RECORDED — a Daily
 * Replay draft insert, a simulator session save, a real-trade
 * insert. Inside the Replay Lab a free user could therefore keep
 * EXECUTING buys all day and only learn about the cap afterwards,
 * when the save was refused. This gate moves the visible wall to
 * the moment of the 4th buy attempt: the order never executes and
 * the user gets the upgrade path instead.
 *
 * It changes NO counting semantics: the database still consumes
 * quota at exactly the same points (draft insert / session save /
 * trade insert), and it remains the authoritative backstop. This
 * predicate only predicts that consumption for the UI, from:
 *   - dailyUsed:     the server count from usage_status()
 *                    (UsageStatus.trades_used), refreshed at
 *                    session/attempt start and after every
 *                    successful save, and
 *   - sessionOpened: new positions opened in this page session
 *                    since that refresh — each one will consume
 *                    exactly one daily slot when it is recorded.
 *
 * Guests are OUT OF SCOPE: signedIn=false returns true (ungated)
 * so the separate guest limit (lib/guestTrades) keeps owning them,
 * exactly as before.
 */
import { FREE_TRADES_PER_DAY } from "./entitlements";

export interface QuotaGateInput {
  /** A signed-in account (false = guest; guests are never gated here). */
  signedIn: boolean;
  /** Entitlement from usage_status(); Pro is never gated. */
  isPro: boolean;
  /** Server-side daily trades used (usage_status().trades_used). */
  dailyUsed: number;
  /** New positions opened this page session since the last server refresh. */
  sessionOpened: number;
  /** Daily cap; defaults to FREE_TRADES_PER_DAY. */
  dailyLimit?: number;
}

/** Counts arrive from the network/local state; never let a NaN or a
 *  negative poison the comparison. */
function saneCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function saneLimit(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : FREE_TRADES_PER_DAY;
}

/** Trades that will count against today once everything open is recorded. */
export function quotaCombinedUsed(input: QuotaGateInput): number {
  return saneCount(input.dailyUsed) + saneCount(input.sessionOpened);
}

/**
 * True when one more NEW position may open. Mirrors the approved
 * formula: signed-in Free users are gated on the combined count;
 * Pro users and guests are never gated by this predicate.
 */
export function canOpenPosition(input: QuotaGateInput): boolean {
  if (!input.signedIn) return true;
  if (input.isPro) return true;
  return quotaCombinedUsed(input) < saneLimit(input.dailyLimit);
}

/**
 * Count CLOSED trade cycles in a fills array — the exact regroup
 * the server runs inside save_replay_session (subscriptions-v1.sql):
 * the position is the signed sum of qty (buy +, sell −); a cycle
 * closes when the position returns to flat; a cycle still open at
 * the end never counts. The replay page folds this into its local
 * quota floor after each successful save, so the buy gate keeps a
 * truthful count of what the save just recorded even when the
 * follow-up usage_status() read is unavailable.
 */
export function countClosedCycles(
  fills: readonly { side: string; qty: number }[]
): number {
  let pos = 0;
  let inCycle = false;
  let closed = 0;
  for (const f of fills) {
    const q = Number(f.qty) || 0;
    pos += f.side === "buy" ? q : -q;
    if (pos !== 0) inCycle = true;
    if (inCycle && Math.abs(pos) < 1e-9) {
      closed++;
      inCycle = false;
    }
  }
  return closed;
}
