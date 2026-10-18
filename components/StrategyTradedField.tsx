"use client";

/**
 * StrategyTradedField — the shared "Strategy traded" annotation
 * control (journal Trade Review, real-trade form, Daily Replay
 * draft review). One registry, three hosts: the strategy list is the
 * user's existing `strategies` table (the same registry Daily Replay
 * strategy versions live in), referenced by stable ID.
 *
 * Selection model: the trader picks an existing strategy row, an
 * unmaterialized PRESET (config-only in lib/strategyClassification),
 * or "＋ New custom strategy…". Presets/customs become real registry
 * rows only at SAVE time (resolveTradedStrategyId), idempotently —
 * matched on (family, lower(name)) first, so re-saving never
 * duplicates a strategy. journal_trade_meta always stores the
 * resolved UUID in strategy_id, never a label.
 *
 * The setup classification's options follow the selected strategy's
 * classification family. Switching strategy with an incompatible
 * classification CLEARS the field and flags it ("Select a
 * classification for this strategy") — an incompatible value is
 * never silently retained and never auto-mapped.
 *
 * This component renders ONLY when the annotation migration is
 * applied (the hosts probe first — lib/strategyClassification
 * probeStrategyAnnotationSupport). In dark mode it is never mounted
 * and the meta save payloads omit the new columns entirely, so the
 * app behaves exactly as it did before the feature.
 */
import { useMemo, useState } from "react";
import type { createClient } from "../lib/supabaseClient";
import type { Strategy, StrategyVersion } from "../lib/strategies";
import {
  CLASSIFICATION_FAMILIES,
  STRATEGY_PRESETS,
  classificationOptionsFor,
  effectiveClassification,
  findMaterializedStrategy,
  isClassificationFamily,
  resolveStrategyFamily,
  switchClassification,
  type ClassificationFamily,
} from "../lib/strategyClassification";

export interface TradedStrategyValue {
  mode: "none" | "existing" | "preset" | "new";
  /** strategies.id when mode === "existing". */
  strategyId: string | null;
  /** STRATEGY_PRESETS slug when mode === "preset". */
  presetSlug: string | null;
  /** Draft name when mode === "new". */
  customName: string;
  /** Vocabulary family when mode === "new". */
  customFamily: ClassificationFamily;
  /** Recorded classification slug (meta.setup_class). */
  setupClass: string | null;
  /** Optional free label for the Other / Experimental family. */
  customLabel: string | null;
  /** What caused the entry (meta.entry_trigger). */
  entryTrigger: string | null;
}

export function emptyTradedStrategyValue(): TradedStrategyValue {
  return {
    mode: "none", strategyId: null, presetSlug: null,
    customName: "", customFamily: "generic",
    setupClass: null, customLabel: null, entryTrigger: null,
  };
}

/** The classification family a registry strategy uses: its recorded
 *  classification_family when present, else read-time derivation
 *  from its latest version's setup type (never written back). */
export function familyOfStrategy(
  strategy: Strategy | null | undefined,
  versions: StrategyVersion[],
): ClassificationFamily {
  if (!strategy) return "generic";
  return resolveStrategyFamily({
    classificationFamily: strategy.classificationFamily,
    versions: versions
      .filter((v) => v.strategyId === strategy.id)
      .map((v) => ({ version: v.version, setupType: v.setupType })),
  });
}

/**
 * Initial form state from a stored meta row. The classification
 * starts from the EFFECTIVE classification (recorded slug, else the
 * legacy hod_class coalesce) so a historical HOD trade shows its
 * classification in the new field — display only; nothing is
 * written until the trader saves, and no strategy is ever inferred:
 * without a recorded strategy_id the selector starts empty unless a
 * host passes `suggestedStrategyId` (a Daily Replay attempt's bound
 * strategy, pre-selected as a suggestion the trader can override).
 */
export function tradedValueFromMeta(
  meta: {
    strategy_id?: string | null;
    setup_class?: string | null;
    hod_class?: string | null;
    strategy_custom_label?: string | null;
    entry_trigger?: string | null;
  } | null | undefined,
  opts?: { suggestedStrategyId?: string | null },
): TradedStrategyValue {
  const base = emptyTradedStrategyValue();
  const eff = effectiveClassification({
    setup_class: meta?.setup_class ?? null,
    hod_class: meta?.hod_class ?? null,
  });
  const recordedId = typeof meta?.strategy_id === "string" && meta.strategy_id ? meta.strategy_id : null;
  const suggested = opts?.suggestedStrategyId ?? null;
  return {
    ...base,
    mode: recordedId ? "existing" : suggested ? "existing" : "none",
    strategyId: recordedId ?? suggested,
    setupClass: eff?.slug ?? null,
    customLabel: meta?.strategy_custom_label ?? null,
    entryTrigger: meta?.entry_trigger ?? null,
  };
}

/**
 * Resolve the form value to the strategies.id to persist, creating
 * the registry row for a preset/custom selection when none exists
 * yet. Idempotent: the (family, lower(name)) guard runs first, so a
 * retried save reuses the row it created last time. Returns null
 * when nothing is selected. Throws on persistence failure — callers
 * surface it as a save error and write nothing.
 */
export async function resolveTradedStrategyId(
  client: ReturnType<typeof createClient>,
  userId: string,
  value: TradedStrategyValue,
  strategies: Strategy[],
  versions: StrategyVersion[],
): Promise<string | null> {
  if (value.mode === "existing") return value.strategyId;
  if (value.mode === "none") return null;
  let name: string;
  let family: ClassificationFamily;
  if (value.mode === "preset") {
    const preset = STRATEGY_PRESETS.find((p) => p.slug === value.presetSlug);
    if (!preset) return null;
    name = preset.label;
    family = preset.family;
  } else {
    name = value.customName.trim();
    if (!name) throw new Error("Name the new strategy first — or pick an existing one.");
    family = value.customFamily;
  }
  const entries = strategies.map((s) => ({ ...s, family: familyOfStrategy(s, versions) }));
  const existing = findMaterializedStrategy(entries, family, name);
  if (existing) return existing.id;
  const { data, error } = await client
    .from("strategies")
    .insert({ user_id: userId, name, classification_family: family })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export default function StrategyTradedField(props: {
  strategies: Strategy[];
  versions: StrategyVersion[];
  value: TradedStrategyValue;
  onChange: (v: TradedStrategyValue) => void;
}) {
  const { strategies, versions, value, onChange } = props;
  const [needsSelection, setNeedsSelection] = useState(false);

  /** The family the classification vocabulary follows right now. */
  const family: ClassificationFamily = useMemo(() => {
    if (value.mode === "existing") {
      return familyOfStrategy(strategies.find((s) => s.id === value.strategyId) ?? null, versions);
    }
    if (value.mode === "preset") {
      return STRATEGY_PRESETS.find((p) => p.slug === value.presetSlug)?.family ?? "generic";
    }
    if (value.mode === "new") return value.customFamily;
    return "generic";
  }, [value.mode, value.strategyId, value.presetSlug, value.customFamily, strategies, versions]);

  const options = useMemo(() => classificationOptionsFor(family), [family]);
  /** Presets not yet materialized as registry rows (same guard the
   *  save-time materialization uses, so the list and the write agree). */
  const unmaterializedPresets = useMemo(() => {
    const entries = strategies.map((s) => ({ ...s, family: familyOfStrategy(s, versions) }));
    return STRATEGY_PRESETS.filter((p) => !findMaterializedStrategy(entries, p.family, p.label));
  }, [strategies, versions]);

  const selectValue =
    value.mode === "existing" ? `id:${value.strategyId ?? ""}`
    : value.mode === "preset" ? `preset:${value.presetSlug ?? ""}`
    : value.mode === "new" ? "__new"
    : "";

  /** Apply the switching rule against a NEW family: keep the current
   *  classification only when the new vocabulary contains it. */
  const withFamily = (next: TradedStrategyValue, newFamily: ClassificationFamily): TradedStrategyValue => {
    const res = switchClassification(next.setupClass, newFamily);
    setNeedsSelection(res.needsSelection);
    return { ...next, setupClass: res.value };
  };

  const handleStrategySelect = (raw: string) => {
    if (raw === "") {
      onChange(withFamily({ ...value, mode: "none", strategyId: null, presetSlug: null }, "generic"));
    } else if (raw === "__new") {
      onChange(withFamily({ ...value, mode: "new", strategyId: null, presetSlug: null }, value.customFamily));
    } else if (raw.startsWith("id:")) {
      const id = raw.slice(3);
      const strat = strategies.find((s) => s.id === id) ?? null;
      onChange(withFamily({ ...value, mode: "existing", strategyId: id, presetSlug: null }, familyOfStrategy(strat, versions)));
    } else if (raw.startsWith("preset:")) {
      const slug = raw.slice("preset:".length);
      const preset = STRATEGY_PRESETS.find((p) => p.slug === slug);
      onChange(withFamily({ ...value, mode: "preset", strategyId: null, presetSlug: slug }, preset?.family ?? "generic"));
    }
  };

  // The stored classification can be incompatible with the selected
  // strategy's family on load (e.g. the family was derived from a
  // newer version) — flag it instead of displaying a value the
  // vocabulary does not contain.
  const classCompatible = value.setupClass == null || options.some((o) => o.slug === value.setupClass);
  const showFlag = needsSelection || !classCompatible;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="field">
        <label>Strategy traded</label>
        <select className="input" value={selectValue} onChange={(e) => handleStrategySelect(e.target.value)}>
          <option value="">— Select —</option>
          {strategies.map((s) => (
            <option key={s.id} value={`id:${s.id}`}>{s.name}{s.archivedAt ? " (archived)" : ""}</option>
          ))}
          {unmaterializedPresets.map((p) => (
            <option key={p.slug} value={`preset:${p.slug}`}>{p.label}</option>
          ))}
          <option value="__new">＋ New custom strategy…</option>
        </select>
      </div>
      {value.mode === "new" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label>New strategy name</label>
            <input
              className="input"
              value={value.customName}
              onChange={(e) => onChange({ ...value, customName: e.target.value })}
              placeholder="e.g. Opening range breakout"
            />
          </div>
          <div className="field">
            <label>Classification family</label>
            <select
              className="input"
              value={value.customFamily}
              onChange={(e) => {
                const fam = isClassificationFamily(e.target.value) ? e.target.value : "generic";
                onChange(withFamily({ ...value, customFamily: fam }, fam));
              }}
            >
              {CLASSIFICATION_FAMILIES.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      <div className="field">
        <label>Setup classification</label>
        <select
          className="input"
          value={classCompatible ? (value.setupClass ?? "") : ""}
          onChange={(e) => { setNeedsSelection(false); onChange({ ...value, setupClass: e.target.value || null }); }}
        >
          <option value="">—</option>
          {options.map((o) => <option key={o.slug} value={o.slug}>{o.label}</option>)}
        </select>
        {showFlag && (
          <div style={{ fontSize: 12, color: "#fbbf24", marginTop: 4 }}>
            Select a classification for this strategy — the previous one does not apply to it.
          </div>
        )}
      </div>
      {family === "other" && (
        <div className="field">
          <label>Custom label (optional)</label>
          <input
            className="input"
            value={value.customLabel ?? ""}
            onChange={(e) => onChange({ ...value, customLabel: e.target.value || null })}
            placeholder="Describe the setup in your own words"
          />
        </div>
      )}
      <div className="field">
        <label>Entry trigger</label>
        <input
          className="input"
          value={value.entryTrigger ?? ""}
          onChange={(e) => onChange({ ...value, entryTrigger: e.target.value || null })}
          placeholder="What caused the entry — e.g. bullish reversal candle at VWAP"
        />
      </div>
    </div>
  );
}
