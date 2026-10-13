/**
 * edgeExportPdf.ts — Trading_Report.pdf generation for the AI Edge
 * Analysis Export, drawn programmatically with pdf-lib (dynamically
 * imported so non-export users never download it). Vector text, tables
 * and line charts only — no HTML rasterization, nothing clipped: the
 * layout cursor paginates every block.
 *
 * The PDF is a descriptive evidence report. Sections whose data does not
 * exist say so plainly instead of being filled with invented insight.
 */
import {
  cumulativePnlSeries, formatRangeText, periodModeLabel, sourceLabel,
  type ExportSnapshot, type ScreenshotCoverage,
} from "./edgeExport";
import { breakdown, type AnalyticsTrade, type BreakdownDimension } from "./journalAnalytics";

export interface PdfScreenshotImage {
  tradeId: string;
  fileName: string;
  bytes: Uint8Array;
  format: "png" | "jpg";
}

/** pdf-lib standard fonts use WinAnsi encoding — replace characters it
 *  cannot encode with safe equivalents. */
export function pdfSafe(s: string): string {
  return s
    .replace(/−/g, "-")
    .replace(/→/g, "->")
    .replace(/▸|▾|▸/g, ">")
    .replace(/Δ/g, "Delta")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/∞/g, "unbounded")
    .replace(/×/g, "x")
    .replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•·]/g, "?");
}

function money(n: number | null | undefined, unbounded = false): string {
  if (n == null || !Number.isFinite(n)) return unbounded ? "Unbounded" : "n/a";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pct(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "n/a" : `${n.toFixed(1)}%`;
}
function rFmt(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "n/a" : `${n.toFixed(2)}R`;
}

type RGB = { r: number; g: number; b: number };

export async function buildTradingReportPdf(
  snapshot: ExportSnapshot,
  analytics: Record<string, unknown>,
  coverage: ScreenshotCoverage,
  images: PdfScreenshotImage[] = [],
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const INK: RGB = { r: 0.09, g: 0.12, b: 0.14 };
  const GRAY: RGB = { r: 0.42, g: 0.48, b: 0.52 };
  const GREEN: RGB = { r: 0.05, g: 0.62, b: 0.42 };
  const RED: RGB = { r: 0.9, g: 0.22, b: 0.3 };
  const LINE: RGB = { r: 0.78, g: 0.82, b: 0.85 };
  const c = (col: RGB) => rgb(col.r, col.g, col.b);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 48;
  const CW = W - M * 2;

  let page = doc.addPage([W, H]);
  let y = H - M;

  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const ensure = (h: number) => { if (y - h < M) newPage(); };
  const wrap = (text: string, f: typeof font, size: number, maxW: number): string[] => {
    const words = pdfSafe(text).split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let line = "";
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(trial, size) > maxW && line) { out.push(line); line = w; }
      else line = trial;
    }
    if (line) out.push(line);
    return out.length > 0 ? out : [""];
  };
  const text = (s: string, size = 10, f: typeof font = font, col: RGB = INK, indent = 0) => {
    ensure(size + 3);
    page.drawText(pdfSafe(s), { x: M + indent, y: y - size, size, font: f, color: c(col) });
    y -= size + 3;
  };
  const para = (s: string, size = 9.5, col: RGB = INK, indent = 0) => {
    for (const ln of wrap(s, font, size, CW - indent)) text(ln, size, font, col, indent);
    y -= 2;
  };
  const heading = (s: string) => {
    y -= 8;
    ensure(22);
    text(s, 13, bold);
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.7, color: c(LINE) });
    y -= 4;
  };
  const table = (headers: string[], rows: string[][], colW: number[]) => {
    const size = 8.5, rowH = 13;
    const drawRow = (cells: string[], f: typeof font, col: RGB) => {
      ensure(rowH + 2);
      let x = M;
      cells.forEach((cell, i) => {
        let t = pdfSafe(cell);
        const maxW = colW[i] - 6;
        while (t.length > 0 && f.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -2);
        if (t !== pdfSafe(cell)) t = `${t}..`;
        page.drawText(t, { x, y: y - size, size, font: f, color: c(col) });
        x += colW[i];
      });
      y -= rowH;
      page.drawLine({ start: { x: M, y: y + 3 }, end: { x: W - M, y: y + 3 }, thickness: 0.4, color: c(LINE) });
    };
    drawRow(headers, bold, GRAY);
    for (const r of rows) drawRow(r, font, INK);
    y -= 4;
  };
  const lineChart = (title: string, points: { x: string; v: number }[], color: RGB, height = 130) => {
    text(title, 10, bold);
    if (points.length < 2) {
      para("Not enough trading days in this selection to draw this chart (at least 2 are needed). The underlying daily figures are in analytics.json (dailyPnl).", 9, GRAY);
      return;
    }
    ensure(height + 18);
    const top = y, boxH = height;
    const vals = points.map((p) => p.v);
    const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
    const span = max - min || 1;
    const px = (i: number) => M + (i / (points.length - 1)) * CW;
    const py = (v: number) => top - ((v - min) / span) * (boxH - 14) - 4;
    // zero line
    page.drawLine({ start: { x: M, y: py(0) }, end: { x: W - M, y: py(0) }, thickness: 0.6, color: c(LINE) });
    for (let i = 1; i < points.length; i++) {
      page.drawLine({ start: { x: px(i - 1), y: py(vals[i - 1]) }, end: { x: px(i), y: py(vals[i]) }, thickness: 1.3, color: c(color) });
    }
    page.drawText(pdfSafe(`max ${money(max)}`), { x: M, y: top + 2, size: 7.5, font, color: c(GRAY) });
    page.drawText(pdfSafe(`min ${money(min)}`), { x: M, y: top - boxH - 8, size: 7.5, font, color: c(GRAY) });
    page.drawText(pdfSafe(`${points[0].x} -> ${points[points.length - 1].x}`), { x: W - M - 130, y: top - boxH - 8, size: 7.5, font, color: c(GRAY) });
    y -= boxH + 16;
  };

  const overall = (analytics.overall ?? {}) as Record<string, any>;
  const meta = (analytics.metadata ?? {}) as Record<string, any>;
  const at: AnalyticsTrade[] = snapshot.analyticsTrades;

  /* ---- cover ---- */
  text("Grow Green Lab", 11, bold, GREEN);
  text("Trading Report - AI Edge Analysis", 22, bold);
  y -= 4;
  para(`Period: ${formatRangeText(snapshot.range, snapshot.periodMode)}`);
  para(`Trade source: ${sourceLabel(snapshot.source)}`);
  para(`Generated: ${snapshot.generatedAt}`);
  para(`Trades: ${snapshot.counts.total} total (${snapshot.counts.closed} closed, ${snapshot.counts.open} open) - ${snapshot.counts.real} Real Market, ${snapshot.counts.simulator} Simulator`);
  para("This report is a descriptive summary of your recorded journal evidence. It is not financial advice and not a promise of profitability.", 9, GRAY);

  /* ---- executive summary ---- */
  heading("Executive summary");
  if (snapshot.counts.closed === 0) {
    para("No closed trades in this selection, so there is no performance evidence to summarize. Open trades (if any) are listed in trades.csv; analytics cover closed trades only.");
  } else {
    para(`Net realized P&L ${money(overall.netRealizedPnl)} across ${overall.closedTrades} closed trades (${overall.wins} wins, ${overall.losses} losses, ${overall.breakevens} breakeven). Win rate ${pct(overall.winRate)} (breakevens excluded from the denominator). Expectancy ${money(overall.expectancy)} per trade. Profit factor ${overall.profitFactorUnbounded ? "unbounded (winners with no losing trades)" : overall.profitFactor == null ? "n/a" : Number(overall.profitFactor).toFixed(2)}. Average R ${rFmt(overall.avgR)} over ${overall.tradesWithR} trades with a recorded stop. Maximum drawdown ${money(overall.maxDrawdownUSD)}${overall.maxDrawdownPct != null ? ` (${overall.maxDrawdownPct.toFixed(1)}% of the preceding cumulative P&L peak)` : ""}.`);
    if (snapshot.source === "all") para("This selection mixes Real Market and Simulator trades. Per-source subtotals are in analytics.json (perSource); do not read combined figures as real-money performance.", 9, GRAY);
  }

  /* ---- overall stats ---- */
  heading("Overall performance");
  if (snapshot.counts.closed === 0) {
    para("No closed trades - no statistics can be calculated. This is stated plainly rather than filled with placeholder numbers.");
  } else {
    table(["Metric", "Value"], [
      ["Closed trades", String(overall.closedTrades ?? "")],
      ["Wins / Losses / Breakeven", `${overall.wins} / ${overall.losses} / ${overall.breakevens}`],
      ["Win rate (breakevens excl.)", pct(overall.winRate)],
      ["Net realized P&L", money(overall.netRealizedPnl)],
      ["Gross profit / Gross loss", `${money(overall.grossProfit)} / ${money(overall.grossLoss)}`],
      ["Expectancy per trade", money(overall.expectancy)],
      ["Profit factor", overall.profitFactorUnbounded ? "Unbounded" : overall.profitFactor == null ? "n/a" : Number(overall.profitFactor).toFixed(2)],
      ["Average win / Average loss", `${money(overall.avgWin)} / ${money(overall.avgLoss)}`],
      ["Win/loss ratio", overall.winLossRatio == null ? "n/a" : Number(overall.winLossRatio).toFixed(2)],
      ["Average R / Median R", `${rFmt(overall.avgR)} / ${rFmt(overall.medianR)}`],
      ["Largest win / Largest loss", `${money(overall.largestWin)} / ${money(overall.largestLoss)}`],
      ["Max drawdown", `${money(overall.maxDrawdownUSD)}${overall.maxDrawdownPct != null ? ` (${overall.maxDrawdownPct.toFixed(1)}% of peak)` : ""}`],
      ["Longest win / loss streak", `${overall.maxWinStreak} / ${overall.maxLossStreak}`],
      ["Avg risk per trade", `${money(overall.avgRiskPerTrade)} (${overall.tradesWithRisk} trades with known risk)`],
      ["Trading days / Losing days", `${overall.tradingDays} / ${overall.losingDays} (${pct(overall.losingDayFrequency)})`],
      ["Recorded fees", overall.feesComplete ? money(overall.totalFeesRecorded) : `${money(overall.totalFeesRecorded)} (partial - some trades have unrecorded fees; see analytics.json)`],
    ], [250, 249]);
  }

  /* ---- charts ---- */
  const series = cumulativePnlSeries(snapshot);
  lineChart("Cumulative realized P&L by trading day", series.map((p) => ({ x: p.date, v: p.cumulative })), GREEN);
  lineChart("Drawdown from cumulative peak (USD)", series.map((p) => ({ x: p.date, v: p.drawdown })), RED);

  /* ---- breakdowns ---- */
  const bdTable = (title: string, dim: BreakdownDimension) => {
    heading(title);
    const rows = breakdown(at, dim).filter((r) => r.label !== "Not recorded" || dim === "setup").slice(0, 12);
    if (rows.length === 0) {
      para("No data recorded for this breakdown in the selected trades. Tag trades in Trade Review to populate it.", 9, GRAY);
      return;
    }
    table(["Bucket", "Trades", "Win %", "Net P&L", "Avg R", "Expectancy"],
      rows.map((r) => [r.label, String(r.count), pct(r.winRate), money(r.netPnl), rFmt(r.avgR), money(r.expectancy)]),
      [170, 50, 60, 80, 60, 79]);
  };
  bdTable("Setup breakdown", "setup");
  bdTable("HOD classification breakdown", "hodClass");
  bdTable("Key level breakdown", "keyLevel");
  bdTable("Trade interaction breakdown", "interaction");

  /* ---- Edge Finder ---- */
  heading("Edge Finder (from the journal Analytics tab)");
  const ef = (analytics.edgeFinder ?? {}) as Record<string, any>;
  if (snapshot.counts.closed === 0) {
    para("No closed trades - the Edge Finder has nothing to analyze.");
  } else {
    const statLine = (label: string, s: any) => {
      if (!s || !s.stat) { para(`${label}: unavailable - ${s?.reason ?? "not enough data."}`); return; }
      para(`${label}: ${s.stat.label} - ${s.stat.count} trades, net ${money(s.stat.netPnl)}, expectancy ${money(s.stat.expectancy)}, avg R ${rFmt(s.stat.avgR)}${s.smallSample ? " [SMALL SAMPLE - under 10 trades, treat as a hypothesis, not an edge]" : ""}`);
    };
    statLine("Best setup (by expectancy)", ef.bestSetup);
    statLine("Best HOD classification", ef.bestHodClass);
    statLine("Costliest mistake", ef.costliestMistake);
    statLine("Worst emotion (by net P&L)", ef.worstEmotion);
    statLine("Best time window (by expectancy)", ef.bestTimeWindow);
    para("Edge Finder output describes historical associations inside this selection. It is not a prediction and does not validate an edge by itself.", 9, GRAY);
  }

  /* ---- entry/exit + risk findings ---- */
  heading("Entry, exit and risk findings");
  const ee = (analytics.entryExit ?? {}) as Record<string, any>;
  para(`Partial exits: ${ee.partialExitTrades ?? 0} closed trades used more than one exit fill (net ${money(ee.partialExitNetPnl)}). Average hold time ${ee.avgHoldMinutes == null ? "n/a (timestamps missing)" : `${Number(ee.avgHoldMinutes).toFixed(1)} minutes over ${ee.tradesWithHoldData} trades`}. Plan changes recorded: ${ee.planChangesRecorded ?? 0} across ${ee.tradesWithPlanChanges ?? 0} trades - original plans are preserved and R is calculated from the original plan where one is recorded.`);
  para(`Risk: average R ${rFmt(overall.avgR)}, max drawdown ${money(overall.maxDrawdownUSD)}, longest loss streak ${overall.maxLossStreak ?? 0}, losing days ${pct(overall.losingDayFrequency)}. Stop coverage: ${meta.missingDataSummary?.tradesWithoutRecordedStop ?? "n/a"} closed trades have no recorded stop, so no R can be calculated for them.`);

  /* ---- screenshots ---- */
  heading("Screenshot evidence");
  para(coverage.note);
  if (images.length > 0) {
    for (const img of images.slice(0, 3)) {
      try {
        const embedded = img.format === "png" ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
        const maxW = CW, maxH = 230;
        const scale = Math.min(maxW / embedded.width, maxH / embedded.height, 1);
        const w = embedded.width * scale, h = embedded.height * scale;
        ensure(h + 26);
        text(`${img.tradeId} - ${img.fileName}`, 8.5, font, GRAY);
        page.drawImage(embedded, { x: M, y: y - h, width: w, height: h });
        y -= h + 8;
      } catch {
        para(`${img.tradeId} - ${img.fileName}: image could not be embedded in the PDF; the original file is in the package under screenshots/.`, 9, GRAY);
      }
    }
  }

  /* ---- missing data & methodology ---- */
  heading("Missing data and limitations");
  const unavail = (meta.metricsUnavailable ?? []) as { label: string; reason: string }[];
  for (const u of unavail) para(`- ${u.label}: ${u.reason}`, 9);
  for (const w of snapshot.warnings) para(`- ${w}`, 9);
  para("Areas for further investigation (evidence gaps, not conclusions): record a stop loss on every real trade so R coverage improves; keep tagging setups, HOD class, mistakes and emotions in Trade Review; attach screenshots to real trades you want reviewed visually; accumulate at least 10 trades per setup before treating any pattern as an edge.", 9);

  heading("Methodology and definitions");
  para("All figures are computed by the same library functions the journal Analytics tab renders (lib/journalAnalytics.ts: breakdown, riskMetrics, dailyPnl, edgeInsights; lib/journal.ts: calcMetrics, perExitPnl FIFO). Win rate excludes breakeven trades from the denominator. Expectancy is net P&L per closed trade including breakevens. R uses the ORIGINAL planned stop when recorded, otherwise the trade's recorded stop. Drawdown percentage is relative to the peak cumulative realized P&L (no account-equity baseline exists in the journal). Open trades are excluded from performance statistics. Simulator results are simulated replay outcomes.");
  para("Definitions for every metric shipped in this package are in analytics.json under metadata.calculationDefinitions, and column definitions are in README.txt.", 9, GRAY);

  return doc.save();
}
