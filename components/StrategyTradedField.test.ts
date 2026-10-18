/**
 * StrategyTradedField.test.ts — unit tests for resolveTradedStrategyId's
 * materialization paths, in particular the unique-violation recovery:
 * when a concurrent save wins the insert race, the database's partial
 * unique index (strategies_annotation_unique) rejects our insert with
 * SQLSTATE 23505 and the save must re-fetch and resolve to the winning
 * row — never fail spuriously, never retry the insert blindly.
 * Run: npx tsx components/StrategyTradedField.test.ts
 */
import {
  emptyTradedStrategyValue,
  resolveTradedStrategyId,
  type TradedStrategyValue,
} from "./StrategyTradedField";
import type { Strategy } from "../lib/strategies";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name} ${extra}`); }
}

type Client = Parameters<typeof resolveTradedStrategyId>[0];

interface MockBehavior {
  insertResult: { data: unknown; error: unknown };
  refetchRows?: unknown[];
}
function mockClient(behavior: MockBehavior) {
  const calls = { insert: 0, refetch: 0, insertedRows: [] as Record<string, unknown>[] };
  const client = {
    from(_table: string) {
      return {
        insert(row: Record<string, unknown>) {
          calls.insert++;
          calls.insertedRows.push(row);
          return {
            select: (_cols: string) => ({
              single: async () => behavior.insertResult,
            }),
          };
        },
        select(_cols: string) {
          return {
            limit: async (_n: number) => {
              calls.refetch++;
              return { data: behavior.refetchRows ?? [], error: null };
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as Client, calls };
}

const USER = "user-1";
const UNIQUE_ERR = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "strategies_annotation_unique"',
  details: "Key (user_id, classification_family, lower(name))=(user-1, hod_breakout, hod breakout) already exists.",
  hint: "",
};
const UNIQUE_ERR_TEXT_ONLY = {
  message: 'duplicate key value violates unique constraint "strategies_annotation_unique"',
};
const OTHER_ERR = { code: "42501", message: "permission denied for table strategies" };

function dbRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "row-1", user_id: USER, name: "HOD Breakout", notes: null,
    archived_at: null, created_at: null, updated_at: null,
    classification_family: "hod_breakout",
    ...over,
  };
}
function strat(over: Partial<Strategy>): Strategy {
  return {
    id: "s-1", userId: USER, name: "HOD Breakout", notes: null,
    archivedAt: null, createdAt: null, updatedAt: null,
    classificationFamily: "hod_breakout",
    ...over,
  };
}
const presetValue: TradedStrategyValue = {
  ...emptyTradedStrategyValue(), mode: "preset", presetSlug: "hod-breakout",
};

async function expectThrow(name: string, fn: () => Promise<unknown>, match: string) {
  try {
    await fn();
    check(name, false, "(no error thrown)");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, msg.includes(match), `(error was: ${msg})`);
  }
}

async function main() {
  // --- Short-circuits: no persistence at all -------------------------------
  {
    const { client, calls } = mockClient({ insertResult: { data: null, error: null } });
    const id = await resolveTradedStrategyId(client, USER, { ...presetValue, mode: "existing", strategyId: "s-9" }, [], []);
    check("existing mode returns its id without inserting", id === "s-9" && calls.insert === 0);
    const none = await resolveTradedStrategyId(client, USER, { ...presetValue, mode: "none" }, [], []);
    check("none mode returns null without inserting", none === null && calls.insert === 0);
  }

  // --- Snapshot guard hit: reuse, never insert ------------------------------
  {
    const { client, calls } = mockClient({ insertResult: { data: null, error: null } });
    const id = await resolveTradedStrategyId(client, USER, presetValue, [strat({ id: "s-7", name: "hod breakout" })], []);
    check("guard hit (case-insensitive name) returns the existing row", id === "s-7" && calls.insert === 0);
  }

  // --- Clean insert ----------------------------------------------------------
  {
    const { client, calls } = mockClient({ insertResult: { data: { id: "new-1" }, error: null } });
    const id = await resolveTradedStrategyId(client, USER, presetValue, [], []);
    check("clean insert returns the new id", id === "new-1");
    check("clean insert writes family + name once, no re-fetch",
      calls.insert === 1 && calls.refetch === 0 &&
      calls.insertedRows[0].classification_family === "hod_breakout" &&
      calls.insertedRows[0].name === "HOD Breakout");
  }

  // --- Unique-violation recovery (the race this change closes) ---------------
  {
    const { client, calls } = mockClient({
      insertResult: { data: null, error: UNIQUE_ERR },
      refetchRows: [dbRow({ id: "winner-1" })],
    });
    const id = await resolveTradedStrategyId(client, USER, presetValue, [], []);
    check("23505 on insert resolves to the winning row after re-fetch", id === "winner-1");
    check("recovery re-fetches exactly once and never re-inserts", calls.insert === 1 && calls.refetch === 1);
  }
  {
    // PostgREST flattened to a bare message (no SQLSTATE code) still recovers.
    const { client } = mockClient({
      insertResult: { data: null, error: UNIQUE_ERR_TEXT_ONLY },
      refetchRows: [dbRow({ id: "winner-2", name: "hod breakout" })],
    });
    const id = await resolveTradedStrategyId(client, USER, presetValue, [], []);
    check("text-only duplicate-key error also recovers (case-insensitive match)", id === "winner-2");
  }
  {
    // Custom strategy: winner stored under different name casing recovers too.
    const value: TradedStrategyValue = {
      ...emptyTradedStrategyValue(), mode: "new", customName: "Opening Range", customFamily: "support",
    };
    const { client } = mockClient({
      insertResult: { data: null, error: UNIQUE_ERR },
      refetchRows: [dbRow({ id: "winner-3", name: "opening range", classification_family: "support" })],
    });
    const id = await resolveTradedStrategyId(client, USER, value, [], []);
    check("custom strategy race recovers to the winner row", id === "winner-3");
  }

  // --- Failures that must still fail -----------------------------------------
  {
    const { client, calls } = mockClient({
      insertResult: { data: null, error: UNIQUE_ERR },
      refetchRows: [dbRow({ id: "other-1", name: "Something Else" })],
    });
    await expectThrow("23505 with no matching row on re-fetch still throws",
      () => resolveTradedStrategyId(client, USER, presetValue, [], []), "duplicate key");
    check("unmatched recovery attempted exactly one re-fetch", calls.refetch === 1 && calls.insert === 1);
  }
  {
    const { client, calls } = mockClient({ insertResult: { data: null, error: OTHER_ERR } });
    await expectThrow("non-unique insert error throws immediately",
      () => resolveTradedStrategyId(client, USER, presetValue, [], []), "permission denied");
    check("non-unique error never triggers a re-fetch", calls.refetch === 0 && calls.insert === 1);
  }

  console.log(`=== StrategyTradedField RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
