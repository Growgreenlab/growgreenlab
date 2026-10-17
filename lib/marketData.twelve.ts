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
    start_date: `${dateStr} 04:00:00`,
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

/**
 * Why a Twelve Data request did not produce candles. Daily Replay's
 * pre-replay verification maps every failure to one of these kinds so
 * the UI can show a distinct, accurate error — and never proceed.
 */
export type TwelveDataErrorKind =
  | "invalid_key"
  | "rate_limit"
  | "plan_restricted"
  | "symbol_not_found"
  | "no_data"
  | "network"
  | "unknown";

export class TwelveDataError extends Error {
  readonly kind: TwelveDataErrorKind;
  readonly code?: number;
  constructor(kind: TwelveDataErrorKind, message: string, code?: number) {
    super(message);
    this.name = "TwelveDataError";
    this.kind = kind;
    this.code = code;
  }
}

/**
 * Classify a Twelve Data error payload ({code, message}) into an error
 * kind. Code wins first (401 = bad key, 429 = rate limit, 403 = the
 * plan does not entitle this resource), then message patterns.
 */
export function classifyTwelveError(
  code: number | undefined,
  message?: string
): TwelveDataErrorKind {
  if (code === 401) return "invalid_key";
  if (code === 429) return "rate_limit";
  const m = (message ?? "").toLowerCase();
  if (
    m.includes("run out of api credits") ||
    m.includes("rate limit") ||
    m.includes("too many requests")
  ) {
    return "rate_limit";
  }
  if (m.includes("not found") || m.includes("invalid symbol")) {
    return "symbol_not_found";
  }
  if (code === 403) return "plan_restricted";
  if (
    m.includes("plan") ||
    m.includes("not authorized") ||
    m.includes("upgrade")
  ) {
    return "plan_restricted";
  }
  return "unknown";
}

function friendlyTwelveError(
  code: number | undefined,
  message?: string
): { kind: TwelveDataErrorKind; text: string } {
  const kind = classifyTwelveError(code, message);
  switch (kind) {
    case "invalid_key":
      return {
        kind,
        text: "That API key was not accepted (401). Check the key in your Twelve Data dashboard - new keys need email verification first - and try again.",
      };
    case "rate_limit":
      return {
        kind,
        text: "Rate limit hit (429). The free key allows limited calls per minute - wait a minute and try again.",
      };
    case "plan_restricted":
      return {
        kind,
        text:
          "Your Twelve Data plan does not cover this request: 1-minute historical data, or the requested historical date range, is outside your plan. " +
          (message ? `Provider said: ${message}` : "Check your plan's interval and history limits, or pick a more recent date."),
      };
    case "symbol_not_found":
      return {
        kind,
        text: message ? `Unknown ticker: ${message}` : "That symbol was not found at Twelve Data.",
      };
    default:
      return {
        kind,
        text: message ?? "Twelve Data returned an error. Please try again.",
      };
  }
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
    throw new TwelveDataError("unknown", "Unexpected response from Twelve Data.");
  if (body.status === "error" || body.code) {
    const f = friendlyTwelveError(body.code, body.message);
    throw new TwelveDataError(f.kind, f.text, body.code);
  }
  const values = body.values;
  if (!values || values.length === 0)
    throw new TwelveDataError(
      "no_data",
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
    throw new TwelveDataError("no_data", "Twelve Data returned candles we could not parse.");
  return candles;
}

export async function fetchTwelveData(
  ticker: string,
  dateStr: string,
  apiKeyOrUrl: string
): Promise<Candle[]> {
  const apiKey = extractApiKey(apiKeyOrUrl);
  if (!apiKey)
    throw new TwelveDataError("invalid_key", "Paste your Twelve Data API key first.");
  if (!ticker.trim()) throw new Error("Enter a ticker symbol.");
  const url = buildTwelveDataUrl(ticker, dateStr, apiKey);
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new TwelveDataError(
      "network",
      "Could not reach Twelve Data. Check your internet connection and try again."
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new TwelveDataError(
      "unknown",
      "Twelve Data returned a response we could not read."
    );
  }
  return parseTwelveDataResponse(json);
}
