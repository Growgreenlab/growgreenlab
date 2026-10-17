/**
 * Breakout Drill — public catalog, neutral slugs, and blind selection.
 *
 * Blind-mode integrity (see docs/drill-blind-audit-2026-10-14.md): the
 * picker and the runner must never present the scenario classification
 * before the post-drill review. This module is the ONLY drill surface
 * the selection screens consume:
 *
 *  - BLIND_CATALOG exposes exactly { slug, label, number, candleCount }
 *    per drill — no title, description, difficulty, or classification.
 *  - Drill numbers are assigned non-sequentially and do NOT correlate
 *    with category or difficulty order (sorting by number does not sort
 *    by difficulty), so the number itself carries no information.
 *  - Routes are opaque slugs ("d-047") mapped to scenario ids here, so
 *    the URL cannot spoil the answer the way /drills/hod-clean-001 did.
 *  - FOCUSED_CATALOG is the separate Focused Learning surface; naming
 *    categories there is its purpose (the user chooses deliberately).
 *
 * Scenario definitions themselves (lib/drills/scenarios.ts) remain the
 * single internal source of truth for classification, scoring, and the
 * post-drill review.
 */
import { HOD_SCENARIOS, getScenario } from "./scenarios";
import type { BreakoutClassification, DrillScenario } from "./types";

/** Same mulberry32 algorithm as candleGen.ts / engine.ts. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Neutral drill numbers, keyed by internal scenario id. Deliberately
 * non-sequential and uncorrelated with difficulty order: read by
 * ascending number, the difficulties run intermediate, beginner,
 * advanced, advanced, advanced, beginner, intermediate, intermediate,
 * intermediate, beginner, intermediate, advanced — no monotonic
 * pattern to decode (asserted by verify-blind).
 */
const DRILL_NUMBER: Record<string, number> = {
  "hod-clean-002": 12,
  "hod-weak-001": 23,
  "hod-failed-003": 29,
  "hod-ambiguous-001": 31,
  "hod-weak-003": 38,
  "hod-clean-001": 47,
  "hod-ambiguous-002": 53,
  "hod-failed-001": 58,
  "hod-weak-002": 64,
  "hod-clean-003": 71,
  "hod-failed-002": 85,
  "hod-ambiguous-003": 96,
};

/**
 * Catalog version recorded by drill cycles (lib/drills/cycle.ts). A
 * cycle's eligibility set is frozen at creation under the catalog
 * version then current; scenarios added later join at the next cycle
 * boundary, never mid-cycle. Bump when scenarios are added/removed.
 */
export const CATALOG_VERSION = 2;

const pad3 = (n: number) => String(n).padStart(3, "0");

/** The complete public shape of a blind drill. Nothing else may leak. */
export interface PublicDrill {
  /** Opaque route slug, e.g. "d-047". */
  slug: string;
  /** Neutral display label, e.g. "HOD Drill #047". */
  label: string;
  number: number;
  candleCount: number;
}

function blindSlugFor(scenarioId: string): string {
  return `d-${pad3(DRILL_NUMBER[scenarioId])}`;
}

export const BLIND_CATALOG: PublicDrill[] = HOD_SCENARIOS.map((s) => ({
  slug: blindSlugFor(s.id),
  label: `HOD Drill #${pad3(DRILL_NUMBER[s.id])}`,
  number: DRILL_NUMBER[s.id],
  candleCount: s.candles.length,
})).sort((a, b) => a.number - b.number);

/** Focused Learning entries — categories named on purpose here. */
export interface FocusedEntry {
  slug: string;
  category: BreakoutClassification;
  label: string;
  blurb: string;
}

export const FOCUSED_CATALOG: FocusedEntry[] = [
  {
    slug: "f-clean",
    category: "clean",
    label: "Clean Breakout",
    blurb: "Textbook breaks: coil under the level, volume expansion, strong close, follow-through.",
  },
  {
    slug: "f-weak",
    category: "weak",
    label: "Weak Breakout",
    blurb: "Breaks that lack conviction: flat volume, small bodies, no follow-through.",
  },
  {
    slug: "f-failed",
    category: "failed",
    label: "Failed Breakout / Trap",
    blurb: "Violent rejections at the level: climax volume, long upper wicks, trapped buyers.",
  },
  {
    slug: "f-ambiguous",
    category: "ambiguous",
    label: "Ambiguous / No-Trade",
    blurb: "Genuinely mixed evidence at the level. The correct read is often 'no edge — wait.'",
  },
];

/** Focused Learning route slug for one specific scenario: "f-047". */
export function focusedSlugForScenario(scenarioId: string): string {
  return `f-${pad3(DRILL_NUMBER[scenarioId])}`;
}

/**
 * The scenarios of one category as public drills (neutral number +
 * label only), for the Focused Learning picker. Focused mode names the
 * category on purpose; the individual drills still carry no title,
 * description, or difficulty.
 */
export function scenariosForCategory(category: BreakoutClassification): PublicDrill[] {
  return HOD_SCENARIOS.filter((s) => s.classification === category)
    .map((s) => ({
      slug: blindSlugFor(s.id),
      label: `HOD Drill #${pad3(DRILL_NUMBER[s.id])}`,
      number: DRILL_NUMBER[s.id],
      candleCount: s.candles.length,
    }))
    .sort((a, b) => a.number - b.number);
}

export type DrillMode = "blind" | "focused";

export interface ResolvedDrill {
  scenario: DrillScenario;
  mode: DrillMode;
  /** Neutral label, safe to display at any phase. */
  label: string;
  number: number;
}

/**
 * Resolve a route slug to its internal scenario. Blind slugs encode
 * only the neutral number; focused slugs encode the category the user
 * deliberately picked on the Focused Learning screen.
 */
export function resolveDrillSlug(slug: string): ResolvedDrill | undefined {
  if (slug.startsWith("d-")) {
    const num = Number(slug.slice(2));
    const entry = Object.entries(DRILL_NUMBER).find(([, n]) => n === num);
    if (!entry) return undefined;
    const scenario = getScenario(entry[0]);
    if (!scenario) return undefined;
    return {
      scenario,
      mode: "blind",
      label: `HOD Drill #${pad3(num)}`,
      number: num,
    };
  }
  if (slug.startsWith("f-")) {
    const rest = slug.slice(2);
    // "f-047": one specific scenario, deliberately chosen in Focused
    // Learning (the picker lists each category's drills by number).
    if (/^\d+$/.test(rest)) {
      const num = Number(rest);
      const entry = Object.entries(DRILL_NUMBER).find(([, n]) => n === num);
      if (!entry) return undefined;
      const scenario = getScenario(entry[0]);
      if (!scenario) return undefined;
      return {
        scenario,
        mode: "focused",
        label: `HOD Drill #${pad3(num)}`,
        number: num,
      };
    }
    // "f-clean": the category slug — resolves to the category's first
    // scenario (kept working for existing links/bookmarks).
    const category = rest as BreakoutClassification;
    const focused = FOCUSED_CATALOG.find((f) => f.category === category);
    if (!focused) return undefined;
    const scenario = HOD_SCENARIOS.find((s) => s.classification === category);
    if (!scenario) return undefined;
    return {
      scenario,
      mode: "focused",
      label: `HOD Drill #${pad3(DRILL_NUMBER[scenario.id])}`,
      number: DRILL_NUMBER[scenario.id],
    };
  }
  return undefined;
}

/**
 * Seeded blind pick: deterministic — the same seed always draws the
 * same drill, uniformly across the scenario library. The seed is
 * recorded by the caller and shown only at the post-drill review, so
 * any specific blind run can be reproduced for debugging/review.
 */
export function pickBlindScenario(seed: number): ResolvedDrill {
  const rng = mulberry32(seed);
  const idx = Math.floor(rng() * HOD_SCENARIOS.length);
  const scenario = HOD_SCENARIOS[idx];
  return {
    scenario,
    mode: "blind",
    label: `HOD Drill #${pad3(DRILL_NUMBER[scenario.id])}`,
    number: DRILL_NUMBER[scenario.id],
  };
}

export function blindSlugForSeed(seed: number): string {
  return blindSlugFor(pickBlindScenario(seed).scenario.id);
}

/** A fresh run seed for a new random blind draw (client-side use). */
export function randomRunSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * Draw the NEXT blind drill from the review screen. The draw MUST NOT
 * return the drill the user is already on: navigating to the identical
 * /drills/[id] URL is a no-op in the router (no param change, no
 * remount, no state reset), which left the "Next Blind Drill" button
 * looking dead whenever the fresh draw repeated the current slug
 * (a 1-in-4 chance per click). Draws repeat seeds until the slug
 * differs; the bounded fallback walks the catalog so even a degenerate
 * seed source can never strand the user on the same drill.
 */
export function drawNextBlindSlug(
  currentSlug: string,
  nextSeed: () => number
): { slug: string; seed: number } {
  for (let attempt = 0; attempt < 16; attempt++) {
    const seed = nextSeed();
    const slug = blindSlugForSeed(seed);
    if (slug !== currentSlug) return { slug, seed };
  }
  const idx = BLIND_CATALOG.findIndex((d) => d.slug === currentSlug);
  const fallback =
    BLIND_CATALOG[(idx + 1) % BLIND_CATALOG.length] ?? BLIND_CATALOG[0];
  return { slug: fallback.slug, seed: nextSeed() };
}
