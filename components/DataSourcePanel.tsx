"use client";

import { useRef, useState } from "react";
import type { Candle, DataSource, SessionMeta } from "../lib/types";
import { generateSampleSession, stripSynthetic } from "../lib/marketData";
import { fetchTwelveData } from "../lib/marketData.twelve";
import { parseCsv, candlesToCsv } from "../lib/marketData.csv";
import { validateDataset, marketSessionStatus } from "../lib/dailyReplay";

interface Props {
  candles: Candle[] | null;
  meta: SessionMeta | null;
  defaultTicker?: string;
  defaultDate?: string;
  onLoad: (candles: Candle[], meta: SessionMeta) => void;
  /**
   * Daily Replay: when provided, a successful Real Market Data load is
   * validated and handed to the full-day PREVIEW (with validation
   * warnings) instead of starting a replay immediately. Sample and CSV
   * loads are unaffected and always use onLoad.
   */
  onPreview?: (candles: Candle[], meta: SessionMeta, warnings: string[]) => void;
}

/** Quick-select symbols for the Daily Replay workflow (manual entry stays). */
const QUICK_TICKERS = ["AAPL", "TSLA", "NVDA"];

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function DataSourcePanel({ candles, meta, defaultTicker, defaultDate, onLoad, onPreview }: Props) {
  const [tab, setTab] = useState<DataSource>("sample");
  const [ticker, setTicker] = useState(defaultTicker ?? "VEEA");
  const [date, setDate] = useState(defaultDate ?? todayStr());
  const [startTime, setStartTime] = useState("09:30");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const timeToIndex = (cs: Candle[], hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < cs.length; i++) {
      const d = new Date(cs[i].t);
      // compare in ET via formatter-free math: use UTC of ET-converted time
      const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const dist = Math.abs(et.getHours() * 60 + et.getMinutes() - (h * 60 + m));
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  };

  const loadSample = () => {
    setError(null);
    try {
      const cs = generateSampleSession(ticker || "SAMPLE", date);
      onLoad(cs, { ticker: (ticker || "SAMPLE").toUpperCase(), tradeDate: date, source: "sample", startIndex: timeToIndex(cs, startTime) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate sample data.");
    }
  };

  const loadTwelve = async () => {
    setError(null);
    // Daily Replay Step A: refuse non-trading dates up front, with the
    // reason — never call the API and never substitute another date.
    const session = marketSessionStatus(date);
    if (!session.isTradingDay) {
      setError(
        `${date} is a ${session.reason} — the US market is closed, so there is no session to load. ` +
        "No substitute date was used; please pick a trading day."
      );
      return;
    }
    setLoading(true);
    try {
      const real = await fetchTwelveData(ticker, date, apiKey);
      // No synthetic premarket: use verified historical candles only.
      // If the first candle is at/after 9:29 AM ET, premarket data is
      // unavailable — the UI will show an honest notice.
      const cs = real;
      const firstEt = new Date(real[0].t).toLocaleString("en-US", { timeZone: "America/New_York" });
      const firstMins = (() => { const d = new Date(firstEt); return d.getHours() * 60 + d.getMinutes(); })();
      const hasPremarket = firstMins < 9 * 60 + 29;
      const si = Math.max(timeToIndex(cs, startTime), 0);
      const m: SessionMeta = {
        ticker: ticker.toUpperCase().trim(),
        tradeDate: date,
        source: "twelvedata",
        startIndex: si,
        premarketUnavailable: !hasPremarket,
      };
      // Validate the returned dataset before anything proceeds.
      const v = validateDataset(cs, {
        ticker: m.ticker,
        tradeDate: date,
        timeframeMinutes: 1,
      });
      if (!v.ok) {
        setError(`This dataset failed validation and was not loaded: ${v.errors.join(" ")}`);
        return;
      }
      if (onPreview) {
        // Daily Replay Step B: full-day preview (intentionally unsealed).
        onPreview(cs, m, v.warnings);
      } else {
        onLoad(cs, m);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Twelve Data request failed.");
    } finally {
      setLoading(false);
    }
  };

  const loadCsvFile = async (f: File) => {
    setError(null);
    try {
      const text = await f.text();
      const cs = parseCsv(text);
      const name = f.name.replace(/\.csv$/i, "").toUpperCase().slice(0, 12) || "CSV";
      onLoad(cs, { ticker: name, tradeDate: date, source: "csv", startIndex: timeToIndex(cs, startTime) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not parse that CSV file.");
    }
  };

  const downloadCsv = () => {
    if (!candles || !meta) return;
    const blob = new Blob([candlesToCsv(stripSynthetic(candles))], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${meta.ticker}-${meta.tradeDate}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="card">
      <h3>Data source</h3>
      <div className="tabs">
        <button className={`tab ${tab === "sample" ? "active" : ""}`} onClick={() => setTab("sample")}>Sample data</button>
        <button className={`tab ${tab === "twelvedata" ? "active" : ""}`} onClick={() => setTab("twelvedata")}>Real Market Data</button>
        <button className={`tab ${tab === "csv" ? "active" : ""}`} onClick={() => setTab("csv")}>CSV upload</button>
        <button className="tab" onClick={downloadCsv} disabled={!candles} title={candles ? "Download the loaded session as CSV" : "Load a session first"}>Download CSV</button>
      </div>

      <div className="row">
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Ticker symbol</label>
          <input className="input mono" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="VEEA" maxLength={12} />
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            {QUICK_TICKERS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setTicker(q)}
                title={`Quick-select ${q} (Daily Replay)`}
                style={{
                  padding: "2px 8px", fontSize: 11, fontWeight: 700, borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.14)", cursor: "pointer",
                  background: ticker === q ? "var(--emerald, #10b981)" : "rgba(255,255,255,0.04)",
                  color: ticker === q ? "#0a0e14" : "var(--muted)",
                }}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Trading date</label>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Replay starts at</label>
          <input
            className="input num" type="time" step={60}
            value={startTime} onChange={(e) => setStartTime(e.target.value)}
            min={tab === "sample" ? "04:00" : tab === "twelvedata" ? "09:30" : undefined}
            max={tab === "csv" ? undefined : "15:55"}
            title="Pick any start time — the replay opens with that candle forming live"
          />
        </div>
      </div>

      {tab === "sample" && (
        <div style={{ marginTop: 12 }}>
          <span className="badge sample">SAMPLE DATA — not real market prices</span>
          <p className="hint">Generated intraday tape shaped for HOD-breakout practice. Never presented as real quotes.</p>
          <button className="btn primary big" onClick={loadSample}>Load sample session</button>
        </div>
      )}

      {tab === "twelvedata" && (
        <div style={{ marginTop: 12 }}>
          {/* Beginner-friendly help section */}
          <div
            style={{
              background: "rgba(16,185,129,0.06)",
              border: "1px solid rgba(16,185,129,0.2)",
              borderRadius: 10,
              padding: "12px 14px",
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4, color: "var(--text)" }}>
              Load Historical Stock Data
            </div>
            <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 10px 0", lineHeight: 1.5 }}>
              Use historical market data to practice trading with real price
              movements instead of sample data.
            </p>
            <a
              href="https://twelvedata.com/register"
              target="_blank"
              rel="noopener noreferrer"
              className="btn primary"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", marginBottom: 10 }}
            >
              Get Your Free API Key ↗
            </a>
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--text)" }}>
                How to get your API key
              </div>
              <ol style={{ margin: "0 0 8px 0", paddingLeft: 20, color: "var(--muted)", lineHeight: 1.7 }}>
                <li>Create an account with Twelve Data.</li>
                <li>Open your API dashboard.</li>
                <li>Copy your API key.</li>
                <li>Paste the key into the field below.</li>
              </ol>
              <p style={{ fontSize: 12, color: "var(--muted)", margin: 0, fontStyle: "italic" }}>
                🔒 Your API key is used to request market data. Never share it publicly.
              </p>
            </div>
          </div>
          <div className="field">
            <label>API key (yours — stays in your browser)</label>
            <input className="input mono" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste your Twelve Data API key" autoComplete="off" />
          </div>
          <p className="hint">
            Your key is sent only to Twelve Data when you load a session and is kept only
            in this page until you close it — never baked into the site or saved.
            A free key allows about 800 calls per day.
          </p>
          <button className="btn primary big" onClick={loadTwelve} disabled={loading}>
            {loading ? "Loading…" : "Load Real Data"}
          </button>
        </div>
      )}

      {tab === "csv" && (
        <div style={{ marginTop: 12 }}>
          <p className="hint">Upload a CSV with <span className="num">datetime,open,high,low,close,volume</span> columns (header names are flexible).</p>
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) loadCsvFile(f); e.target.value = ""; }} />
          <button className="btn primary big" onClick={() => fileRef.current?.click()}>Choose CSV file</button>
        </div>
      )}

      {error && <div className="err">{error}</div>}
    </div>
  );
}
