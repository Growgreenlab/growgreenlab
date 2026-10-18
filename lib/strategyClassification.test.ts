/**
 * strategyClassification.test.ts — pure config tests for
 * lib/strategyClassification.
 * Run: npx tsx lib/strategyClassification.test.ts
 */
import {
  CLASSIFICATION_FAMILIES,
  CLASSIFICATION_OPTIONS,
  STRATEGY_PRESETS,
  LEGACY_HOD_CLASS_TO_SLUG,
  isClassificationFamily,
  classificationOptionsFor,
  classificationLabel,
  familyOfClassificationSlug,
  effectiveClassification,
  familyForSetupType,
  resolveStrategyFamily,
  switchClassification,
  findMaterializedStrategy,
  isUniqueViolation,
  probeStrategyAnnotationSupport,
  type ClassificationFamily,
} from "./strategyClassification";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name} ${extra}`); }
}

function optionsMatch(
  family: ClassificationFamily,
  expected: [string, string][],
) {
  const actual = CLASSIFICATION_OPTIONS[family];
  return (
    actual.length === expected.length &&
    actual.every((o, i) => o.slug === expected[i][0] && o.label === expected[i][1])
  );
}

async function main() {
  // --- Families -------------------------------------------------------------
  check(
    "classification families list",
    JSON.stringify(CLASSIFICATION_FAMILIES) ===
      JSON.stringify([
        { value: "hod_breakout", label: "HOD Breakout" },
        { value: "support", label: "Support" },
        { value: "vwap", label: "VWAP" },
        { value: "ema_pullback", label: "EMA Pullback" },
        { value: "resistance_rejection", label: "Resistance Rejection" },
        { value: "other", label: "Other / Experimental" },
        { value: "generic", label: "Generic" },
      ]),
  );
  check(
    "isClassificationFamily",
    isClassificationFamily("hod_breakout") &&
      isClassificationFamily("generic") &&
      !isClassificationFamily("custom") &&
      !isClassificationFamily(null) &&
      !isClassificationFamily(undefined) &&
      !isClassificationFamily(42),
  );

  // --- Option sets ------------------------------------------------------------
  check(
    "hod_breakout options",
    optionsMatch("hod_breakout", [
      ["clean_breakout", "Clean Breakout"],
      ["weak_breakout", "Weak Breakout"],
      ["failed_breakout", "Failed Breakout"],
      ["anticipation", "Anticipation"],
    ]),
  );
  check(
    "support options",
    optionsMatch("support", [
      ["strong_support_reaction", "Strong Support Reaction"],
      ["weak_support_reaction", "Weak Support Reaction"],
      ["support_breakdown", "Support Breakdown"],
      ["anticipation", "Anticipation"],
    ]),
  );
  check(
    "vwap options",
    optionsMatch("vwap", [
      ["clean_reclaim_hold", "Clean Reclaim / Hold"],
      ["weak_reclaim", "Weak Reclaim"],
      ["failed_reclaim", "Failed Reclaim"],
      ["anticipation", "Anticipation"],
    ]),
  );
  check(
    "ema_pullback options",
    optionsMatch("ema_pullback", [
      ["clean_ema_reaction", "Clean EMA Reaction"],
      ["weak_ema_reaction", "Weak EMA Reaction"],
      ["ema_breakdown", "EMA Breakdown"],
      ["anticipation", "Anticipation"],
    ]),
  );
  check(
    "resistance_rejection options",
    optionsMatch("resistance_rejection", [
      ["strong_rejection", "Strong Rejection"],
      ["weak_rejection", "Weak Rejection"],
      ["resistance_breakout", "Resistance Breakout"],
      ["anticipation", "Anticipation"],
    ]),
  );
  const genericExpected: [string, string][] = [
    ["clean", "Clean"],
    ["weak", "Weak"],
    ["failed", "Failed"],
    ["anticipation", "Anticipation"],
  ];
  check("other options are the generic set", optionsMatch("other", genericExpected));
  check("generic options are the generic set", optionsMatch("generic", genericExpected));
  check(
    "anticipation in every family's option set",
    CLASSIFICATION_FAMILIES.every(({ value }) =>
      CLASSIFICATION_OPTIONS[value].some((o) => o.slug === "anticipation"),
    ),
  );

  // --- Presets ------------------------------------------------------------------
  check("8 presets", STRATEGY_PRESETS.length === 8);
  check(
    "presets slug/label/family",
    JSON.stringify(STRATEGY_PRESETS) ===
      JSON.stringify([
        { slug: "hod-breakout", label: "HOD Breakout", family: "hod_breakout" },
        { slug: "support-bounce", label: "Support Bounce", family: "support" },
        { slug: "support-pullback", label: "Support Pullback", family: "support" },
        { slug: "vwap-pullback", label: "VWAP Pullback", family: "vwap" },
        { slug: "vwap-reclaim", label: "VWAP Reclaim", family: "vwap" },
        { slug: "ema-pullback", label: "EMA Pullback", family: "ema_pullback" },
        { slug: "resistance-rejection", label: "Resistance Rejection", family: "resistance_rejection" },
        { slug: "other-experimental", label: "Other / Experimental", family: "other" },
      ]),
  );

  // --- classificationOptionsFor ---------------------------------------------------
  check(
    "classificationOptionsFor known family",
    classificationOptionsFor("vwap") === CLASSIFICATION_OPTIONS.vwap,
  );
  check(
    "classificationOptionsFor null falls back to generic",
    classificationOptionsFor(null) === CLASSIFICATION_OPTIONS.generic,
  );
  check(
    "classificationOptionsFor undefined falls back to generic",
    classificationOptionsFor(undefined) === CLASSIFICATION_OPTIONS.generic,
  );
  check(
    "classificationOptionsFor invalid falls back to generic",
    classificationOptionsFor("bogus" as ClassificationFamily) ===
      CLASSIFICATION_OPTIONS.generic,
  );

  // --- classificationLabel ---------------------------------------------------------
  check("classificationLabel known", classificationLabel("clean_breakout") === "Clean Breakout");
  check("classificationLabel known vwap", classificationLabel("clean_reclaim_hold") === "Clean Reclaim / Hold");
  check("classificationLabel shared anticipation", classificationLabel("anticipation") === "Anticipation");
  check("classificationLabel generic slug", classificationLabel("clean") === "Clean");
  check("classificationLabel unknown -> null", classificationLabel("nope") === null);
  check("classificationLabel null -> null", classificationLabel(null) === null);
  check("classificationLabel undefined -> null", classificationLabel(undefined) === null);

  // --- familyOfClassificationSlug -----------------------------------------------------
  check("familyOf unique hod slug", familyOfClassificationSlug("clean_breakout") === "hod_breakout");
  check("familyOf unique support slug", familyOfClassificationSlug("support_breakdown") === "support");
  check("familyOf unique vwap slug", familyOfClassificationSlug("weak_reclaim") === "vwap");
  check("familyOf unique ema slug", familyOfClassificationSlug("clean_ema_reaction") === "ema_pullback");
  check("familyOf unique resistance slug", familyOfClassificationSlug("strong_rejection") === "resistance_rejection");
  check("familyOf anticipation ambiguous -> null", familyOfClassificationSlug("anticipation") === null);
  check("familyOf unknown -> null", familyOfClassificationSlug("nope") === null);
  check("familyOf null -> null", familyOfClassificationSlug(null) === null);

  // --- effectiveClassification ------------------------------------------------------------
  const effSetupWins = effectiveClassification({ setup_class: "weak_breakout", hod_class: "clean" });
  check(
    "effectiveClassification setup_class wins over hod_class",
    effSetupWins?.slug === "weak_breakout" &&
      effSetupWins?.label === "Weak Breakout" &&
      effSetupWins?.family === "hod_breakout",
  );
  const legacyCases: [string, string, string][] = [
    ["clean", "clean_breakout", "Clean Breakout"],
    ["weak", "weak_breakout", "Weak Breakout"],
    ["failed", "failed_breakout", "Failed Breakout"],
    ["anticipation", "anticipation", "Anticipation"],
  ];
  check(
    "LEGACY_HOD_CLASS_TO_SLUG exact",
    JSON.stringify(LEGACY_HOD_CLASS_TO_SLUG) ===
      JSON.stringify({
        clean: "clean_breakout",
        weak: "weak_breakout",
        failed: "failed_breakout",
        anticipation: "anticipation",
      }),
  );
  for (const [hod, slug, label] of legacyCases) {
    const eff = effectiveClassification({ hod_class: hod });
    check(
      `effectiveClassification hod fallback ${hod}`,
      eff?.slug === slug && eff?.label === label && eff?.family === "hod_breakout",
    );
    const effNullSetup = effectiveClassification({ setup_class: null, hod_class: hod });
    check(
      `effectiveClassification hod fallback with null setup_class ${hod}`,
      effNullSetup?.slug === slug && effNullSetup?.family === "hod_breakout",
    );
  }
  const effUnknown = effectiveClassification({ setup_class: "my_custom_slug" });
  check(
    "effectiveClassification unknown setup_class passes through",
    effUnknown?.slug === "my_custom_slug" &&
      effUnknown?.label === "my_custom_slug" &&
      effUnknown?.family === "generic",
  );
  const effShared = effectiveClassification({ setup_class: "anticipation" });
  check(
    "effectiveClassification shared slug family falls back to generic",
    effShared?.slug === "anticipation" &&
      effShared?.label === "Anticipation" &&
      effShared?.family === "generic",
  );
  check("effectiveClassification empty meta -> null", effectiveClassification({}) === null);
  check(
    "effectiveClassification null fields -> null",
    effectiveClassification({ setup_class: null, hod_class: null }) === null,
  );

  // --- familyForSetupType ---------------------------------------------------------------------
  check("familyForSetupType hod_breakout", familyForSetupType("hod_breakout") === "hod_breakout");
  check("familyForSetupType ema_pullback", familyForSetupType("ema_pullback") === "ema_pullback");
  check("familyForSetupType vwap_pullback", familyForSetupType("vwap_pullback") === "vwap");
  check("familyForSetupType custom -> generic", familyForSetupType("custom") === "generic");
  check("familyForSetupType null -> generic", familyForSetupType(null) === "generic");
  check("familyForSetupType undefined -> generic", familyForSetupType(undefined) === "generic");
  check("familyForSetupType unknown -> generic", familyForSetupType("whatever") === "generic");

  // --- resolveStrategyFamily ----------------------------------------------------------------------
  check(
    "resolveStrategyFamily explicit wins over versions",
    resolveStrategyFamily({
      classificationFamily: "support",
      versions: [{ version: 1, setupType: "hod_breakout" }],
    }) === "support",
  );
  check(
    "resolveStrategyFamily latest version derivation",
    resolveStrategyFamily({
      versions: [
        { version: 1, setupType: "hod_breakout" },
        { version: 3, setupType: "vwap_pullback" },
        { version: 2, setupType: "ema_pullback" },
      ],
    }) === "vwap",
  );
  check(
    "resolveStrategyFamily invalid explicit falls through to versions",
    resolveStrategyFamily({
      classificationFamily: "bogus",
      versions: [{ version: 1, setupType: "ema_pullback" }],
    }) === "ema_pullback",
  );
  check("resolveStrategyFamily empty -> generic", resolveStrategyFamily({}) === "generic");
  check(
    "resolveStrategyFamily empty versions -> generic",
    resolveStrategyFamily({ versions: [] }) === "generic" &&
      resolveStrategyFamily({ versions: null }) === "generic",
  );
  check(
    "resolveStrategyFamily latest custom -> generic",
    resolveStrategyFamily({ versions: [{ version: 1, setupType: "custom" }] }) === "generic",
  );

  // --- switchClassification ----------------------------------------------------------------------------
  const swSame = switchClassification("clean_breakout", "hod_breakout");
  check("switchClassification same-family keep", swSame.value === "clean_breakout" && swSame.needsSelection === false);
  const swCross = switchClassification("clean_breakout", "vwap");
  check(
    "switchClassification cross-family incompatible cleared + needsSelection",
    swCross.value === null && swCross.needsSelection === true,
  );
  const swAnticipation = switchClassification("anticipation", "support");
  check(
    "switchClassification anticipation survives a family switch",
    swAnticipation.value === "anticipation" && swAnticipation.needsSelection === false,
  );
  const swNull = switchClassification(null, "vwap");
  check(
    "switchClassification null current -> no flag",
    swNull.value === null && swNull.needsSelection === false,
  );

  // --- findMaterializedStrategy ------------------------------------------------------------------------------
  const entries = [
    { id: "1", name: "HOD Breakout", family: "hod_breakout" as ClassificationFamily },
    { id: "2", name: "VWAP Pullback", family: "vwap" as ClassificationFamily },
    { id: "3", name: "HOD Breakout", family: "support" as ClassificationFamily },
  ];
  check(
    "findMaterializedStrategy exact",
    findMaterializedStrategy(entries, "hod_breakout", "HOD Breakout")?.id === "1",
  );
  check(
    "findMaterializedStrategy case-insensitive + trim",
    findMaterializedStrategy(entries, "vwap", "  vwap pullback  ")?.id === "2",
  );
  check(
    "findMaterializedStrategy wrong family -> undefined",
    findMaterializedStrategy(entries, "ema_pullback", "HOD Breakout") === undefined,
  );
  check(
    "findMaterializedStrategy family disambiguates same name",
    findMaterializedStrategy(entries, "support", "hod breakout")?.id === "3",
  );
  check(
    "findMaterializedStrategy unknown name -> undefined",
    findMaterializedStrategy(entries, "vwap", "Nope") === undefined,
  );

  // --- isUniqueViolation (unique-index race detection) ---------------------------------------------------------
  check(
    "isUniqueViolation: SQLSTATE code 23505",
    isUniqueViolation({ code: "23505", message: "anything" }) === true,
  );
  check(
    "isUniqueViolation: duplicate-key message without a code",
    isUniqueViolation({ message: 'duplicate key value violates unique constraint "strategies_annotation_unique"' }) === true,
  );
  check(
    "isUniqueViolation: index named in details only",
    isUniqueViolation({ message: "insert failed", details: "constraint strategies_annotation_unique" }) === true,
  );
  check(
    "isUniqueViolation: other SQLSTATE is not a violation",
    isUniqueViolation({ code: "42501", message: "permission denied" }) === false,
  );
  check(
    "isUniqueViolation: null / non-object errors are not violations",
    isUniqueViolation(null) === false && isUniqueViolation("23505") === false && isUniqueViolation(undefined) === false,
  );

  // --- probeStrategyAnnotationSupport --------------------------------------------------------------------------------
  type FakeResult = { error: unknown };
  function fakeClient(results: Record<string, FakeResult>, throwOnSelect = false) {
    return {
      from(table: string) {
        return {
          select(_cols: string) {
            if (throwOnSelect) throw new Error("boom");
            return {
              limit(_n: number): Promise<FakeResult> {
                return Promise.resolve(results[table] ?? { error: null });
              },
            };
          },
        };
      },
    };
  }

  check(
    "probe both ok -> true",
    (await probeStrategyAnnotationSupport(
      fakeClient({
        journal_trade_meta: { error: null },
        strategies: { error: null },
      }),
    )) === true,
  );
  check(
    "probe meta errors -> false",
    (await probeStrategyAnnotationSupport(
      fakeClient({
        journal_trade_meta: { error: { message: "column does not exist" } },
        strategies: { error: null },
      }),
    )) === false,
  );
  check(
    "probe strategies errors -> false",
    (await probeStrategyAnnotationSupport(
      fakeClient({
        journal_trade_meta: { error: null },
        strategies: { error: { message: "column does not exist" } },
      }),
    )) === false,
  );
  check(
    "probe select throws -> false",
    (await probeStrategyAnnotationSupport(fakeClient({}, true))) === false,
  );

  // Probe arguments: correct tables, columns, and limit.
  const seen: { table: string; cols: string; limit: number }[] = [];
  const recordingClient = {
    from(table: string) {
      return {
        select(cols: string) {
          return {
            limit(n: number): Promise<FakeResult> {
              seen.push({ table, cols, limit: n });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  await probeStrategyAnnotationSupport(recordingClient);
  check(
    "probe queries meta + strategies with exact columns and limit 1",
    seen.length === 2 &&
      seen[0].table === "journal_trade_meta" &&
      seen[0].cols === "strategy_id,setup_class,strategy_custom_label,entry_trigger" &&
      seen[0].limit === 1 &&
      seen[1].table === "strategies" &&
      seen[1].cols === "classification_family" &&
      seen[1].limit === 1,
    JSON.stringify(seen),
  );

  console.log(`=== strategyClassification RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
