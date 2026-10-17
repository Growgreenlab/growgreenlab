/**
 * strategies.test.ts — pure shaping tests for lib/strategies.
 * Run: npx tsx lib/strategies.test.ts
 * (Database-level immutability / allocation atomicity are proven in
 * the SQL harness — ~/workspace/qa-harness/sql-strategies/run.mjs.)
 */
import {
  mapStrategyRow, mapStrategyVersionRow, mapAttemptRow, isStrategyArchived,
  strategyVersionLabel, nextVersionNumber, groupStrategies, attemptsForVersion,
  resolveVersionContext, setupTypeLabel, isStrategySetupType,
  type Strategy, type StrategyVersion,
} from "./strategies";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name} ${extra}`); }
}

const sA = mapStrategyRow({ id: "s1", user_id: "u1", name: "HOD Breakout", notes: null, archived_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
const sB = mapStrategyRow({ id: "s2", user_id: "u1", name: "Pullback", notes: "n", archived_at: "2026-10-10T00:00:00Z", created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-10T00:00:00Z" });
check("strategy row maps", sA.id === "s1" && sA.name === "HOD Breakout" && sA.archivedAt === null);
check("archived predicate", !isStrategyArchived(sA) && isStrategyArchived(sB));

const v1 = mapStrategyVersionRow({ id: "v1", strategy_id: "s1", user_id: "u1", version: "1", setup_type: "hod_breakout", entry_rules: "e", stop_rules: null, target_rules: null, exit_rules: null, market_filters: { minRv: 2 }, notes: null, created_at: "2026-10-01T00:00:00Z" });
const v2 = mapStrategyVersionRow({ id: "v2", strategy_id: "s1", user_id: "u1", version: 2, setup_type: "bogus", entry_rules: null, stop_rules: null, target_rules: null, exit_rules: null, market_filters: [1, 2], notes: null, created_at: "2026-10-03T00:00:00Z" });
check("version number coerced from numeric string", v1.version === 1);
check("unknown setup_type falls back to custom, never crashes", v2.setupType === "custom");
check("array market_filters normalized to {}", JSON.stringify(v2.marketFilters) === "{}");
check("object market_filters preserved", (v1.marketFilters as { minRv: number }).minRv === 2);
check("setup enum guard", isStrategySetupType("ema_pullback") && !isStrategySetupType("whatever"));
check("setup label", setupTypeLabel("vwap_pullback") === "VWAP pullback" && setupTypeLabel(null) === "Not recorded");

check("label format", strategyVersionLabel("HOD Breakout", 2) === "HOD Breakout · v2");
check("label without strategy", strategyVersionLabel(null, 2) === "No strategy recorded");
check("next version from empty", nextVersionNumber([]) === 1);
check("next version from existing", nextVersionNumber([v1, v2]) === 3);

const strategies: Strategy[] = [sB, sA];
const versions: StrategyVersion[] = [v2, v1];
const grouped = groupStrategies(strategies, versions);
check("grouped sorted by name", grouped[0].strategy.id === "s1" && grouped[1].strategy.id === "s2");
check("versions sorted ascending", grouped[0].versions.map((v) => v.version).join(",") === "1,2");
check("strategy without versions groups empty", grouped[1].versions.length === 0);

const attempts = [
  mapAttemptRow({ id: "a1", session_id: "sess1", strategy_version_id: "v1", status: "finished", start_index: 90, created_at: "2026-10-05T00:00:00Z", finished_at: "2026-10-05T01:00:00Z" }),
  mapAttemptRow({ id: "a2", session_id: null, strategy_version_id: "v1", status: "active", start_index: 10, created_at: "2026-10-06T00:00:00Z", finished_at: null }),
  mapAttemptRow({ id: "a3", session_id: "sess3", strategy_version_id: null, status: "finished", start_index: 0, created_at: "2026-10-07T00:00:00Z", finished_at: null }),
];
check("attempt row maps", attempts[0].sessionId === "sess1" && attempts[0].startIndex === 90);
check("attemptsForVersion filters + newest first",
  attemptsForVersion(attempts, "v1").map((a) => a.id).join(",") === "a2,a1");

const ctx = resolveVersionContext("v1", strategies, versions);
check("resolve context", ctx?.label === "HOD Breakout · v1" && ctx?.version.id === "v1");
check("resolve null version id", resolveVersionContext(null, strategies, versions) === null);
check("resolve unknown version id", resolveVersionContext("nope", strategies, versions) === null);
const ctxArchived = resolveVersionContext("v1", [sB, { ...sA, archivedAt: "2026-10-11T00:00:00Z" }], versions);
check("archived strategy still resolves (historical references preserved)", ctxArchived?.strategy.id === "s1");

console.log(`=== strategies RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
