/**
 * strategyClassification.ts — Strategy-aware journaling: the one
 * classification config for per-trade setup classification (prepared
 * migration: supabase/migrations/journal-strategy-annotation-v1.sql).
 *
 * One-registry model: there is exactly ONE strategy registry — the
 * existing `strategies` table (see lib/strategies.ts). A journal
 * trade may be annotated against a strategy in that registry
 * (journal_trade_meta.strategy_id); this module does NOT introduce a
 * second registry, a second strategy type, or a separate list of
 * strategies. What it owns is the CLASSIFICATION vocabulary that sits
 * alongside that annotation: a strategy (or a bare annotation) belongs
 * to a classification FAMILY, and each family has its own closed set
 * of classification option slugs (e.g. a HOD breakout is "clean",
 * "weak", "failed" or "anticipation" in spirit, stored below with
 * family-specific slugs so labels stay unambiguous).
 *
 * Slug storage: the classification slug is stored in
 * journal_trade_meta.setup_class as plain text, DELIBERATELY with no
 * database CHECK constraint. The vocabulary evolves in this file (new
 * families, renamed labels, experimental slugs) without a migration
 * per change, and an unknown slug read back from the database is
 * passed through — never rejected, never crashed on. Validation
 * against the option sets below is a UI/write-time concern only.
 *
 * Read coalesce (the ONE place legacy data meets the new field):
 * effectiveClassification() is the only coalesce. A recorded
 * setup_class wins; otherwise the legacy hod_class column is mapped
 * forward via LEGACY_HOD_CLASS_TO_SLUG. hod_class is NEVER migrated
 * or backfilled — existing rows keep hod_class exactly as stored and
 * setup_class stays NULL (= "not recorded" in the new field) until an
 * annotation is actually saved. Nothing in this module (or the
 * migration) invents a strategy for a trade: classification is not
 * strategy identity, and an unclassified trade stays unclassified.
 *
 * No-backfill rule: strategies.classification_family likewise stays
 * NULL on existing rows. resolveStrategyFamily() derives a family at
 * READ time only (explicit column wins, otherwise the latest strategy
 * version's setup type) — the derived value is never written back.
 *
 * Dark-mode probe: the feature ships dark. Until the prepared
 * migration is applied, the annotation columns do not exist and any
 * query naming them errors. probeStrategyAnnotationSupport() probes
 * both tables for exactly those columns; callers must gate every
 * annotation read/write on it returning true, so a pre-migration
 * database simply keeps the feature hidden instead of erroring.
 *
 * This module is pure config and pure functions — no framework, no
 * persistence — except the probe, which only calls the structural
 * select/limit surface of the client it is handed.
 */

export type ClassificationFamily =
  | "hod_breakout"
  | "support"
  | "vwap"
  | "ema_pullback"
  | "resistance_rejection"
  | "other"
  | "generic";

export interface ClassificationOption {
  slug: string;
  label: string;
}

export interface StrategyPreset {
  slug: string;
  label: string;
  family: ClassificationFamily;
}

export const CLASSIFICATION_FAMILIES: { value: ClassificationFamily; label: string }[] = [
  { value: "hod_breakout", label: "HOD Breakout" },
  { value: "support", label: "Support" },
  { value: "vwap", label: "VWAP" },
  { value: "ema_pullback", label: "EMA Pullback" },
  { value: "resistance_rejection", label: "Resistance Rejection" },
  { value: "other", label: "Other / Experimental" },
  { value: "generic", label: "Generic" },
];

export function isClassificationFamily(v: unknown): v is ClassificationFamily {
  return (
    v === "hod_breakout" ||
    v === "support" ||
    v === "vwap" ||
    v === "ema_pullback" ||
    v === "resistance_rejection" ||
    v === "other" ||
    v === "generic"
  );
}

const GENERIC_CLASSIFICATION_OPTIONS: ClassificationOption[] = [
  { slug: "clean", label: "Clean" },
  { slug: "weak", label: "Weak" },
  { slug: "failed", label: "Failed" },
  { slug: "anticipation", label: "Anticipation" },
];

export const CLASSIFICATION_OPTIONS: Record<ClassificationFamily, ClassificationOption[]> = {
  hod_breakout: [
    { slug: "clean_breakout", label: "Clean Breakout" },
    { slug: "weak_breakout", label: "Weak Breakout" },
    { slug: "failed_breakout", label: "Failed Breakout" },
    { slug: "anticipation", label: "Anticipation" },
  ],
  support: [
    { slug: "strong_support_reaction", label: "Strong Support Reaction" },
    { slug: "weak_support_reaction", label: "Weak Support Reaction" },
    { slug: "support_breakdown", label: "Support Breakdown" },
    { slug: "anticipation", label: "Anticipation" },
  ],
  vwap: [
    { slug: "clean_reclaim_hold", label: "Clean Reclaim / Hold" },
    { slug: "weak_reclaim", label: "Weak Reclaim" },
    { slug: "failed_reclaim", label: "Failed Reclaim" },
    { slug: "anticipation", label: "Anticipation" },
  ],
  ema_pullback: [
    { slug: "clean_ema_reaction", label: "Clean EMA Reaction" },
    { slug: "weak_ema_reaction", label: "Weak EMA Reaction" },
    { slug: "ema_breakdown", label: "EMA Breakdown" },
    { slug: "anticipation", label: "Anticipation" },
  ],
  resistance_rejection: [
    { slug: "strong_rejection", label: "Strong Rejection" },
    { slug: "weak_rejection", label: "Weak Rejection" },
    { slug: "resistance_breakout", label: "Resistance Breakout" },
    { slug: "anticipation", label: "Anticipation" },
  ],
  other: GENERIC_CLASSIFICATION_OPTIONS,
  generic: GENERIC_CLASSIFICATION_OPTIONS,
};

export const STRATEGY_PRESETS: StrategyPreset[] = [
  { slug: "hod-breakout", label: "HOD Breakout", family: "hod_breakout" },
  { slug: "support-bounce", label: "Support Bounce", family: "support" },
  { slug: "support-pullback", label: "Support Pullback", family: "support" },
  { slug: "vwap-pullback", label: "VWAP Pullback", family: "vwap" },
  { slug: "vwap-reclaim", label: "VWAP Reclaim", family: "vwap" },
  { slug: "ema-pullback", label: "EMA Pullback", family: "ema_pullback" },
  { slug: "resistance-rejection", label: "Resistance Rejection", family: "resistance_rejection" },
  { slug: "other-experimental", label: "Other / Experimental", family: "other" },
];

/**
 * The classification options for a family. A null/undefined/invalid
 * family falls back to the generic set — callers always get a usable
 * option list, never undefined.
 */
export function classificationOptionsFor(
  family: ClassificationFamily | null | undefined,
): ClassificationOption[] {
  return isClassificationFamily(family)
    ? CLASSIFICATION_OPTIONS[family]
    : CLASSIFICATION_OPTIONS.generic;
}

/**
 * The label for a classification slug, searching every family's
 * option set (first match wins). Null when the slug is null/unknown —
 * callers decide whether to fall back to the raw slug.
 */
export function classificationLabel(slug: string | null | undefined): string | null {
  if (!slug) return null;
  for (const { value } of CLASSIFICATION_FAMILIES) {
    const hit = CLASSIFICATION_OPTIONS[value].find((o) => o.slug === slug);
    if (hit) return hit.label;
  }
  return null;
}

/**
 * The family a classification slug belongs to — ONLY when the slug
 * appears in exactly one family's option set. A slug shared by
 * several sets (e.g. "anticipation", present in every set) is
 * ambiguous and returns null, as does an unknown slug.
 */
export function familyOfClassificationSlug(
  slug: string | null | undefined,
): ClassificationFamily | null {
  if (!slug) return null;
  let found: ClassificationFamily | null = null;
  let count = 0;
  for (const { value } of CLASSIFICATION_FAMILIES) {
    if (CLASSIFICATION_OPTIONS[value].some((o) => o.slug === slug)) {
      found = value;
      count++;
    }
  }
  return count === 1 ? found : null;
}

export const LEGACY_HOD_CLASS_TO_SLUG: Record<string, string> = {
  clean: "clean_breakout",
  weak: "weak_breakout",
  failed: "failed_breakout",
  anticipation: "anticipation",
};

/**
 * The ONE read-coalesce for a trade's classification. setup_class
 * wins when recorded (label via classificationLabel, falling back to
 * the raw slug; family via familyOfClassificationSlug, falling back
 * to "generic"); otherwise the legacy hod_class is mapped forward
 * via LEGACY_HOD_CLASS_TO_SLUG with family "hod_breakout". Returns
 * null when neither is recorded. Classification only — this NEVER
 * invents a strategy for the trade.
 */
export function effectiveClassification(meta: {
  setup_class?: string | null;
  hod_class?: string | null;
}): { slug: string; label: string; family: ClassificationFamily } | null {
  if (meta.setup_class) {
    const slug = meta.setup_class;
    return {
      slug,
      label: classificationLabel(slug) ?? slug,
      family: familyOfClassificationSlug(slug) ?? "generic",
    };
  }
  if (meta.hod_class) {
    const slug = LEGACY_HOD_CLASS_TO_SLUG[meta.hod_class];
    if (!slug) return null;
    return {
      slug,
      label: classificationLabel(slug) ?? slug,
      family: "hod_breakout",
    };
  }
  return null;
}

/**
 * Map a strategy version's setup type (see lib/strategies.ts) to a
 * classification family. Anything unrecognized — including "custom"
 * and null — derives to "generic".
 */
export function familyForSetupType(setupType: string | null | undefined): ClassificationFamily {
  switch (setupType) {
    case "hod_breakout":
      return "hod_breakout";
    case "ema_pullback":
      return "ema_pullback";
    case "vwap_pullback":
      return "vwap";
    default:
      return "generic";
  }
}

/**
 * Resolve a strategy's classification family at READ time only: a
 * valid stored classificationFamily wins; otherwise derive from the
 * LATEST version (max version number) via familyForSetupType;
 * otherwise "generic". The derived value is never written back (see
 * the no-backfill rule in the header).
 */
export function resolveStrategyFamily(input: {
  classificationFamily?: unknown;
  versions?: { version: number; setupType: string }[] | null;
}): ClassificationFamily {
  if (isClassificationFamily(input.classificationFamily)) {
    return input.classificationFamily;
  }
  const versions = input.versions;
  if (versions && versions.length > 0) {
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    return familyForSetupType(latest.setupType);
  }
  return "generic";
}

/**
 * The strategy-switch rule: when the family changes, the current
 * classification slug is kept (needsSelection false) only when it is
 * in the new family's option set — note "anticipation" is in every
 * set, so it survives any switch. An incompatible recorded value is
 * cleared with needsSelection true; when nothing was selected the
 * result is { value: null, needsSelection: false }.
 */
export function switchClassification(
  currentSlug: string | null,
  newFamily: ClassificationFamily,
): { value: string | null; needsSelection: boolean } {
  if (!currentSlug) return { value: null, needsSelection: false };
  const options = classificationOptionsFor(newFamily);
  if (options.some((o) => o.slug === currentSlug)) {
    return { value: currentSlug, needsSelection: false };
  }
  return { value: null, needsSelection: true };
}

/**
 * The idempotent-materialization guard: find an already-materialized
 * strategy entry for a preset — match on family plus the entry name,
 * trimmed and case-insensitive. Preset materialization must look here
 * first so saving the same preset twice never creates a duplicate.
 */
export function findMaterializedStrategy<
  T extends { id: string; name: string; family: ClassificationFamily },
>(entries: T[], family: ClassificationFamily, name: string): T | undefined {
  const wanted = name.trim().toLowerCase();
  return entries.find(
    (e) => e.family === family && e.name.trim().toLowerCase() === wanted,
  );
}

interface ProbeQuery {
  limit(n: number): Promise<{ error: unknown }>;
}

interface ProbeTable {
  select(cols: string): ProbeQuery;
}

interface ProbeClient {
  from(table: string): ProbeTable;
}

/**
 * The feature's dark-mode gate (see header): probe journal_trade_meta
 * for the annotation columns and strategies for classification_family
 * (limit 1 each). True only when BOTH return no error; any error or
 * throw → false. Pre-migration databases error on the missing columns,
 * which is exactly the signal that keeps the feature dark.
 */
export async function probeStrategyAnnotationSupport(client: ProbeClient): Promise<boolean> {
  try {
    const meta = await client
      .from("journal_trade_meta")
      .select("strategy_id,setup_class,strategy_custom_label,entry_trigger")
      .limit(1);
    if (meta.error) return false;
    const strategies = await client
      .from("strategies")
      .select("classification_family")
      .limit(1);
    if (strategies.error) return false;
    return true;
  } catch {
    return false;
  }
}
