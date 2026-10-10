import type { Candle } from "./types";
import { parseEtDateTime } from "./marketData";

/* ------------------------------------------------------------------ */
/* Twelve Data (client-side; user pastes their OWN key)                 */
/* ------------------------------------------------------------------ */

/** Accept a raw key or a full request URL copied from Twelve Data. */
export function extractApiKey(input: string): string {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return u.searchParams.get("apikey")?.trim() ?? "";
    } catch {
      return "";
    }
  }
  return s;
}

export function buildTwelveDataUrl(
  ticker: string,
  dateStr: string,
  apiKey: string
): string {
  const p = new URLSearchParams({
    symbol: ticker.toUpperCase().trim(),
    interval: "1min",
    start_date: `${dateStr} 09:30:00`,
    end_date: `${dateStr} 16:00:00`,
    timezone: "America/New_York",
    apikey: apiKey,
  });
  return `https://api.twelvedata.com/time_series?${p.toString()}`;
}

interface TwelveValues {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

function friendlyTwelveError(code: number | undefined, message?: string): string {
  if (code === 401)
    return "That API key was not accepted (401). Check the key in your Twelve Data dashboard - new keys need email verification first - and try again.";
  if (code === 429)
    return "Rate limit hit (429). The free key allows limited calls per minute - wait a minute and try again.";
  if (message) {
    const m = message.toLowerCase();
    if (m.includes("not found") || m.includes("invalid symbol"))
      return `Unknown ticker: ${message}`;
    return message;
  }
  return "Twelve Data returned an error. Please try again.";
}

/** Parse a Twelve Data time_series JSON body into chronological candles. */
export function parseTwelveDataResponse(json: unknown): Candle[] {
  const body = json as {
    status?: string;
    code?: number;
    message?: string;
    values?: TwelveValues[];
  };
  if (!body || typeof body !== "object")
    throw new Error("Unexpected response from Twelve Data.");
  if (body.status === "error" || body.code) {
    throw new Error(friendlyTwelveError(body.code, body.message));
  }
  const values = body.values;
  if (!values || values.length === 0)
    throw new Error(
      "No candles returned for this date - weekends and market holidays have no trading data."
    );
  // API returns newest-first; reverse to chronological.
  const candles = values
    .map((v) => ({
      t: parseEtDateTime(v.datetime),
      o: parseFloat(v.open),
      h: parseFloat(v.high),
      l: parseFloat(v.low),
      c: parseFloat(v.close),
      v: parseInt(v.volume ?? "0", 10) || 0,
    }))
    .filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite))
    .reverse();
  if (candles.length === 0)
    throw new Error("Twelve Data returned candles we could not parse.");
  return candles;
}

export async function fetchTwelveData(
  ticker: string,
  dateStr: string,
  apiKeyOrUrl: string
): Promise<Candle[]> {
  const apiKey = extractApiKey(apiKeyOrUrl);
  if (!apiKey) throw new Error("Paste your Twelve Data API key first.");
  if (!ticker.trim()) throw new Error("Enter a ticker symbol.");
  const url = buildTwelveDataUrl(ticker, dateStr, apiKey);
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(
      "Could not reach Twelve Data. Check your internet connection and try again."
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("Twelve Data returned a response we could not read.");
  }
  return parseTwelveDataResponse(json);
}
