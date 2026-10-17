"use client";

/**
 * EdgeExportPanel — AI Edge Analysis Export UI for the journal
 * Analytics tab. The trader picks a period (Daily / Sunday-Saturday
 * Weekly / Monthly / Custom), a source, and options; the package is
 * generated entirely in the browser from the journal's already-loaded
 * data (lib/edgeExport.ts snapshot) and downloaded as one ZIP. Nothing
 * is uploaded or sent anywhere — the user hands the ZIP to ChatGPT
 * themselves. Generation code (jszip / pdf-lib) is dynamically imported
 * by lib/edgeExportPackage.ts only when Generate is clicked.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, isSupabaseConfigured } from "../lib/supabaseClient";
import {
  buildExportSnapshot, formatRangeText, resolveExportRange, sourceLabel, todayLocalStr,
  type ExportPeriodMode, type ExportSnapshot, type ExportSnapshotInput, type ExportSource,
} from "../lib/edgeExport";

import { generateEdgePackage, listExportScreenshots, type PackageResult } from "../lib/edgeExportPackage";

const MAX_AUTO_SCREENSHOT_TRADES = 60;

export default function EdgeExportPanel({ input }: { input: ExportSnapshotInput }) {
  const today = useMemo(() => todayLocalStr(), []);
  const [mode, setMode] = useState<ExportPeriodMode>("monthly");
  const [anchor, setAnchor] = useState(today);
  const [customStart, setCustomStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [customEnd, setCustomEnd] = useState(today);
  const [source, setSource] = useState<ExportSource>("all");
  const [includeScreenshots, setIncludeScreenshots] = useState(true);
  const [includePdf, setIncludePdf] = useState(true);
  // Daily Replay narrowing (export-panel-only, per the approved design):
  // strategy / version / single attempt + the Decision Timeline toggle.
  const [strategySel, setStrategySel] = useState("");
  const [versionSel, setVersionSel] = useState("");
  const [attemptSel, setAttemptSel] = useState("");
  const [includeTimeline, setIncludeTimeline] = useState(true);

  const [shotInfo, setShotInfo] = useState<{ state: "idle" | "loading" | "done" | "skipped" | "error"; files: number; tradesWith: number }>({ state: "idle", files: 0, tradesWith: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(PackageResult & { url: string }) | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [copied, setCopied] = useState(false);
  const urlRef = useRef<string | null>(null);

  const rangeResult = useMemo(() => {
    try {
      return { range: resolveExportRange({ mode, anchorDate: anchor, customStart, customEnd }), error: null as string | null };
    } catch (e) {
      return { range: null, error: e instanceof Error ? e.message : "Invalid date range." };
    }
  }, [mode, anchor, customStart, customEnd]);

  const snapshot: ExportSnapshot | null = useMemo(() => {
    if (!rangeResult.range) return null;
    return buildExportSnapshot(input, {
      range: rangeResult.range, mode, source,
      strategyId: strategySel || null,
      strategyVersionId: versionSel || null,
      attemptId: attemptSel || null,
    });
  }, [input, rangeResult.range, mode, source, strategySel, versionSel, attemptSel]);

  // Screenshot-eligible trades: real + Daily Replay (Trade Lab sim excluded).
  const realInRange = useMemo(
    () => snapshot?.trades.filter((t) => t.source === "real" || t.isDailyReplay).length ?? 0,
    [snapshot],
  );
  const realKeysSig = useMemo(
    () => (snapshot?.trades.filter((t) => t.source === "real" || t.isDailyReplay).map((t) => t.tradeKey).join("|")) ?? "",
    [snapshot],
  );
  const hasDrOptions = (input.drAttempts?.length ?? 0) > 0 || (input.strategies?.length ?? 0) > 0;

  // Lazily count available screenshots for the current selection (listing
  // only — bytes are fetched at generation time). Bounded: skipped for
  // very large selections and reported as "checked when you generate".
  useEffect(() => {
    if (!includeScreenshots || !snapshot || realInRange === 0) {
      setShotInfo({ state: "idle", files: 0, tradesWith: 0 });
      return;
    }
    if (realInRange > MAX_AUTO_SCREENSHOT_TRADES) {
      setShotInfo({ state: "skipped", files: 0, tradesWith: 0 });
      return;
    }
    let alive = true;
    setShotInfo({ state: "loading", files: 0, tradesWith: 0 });
    (async () => {
      try {
        if (!isSupabaseConfigured()) throw new Error("not configured");
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("not signed in");
        const listed = await listExportScreenshots(supabase, user.id, snapshot);
        if (!alive) return;
        let files = 0, tradesWith = 0;
        for (const paths of listed.values()) { files += paths.length; if (paths.length > 0) tradesWith++; }
        setShotInfo({ state: "done", files, tradesWith });
      } catch {
        if (alive) setShotInfo({ state: "error", files: 0, tradesWith: 0 });
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeScreenshots, realKeysSig]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const generate = async () => {
    if (!snapshot || busy) return;
    setBusy("Preparing…");
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      if (!isSupabaseConfigured()) throw new Error("Supabase is not configured, so screenshots cannot be collected. Turn screenshots off or check the app configuration.");
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Please sign in to generate an export — screenshots are read under your own session.");
      const res = await generateEdgePackage(supabase, user.id, snapshot, { includeScreenshots, includePdf, includeDecisionTimeline: includeTimeline }, (stage, pct) => {
        setBusy(pct != null ? `${stage} — ${Math.round(pct)}%` : stage);
      });
      const url = URL.createObjectURL(res.blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setResult({ ...res, url });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The export failed unexpectedly. Nothing was downloaded.");
    } finally {
      setBusy(null);
    }
  };

  const copyPrompt = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.promptText);
      setCopied(true);
    } catch {
      setError("Copying failed — your browser blocked clipboard access. Open the ZIP and copy ChatGPT_Prompt.txt manually.");
    }
  };

  const pill = (active: boolean): React.CSSProperties => ({
    padding: "4px 12px", borderRadius: 16, fontSize: 12, cursor: "pointer",
    background: active ? "rgba(16,185,129,0.2)" : "rgba(255,255,255,0.05)",
    border: active ? "1px solid rgba(16,185,129,0.5)" : "1px solid rgba(255,255,255,0.1)",
    color: active ? "#34d399" : "var(--muted)",
  });

  const warnings: string[] = [];
  if (snapshot) {
    if (snapshot.counts.simulator - snapshot.counts.dailyReplay > 0) warnings.push("Trade Lab simulator trades have no screenshots and no recorded original stop/target — those fields export as unavailable, never invented.");
    if (snapshot.counts.dailyReplay > 0) warnings.push("Daily Replay trades are historical backtests. Their original plan and R come only from the risk snapshot recorded at entry; trades without one export R as unavailable.");
    if (realInRange > 0 && shotInfo.state === "done" && shotInfo.files === 0) warnings.push("No screenshots are attached to the eligible trades in this selection — the package will state that plainly instead of fabricating images.");
    if (snapshot.counts.total === 0) warnings.push("No trades match this period and source. You can still generate the package — it will document an empty selection rather than silently widening the range.");
  }

  return (
    <section className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>AI Edge Analysis Export</h3>
        <span className="hint">One ZIP with your trades, analytics, Edge Finder output and screenshots — ready to hand to ChatGPT. Generated on this device; nothing is uploaded automatically.</span>
      </div>

      {/* period */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 14 }}>
        <span style={{ fontSize: 12, color: "var(--muted)", width: 64 }}>Period:</span>
        {([["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["custom", "Custom"]] as [ExportPeriodMode, string][]).map(([m, label]) => (
          <button key={m} style={pill(mode === m)} onClick={() => setMode(m)}>{label}</button>
        ))}
        {mode !== "custom" ? (
          <input className="input" type="date" value={anchor} max={today} onChange={(e) => setAnchor(e.target.value)} style={{ width: "auto" }} aria-label="Period date" />
        ) : (
          <>
            <input className="input" type="date" value={customStart} max={customEnd || today} onChange={(e) => setCustomStart(e.target.value)} style={{ width: "auto" }} aria-label="Start date" />
            <span className="hint">to</span>
            <input className="input" type="date" value={customEnd} max={today} onChange={(e) => setCustomEnd(e.target.value)} style={{ width: "auto" }} aria-label="End date" />
          </>
        )}
      </div>
      <div className="hint" style={{ marginTop: 6, marginLeft: 70 }}>
        {rangeResult.range
          ? <>Export range: <b style={{ color: "var(--foreground)" }}>{formatRangeText(rangeResult.range, mode)}</b> — trade dates as stored in your journal.</>
          : <span style={{ color: "#f6465d" }}>{rangeResult.error}</span>}
      </div>

      {/* source */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
        <span style={{ fontSize: 12, color: "var(--muted)", width: 64 }}>Source:</span>
        {([["all", "All Trades"], ["real", "Real Market"], ["simulator", "Simulator"], ["daily_replay", "Daily Replay"]] as [ExportSource, string][]).map(([s, label]) => (
          <button key={s} style={pill(source === s)} onClick={() => setSource(s)}>{label}</button>
        ))}
        <span className="hint">{sourceLabel(source)}</span>
      </div>

      {/* Daily Replay narrowing: strategy / version / attempt */}
      {hasDrOptions && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
          <span style={{ fontSize: 12, color: "var(--muted)", width: 64 }}>Strategy:</span>
          <select className="input" style={{ width: "auto", fontSize: 12, padding: "4px 8px" }} value={strategySel}
            onChange={(e) => { setStrategySel(e.target.value); setVersionSel(""); }} aria-label="Export strategy">
            <option value="">All strategies</option>
            {(input.strategies ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="input" style={{ width: "auto", fontSize: 12, padding: "4px 8px" }} value={versionSel}
            onChange={(e) => setVersionSel(e.target.value)} aria-label="Export strategy version">
            <option value="">All versions</option>
            {(input.strategyVersions ?? [])
              .filter((v) => !strategySel || v.strategyId === strategySel)
              .map((v) => {
                const s = (input.strategies ?? []).find((x) => x.id === v.strategyId);
                return <option key={v.id} value={v.id}>{s?.name ?? "Strategy"} · v{v.version}</option>;
              })}
          </select>
          <select className="input" style={{ width: "auto", fontSize: 12, padding: "4px 8px" }} value={attemptSel}
            onChange={(e) => setAttemptSel(e.target.value)} aria-label="Export attempt">
            <option value="">All attempts</option>
            {(input.drAttempts ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.ticker ?? "Attempt"} · {a.tradeDate ?? ""} · {a.id.slice(0, 8)}</option>
            ))}
          </select>
          <span className="hint">Narrows Daily Replay trades only.</span>
        </div>
      )}

      {/* counts */}
      {snapshot && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 12, fontSize: 12.5 }}>
          <span>Eligible trades: <b className="num">{snapshot.counts.total}</b> <span className="hint">({snapshot.counts.closed} closed, {snapshot.counts.open} open)</span></span>
          <span className="hint">Real {snapshot.counts.real} · Simulator {snapshot.counts.simulator - snapshot.counts.dailyReplay} · Daily Replay {snapshot.counts.dailyReplay}</span>
          <span className="hint">
            Screenshots: {!includeScreenshots ? "off" : realInRange === 0 ? "none (no eligible trades)" : shotInfo.state === "loading" ? "checking…" : shotInfo.state === "done" ? `${shotInfo.files} file${shotInfo.files === 1 ? "" : "s"} across ${shotInfo.tradesWith} trade${shotInfo.tradesWith === 1 ? "" : "s"}` : shotInfo.state === "skipped" ? `checked when you generate (selection exceeds the ${MAX_AUTO_SCREENSHOT_TRADES}-trade auto-count cap)` : "unknown — will be checked when you generate"}
          </span>
          <span className="hint">Trades missing screenshots: {includeScreenshots && shotInfo.state === "done" ? Math.max(0, realInRange - shotInfo.tradesWith) : "—"}</span>
        </div>
      )}

      {includeScreenshots && shotInfo.state === "skipped" && (
        <div style={{ marginTop: 10, padding: "9px 12px", borderRadius: 8, background: "rgba(56,189,248,0.07)", border: "1px solid rgba(56,189,248,0.3)", fontSize: 12.5 }}>
          Screenshot count is an estimate — auto-count covers up to {MAX_AUTO_SCREENSHOT_TRADES} real trades, and this selection has more. The exact count is calculated during generation and printed in the package summary, analytics.json and screenshots-manifest.json.
        </div>
      )}

      {/* options */}
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 12, fontSize: 13 }}>
        <label style={{ display: "flex", gap: 7, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={includeScreenshots} onChange={(e) => setIncludeScreenshots(e.target.checked)} />
          Include available trade screenshots
        </label>
        <label style={{ display: "flex", gap: 7, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={includePdf} onChange={(e) => setIncludePdf(e.target.checked)} />
          Include visual PDF report
        </label>
        {snapshot?.dailyReplay && (
          <label style={{ display: "flex", gap: 7, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={includeTimeline} onChange={(e) => setIncludeTimeline(e.target.checked)} />
            Include Decision Timeline (decision_timeline.csv)
          </label>
        )}
      </div>
      <p className="hint" style={{ margin: "8px 0 0", fontSize: 11.5 }}>
        Package contents: trades.csv · analytics.json{includePdf ? " · Trading_Report.pdf" : ""} · ChatGPT_Prompt.txt · README.txt · screenshots-manifest.json{includeScreenshots ? " · screenshots/" : ""}{snapshot?.dailyReplay ? `${includeTimeline ? " · decision_timeline.csv" : ""} · strategy.json` : ""}
      </p>

      {warnings.length > 0 && (
        <div style={{ marginTop: 10, padding: "9px 12px", borderRadius: 8, background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.35)", fontSize: 12.5 }}>
          {warnings.map((w) => <div key={w}>⚠ {w}</div>)}
        </div>
      )}
      {snapshot && snapshot.warnings.length > 0 && (
        <div className="hint" style={{ marginTop: 8, fontSize: 11.5 }}>
          {snapshot.warnings.map((w) => <div key={w}>{w}</div>)}
        </div>
      )}

      {/* actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 14 }}>
        <button className="btn" onClick={generate} disabled={!snapshot || !!busy}
          style={{ background: "rgba(16,185,129,0.18)", borderColor: "rgba(16,185,129,0.5)", color: "#34d399", fontWeight: 600 }}>
          {busy ? busy : "Generate AI Analysis Package"}
        </button>
        {result && (
          <>
            <a className="btn" href={result.url} download={result.fileName} style={{ background: "var(--emerald)", borderColor: "var(--emerald-deep)", color: "#06251b", fontWeight: 700, textDecoration: "none" }}>
              Download ZIP
            </a>
            <button className="btn" onClick={copyPrompt}>{copied ? "Prompt copied ✓" : "Copy ChatGPT Prompt"}</button>
            <button className="btn" onClick={() => setShowSummary((s) => !s)}>{showSummary ? "Hide" : "View"} Export Summary</button>
          </>
        )}
      </div>
      {error && <div className="err" style={{ marginTop: 10 }}>{error} <button className="btn" style={{ marginLeft: 8, padding: "2px 10px" }} onClick={generate} disabled={!snapshot || !!busy}>Retry</button></div>}

      {result && showSummary && (
        <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 8, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", fontSize: 12.5 }}>
          <div><b>{result.summary.fileName}</b></div>
          <div className="hint" style={{ marginTop: 4 }}>
            {result.summary.tradeCount} trades ({result.summary.closedCount} closed) · {result.summary.screenshotFiles} screenshot file{result.summary.screenshotFiles === 1 ? "" : "s"} · PDF {result.summary.pdfIncluded ? "included" : "NOT included"}
          </div>
          <div style={{ marginTop: 6 }}>Files: {result.summary.filesIncluded.join(" · ")}</div>
          {result.summary.warnings.length > 0 && (
            <div style={{ marginTop: 6, color: "#fbbf24" }}>
              {result.summary.warnings.map((w) => <div key={w}>⚠ {w}</div>)}
            </div>
          )}
          <p className="hint" style={{ margin: "8px 0 0" }}>Next step: open ChatGPT, attach the ZIP contents, and paste the prompt (Copy ChatGPT Prompt). Review the package before sharing it — it contains your personal trading history.</p>
        </div>
      )}
    </section>
  );
}
