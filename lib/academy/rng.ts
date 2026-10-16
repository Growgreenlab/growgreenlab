/**
 * Trading Academy — deterministic seeded RNG.
 *
 * Same mulberry32 algorithm as the three existing private copies
 * (lib/marketData.ts, lib/drills/candleGen.ts, lib/drills/orderflow.ts).
 * Those copies are pinned by the drills regression suites and are NOT
 * touched; the Academy gets its own exported copy so lesson demos and
 * challenges are reproducible from a seed (spec §13: deterministic
 * seeds for tests and reproducible scenarios).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic pick from a non-empty list. */
export function seededPick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error("seededPick: empty list");
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}
