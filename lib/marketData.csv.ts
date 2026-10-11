import type { Candle } from "./types";

/* ------------------------------------------------------------------ */
/* CSV upload / download                                                */
/* ------------------------------------------------------------------ */

const HEADER_ALIASES: Record<string, string[]> = {
  datetime: ["datetime", "time", "timestamp", "date"],
  open: ["open", "o"],
  high: ["high", "h"],
  low: ["low", "l"],
  close: ["close", "c", "last", "price"],
  volume: ["volume", "vol", "v"],
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const stripQuotes = (s: string) => s.trim().replace(/^"|"$/g, "");

/** Parse CSV text with datetime,open,high,low,close,volume (tolerant headers). */
export function parseCsv(text: string): Candle[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2)
    throw new Error("CSV is empty - it needs a header row plus candles.");
  const headers = splitCsvLine(lines[0]).map((h) => stripQuotes(h).toLowerCase());
  const col: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = headers.findIndex((h) => aliases.includes(h));
    if (idx === -1)
      throw new Error(
        `CSV is missing a "${key}" column (looked for: ${aliases.join(", ")}).`
      );
    col[key] = idx;
  }
  const candles: Candle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const t = Date.parse(stripQuotes(cells[col.datetime] ?? "").replace(" ", "T"));
    const o = parseFloat(cells[col.open]);
    const h = parseFloat(cells[col.high]);
    const l = parseFloat(cells[col.low]);
    const c = parseFloat(cells[col.close]);
    const v = parseInt(cells[col.volume] ?? "0", 10) || 0;
    if (!Number.isFinite(t) || ![o, h, l, c].every(Number.isFinite)) continue;
    candles.push({ t, o, h, l, c, v });
  }
  if (candles.length === 0)
    throw new Error("No readable candle rows found in the CSV.");
  candles.sort((a, b) => a.t - b.t);
  return candles;
}

/** Export candles to CSV (chronological), re-importable by parseCsv. */
export function candlesToCsv(candles: Candle[]): string {
  const rows = ["datetime,open,high,low,close,volume"];
  for (const c of candles) {
    const d = new Date(c.t);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    const iso = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
      d.getUTCHours()
    )}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    rows.push(`${iso}Z,${c.o},${c.h},${c.l},${c.c},${c.v}`);
  }
  return rows.join("\n");
}
