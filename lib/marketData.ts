import type { Candle } from "./types";

/* ------------------------------------------------------------------ */
/* Time helpers (US Eastern, where US equities trade)                   */
/* ------------------------------------------------------------------ */

/** True if a date falls in US daylight time (second Sun Mar - first Sun Nov). */
function isEasternDst(y: number, m: number, d: number): boolean {
  const secondSundayMarch = (() => {
    let count = 0;
    for (let day = 1; day <= 14; day++) {
      if (new Date(Date.UTC(y, 2, day)).getUTCDay() === 0 && ++count === 2)
        return day;
    }
    return 8;
  })();
  const firstSundayNovember = (() => {
    for (let day = 1; day <= 7; day++)
      if (new Date(Date.UTC(y, 10, day)).getUTCDay() === 0) return day;
    return 1;
  })();
  if (m < 3 || m > 11) return false;
  if (m > 3 && m < 11) return true;
  if (m === 3) return d >= secondSundayMarch;
  return d < firstSundayNovember;
}

/** Offset of US Eastern behind UTC in minutes for a given date. */
export function easternOffsetMinutes(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return isEasternDst(y, m, d) ? 240 : 300;
}

/** "YYYY-MM-DD" + "HH:MM" in US Eastern -> epoch ms. */
export function etToUtcMs(dateStr: string, hhmm: string): number {
  const [hh, mm] = hhmm.split(":").map(Number);
  const offsetMs = easternOffsetMinutes(dateStr) * 60_000;
  return (
    Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10), hh, mm) +
    offsetMs
  );
}

/** Twelve Data returns "YYYY-MM-DD HH:MM:SS" in the requested timezone. */
export function parseEtDateTime(s: string): number {
  const [d, t] = s.trim().split(/[T ]/);
  return etToUtcMs(d, t.slice(0, 5));
}

/** Format epoch ms as "HH:MM" in US Eastern. */
export function formatEtTime(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/New_York",
  }).format(new Date(ms));
}

/* ------------------------------------------------------------------ */
/* Sample data generator (CLEARLY LABELLED - not real market prices)     */
/* ------------------------------------------------------------------ */

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

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

function minutesToHhmm(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Deterministic intraday tape shaped for HOD-breakout practice:
 * morning push -> pullback -> HOD run -> fade -> chop.
 * ALWAYS labelled sample data by callers. 390 one-minute candles.
 */
export function generateSampleSession(ticker: string, dateStr: string): Candle[] {
  const rand = mulberry32(hashSeed(`${ticker.toUpperCase()}|${dateStr}`));
  const candles: Candle[] = [];
  const base = 2 + rand() * 3; // $2-$5 penny-stock zone
  let price = base;

  const pushCandle = (o: number, c: number, h: number, l: number, v: number, t: number) => {
    candles.push({ t, o, h, l, c, v });
  };

  // Premarket 04:00-09:29: thin, drifty tape — context the replay starts into.
  for (let i = 0; i < 330; i++) {
    const o = price;
    const drift = (rand() - 0.52) * 0.0015; // slight fade bias overnight
    const shock = (rand() - 0.5) * 0.006;
    const c = Math.max(0.2, o * (1 + drift + shock));
    const h = Math.max(o, c) * (1 + rand() * 0.002);
    const l = Math.min(o, c) * (1 - rand() * 0.002);
    const move = Math.abs(c - o) / o;
    const v = Math.round(2_000 + rand() * 8_000 + move * 1_000_000);
    pushCandle(o, c, h, l, v, etToUtcMs(dateStr, minutesToHhmm(4 * 60 + i)));
    price = c;
  }

  // Overnight gap into the regular-session open, like a real print.
  price = Math.max(0.2, price * (1 + (rand() - 0.45) * 0.02));

  const regimes: Array<[number, number, number]> = [
    [0, 29, 0.0012],
    [30, 89, -0.0009],
    [90, 199, 0.0011],
    [200, 289, -0.001],
    [290, 389, 0.0001],
  ];
  const driftAt = (i: number) =>
    regimes.find(([a, b]) => i >= a && i <= b)?.[2] ?? 0;

  for (let i = 0; i < 390; i++) {
    const o = price;
    const drift = driftAt(i);
    const shock = (rand() - 0.5) * 0.012;
    const c = Math.max(0.2, o * (1 + drift + shock));
    const h = Math.max(o, c) * (1 + rand() * 0.003);
    const l = Math.min(o, c) * (1 - rand() * 0.003);
    const move = Math.abs(c - o) / o;
    const v = Math.round(20_000 + rand() * 60_000 + move * 4_000_000);
    const t = etToUtcMs(dateStr, minutesToHhmm(9 * 60 + 30 + i));
    candles.push({ t, o, h, l, c, v });
    price = c;
  }
  return candles;
}

/** Replay start-time choices (ET) for the session setup. */
export function startTimeOptions(): string[] {
  const out: string[] = [];
  for (let m = 9 * 60 + 30; m <= 15 * 60; m += 10) out.push(minutesToHhmm(m));
  return out;
}
