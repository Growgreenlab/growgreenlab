/**
 * drRepresentative.ts — pure resolution of a Daily Replay trade's ONE
 * representative screenshot (Representative Screenshot plan §2.2/§5,
 * Stage 1). The representative is a RESOLUTION RESULT computed from
 * data that already exists — the draft row's `auto_capture` JSONB plus
 * the trade's storage listing. Nothing is renamed, copied or uploaded:
 * "representative" is a role, recorded in the export manifest and
 * badged in review UIs.
 *
 * Precedence (plan R3, deterministic):
 *   1. an explicit user selection (`auto_capture.representative.path`)
 *      that still validates — source "user_selected";
 *   2. the captured entry auto-capture — source "auto_entry" (the
 *      image staged at the entry fill; the entry candle was still
 *      forming, which is exactly the entry-time evidence);
 *   3. the trade's ONLY listed image — source "single_attachment"
 *      (the legacy/no-draft fallback: no typing is invented for it);
 *   4. otherwise null — no representative, stated honestly downstream.
 *
 * The EXIT auto-capture is NEVER a default representative: it is
 * captured after network round trips at close-processing time, so it
 * is post-entry evidence. It can become the representative only by
 * explicit user selection (branch 1).
 *
 * Validation (plan R2): a recorded path counts only if it appears in
 * the trade's own listing AND sits under one of the trade's two own
 * storage prefixes ({userId}/{segment(draftKey)}/… or
 * {userId}/{segment(finalizedTradeKey)}/…). A stale path (no longer
 * listed) falls through to the next branch; a foreign path (another
 * trade's or another user's prefix) is rejected outright, never
 * followed. Owner-folder storage isolation is preserved exactly.
 */
import { segment } from "./journalAttachments";

export type RepresentativeSource = "user_selected" | "auto_entry" | "single_attachment";

export interface RepresentativeResult {
  /** Full storage path of the representative image. */
  path: string;
  source: RepresentativeSource;
  /** Candle index the image is anchored to, when the record carries
   *  one (auto_entry always; user_selected only when the selected
   *  path IS one of the recorded capture outcomes). Null when the
   *  timing is unknown — never inferred from a file name. */
  candleIndex: number | null;
}

export interface AutoCaptureSideLike {
  path?: string;
  candleIndex?: number;
  status?: string;
}

function sideOf(raw: unknown): AutoCaptureSideLike | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    path: typeof o.path === "string" && o.path.length > 0 ? o.path : undefined,
    candleIndex: typeof o.candleIndex === "number" && Number.isFinite(o.candleIndex) ? o.candleIndex : undefined,
    status: typeof o.status === "string" ? o.status : undefined,
  };
}

function selectedPathOf(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = (raw as Record<string, unknown>).path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

export interface ResolveRepresentativeInput {
  /** The draft row's auto_capture JSONB (undefined/null for trades
   *  that never had a draft — legacy finalized DR trades). */
  autoCapture: Record<string, unknown> | null | undefined;
  /** Storage paths listed for this trade (union of its prefixes). */
  listedPaths: string[];
  /** The trade's draft key, when a draft exists. */
  draftKey: string | null;
  /** The trade's canonical (finalized) key — its journal trade key. */
  finalizedTradeKey: string | null;
  /** Owner id — first segment of every storage path. */
  userId: string;
  /** Draft status when known; a superseded-generation draft never
   *  resolves (its trades do not exist in the journal). */
  draftStatus?: string | null;
}

export function resolveRepresentative(input: ResolveRepresentativeInput): RepresentativeResult | null {
  if (input.draftStatus === "superseded") return null;
  const listed = new Set(input.listedPaths);
  const prefixes: string[] = [];
  if (input.draftKey) prefixes.push(`${input.userId}/${segment(input.draftKey)}/`);
  if (input.finalizedTradeKey) prefixes.push(`${input.userId}/${segment(input.finalizedTradeKey)}/`);
  const valid = (p: string): boolean =>
    listed.has(p) && prefixes.some((pre) => p.startsWith(pre));

  const ac = input.autoCapture ?? {};
  const entry = sideOf(ac.entry);
  const exit = sideOf(ac.exit);

  // 1. Explicit user selection (validated like any recorded path).
  const sel = selectedPathOf(ac.representative);
  if (sel && valid(sel)) {
    // Timing metadata only from a matching recorded outcome — the
    // candle index is never inferred from the file name.
    const timing = entry?.path === sel ? entry : exit?.path === sel ? exit : null;
    return { path: sel, source: "user_selected", candleIndex: timing?.candleIndex ?? null };
  }

  // 2. Captured entry auto-capture.
  if (entry?.path && entry.status === "captured" && valid(entry.path)) {
    return { path: entry.path, source: "auto_entry", candleIndex: entry.candleIndex ?? null };
  }

  // 3. D7 fallback — ONLY when there is no capture record at all
  // (plan §2.2 matrix). If a record exists and the entry outcome is
  // failed/skipped/stale, the platform KNOWS the entry moment was
  // not captured: silently promoting the exit image or an untyped
  // attachment into the entry-evidence slot would mislabel evidence,
  // so the resolution is honestly none. With no record (legacy
  // trades that predate drafts), exactly one listed image is the
  // trade's representative — untyped, exactly the legacy behaviour.
  const hasCaptureRecord = entry != null || exit != null || sel != null;
  if (!hasCaptureRecord && input.listedPaths.length === 1) {
    const only = input.listedPaths[0];
    // The single image still has to sit under one of the trade's own
    // prefixes (listings are built that way; this is the guard).
    if (prefixes.some((pre) => only.startsWith(pre))) {
      return { path: only, source: "single_attachment", candleIndex: null };
    }
    return null;
  }

  return null;
}

/**
 * Return a NEW auto_capture object with `representative` set to the
 * given path — the merge behind "Use as representative". The helper
 * that persists auto_capture replaces the WHOLE JSONB, so the merge
 * must be explicit: existing entry/exit outcomes are preserved
 * untouched (no clobber), and re-selecting the same path is a
 * value-level no-op (idempotent selection).
 */
export function withRepresentativeSelection(
  autoCapture: Record<string, unknown> | null | undefined,
  path: string,
  selectedAt: string,
): Record<string, unknown> {
  return {
    ...(autoCapture ?? {}),
    representative: { path, selectedAt },
  };
}

/** Plain-language source label for badges/manifests. */
export function representativeSourceLabel(r: RepresentativeResult): string {
  switch (r.source) {
    case "user_selected":
      return "selected by you";
    case "auto_entry":
      return r.candleIndex != null
        ? `entry capture — candle #${r.candleIndex + 1} (staged at the entry fill; the candle was still forming)`
        : "entry capture (staged at the entry fill; the candle was still forming)";
    case "single_attachment":
      return "the trade's only screenshot";
  }
}
