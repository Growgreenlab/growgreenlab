/**
 * edgeExportPackage.ts — assembles the AI Edge Analysis ZIP from one
 * ExportSnapshot (lib/edgeExport.ts). All heavy libraries (jszip,
 * pdf-lib via lib/edgeExportPdf.ts) are dynamically imported at
 * generation time only.
 *
 * Guarantees:
 * - Screenshots are fetched as BYTES through the caller's RLS-scoped
 *   storage session (owner-folder policies) — signed URLs never enter
 *   the package, and neither do raw storage paths: every serialized
 *   manifest (screenshots-manifest.json, analytics.json) carries only
 *   the public projection (stable trade ID, package file, status).
 * - A screenshot that cannot be downloaded is marked "unavailable" in
 *   the manifest and reported as a warning — it never aborts the export
 *   and is never silently dropped.
 * - If PDF generation fails, the package is still produced WITHOUT the
 *   PDF, the failure is surfaced in warnings/README/prompt context —
 *   the PDF is never claimed to be included when it is not.
 * - Everything derives from the single snapshot passed in, so CSV, JSON,
 *   PDF, prompt and README cannot describe different trade sets.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUCKET, listScreenshots } from "./journalAttachments";
import {
  buildAnalyticsJson, buildChatGptPrompt, buildDecisionTimelineCsv, buildReadme,
  buildScreenshotManifest, buildStrategyJson, buildTradesCsv,
  publicScreenshotManifestEntry, summarizeScreenshotCoverage,
  type ExportSnapshot, type ScreenshotListing, type ScreenshotManifestEntry,
} from "./edgeExport";
import type { PdfScreenshotImage } from "./edgeExportPdf";
import {
  buildChartContextCsv, buildTradeChartContext, summarizeChartContexts,
} from "./drChartContext";

export type ExportProgressFn = (stage: string, pct?: number) => void;

export interface GeneratePackageOptions {
  includeScreenshots: boolean;
  includePdf: boolean;
  /** Include decision_timeline.csv (default true when the snapshot
   *  has Daily Replay trades; the file is only ever produced then). */
  includeDecisionTimeline?: boolean;
  /** Include chart_context.csv — per-trade OHLCV from the sessions'
   *  stored candles (default true when the snapshot has Daily Replay
   *  or Trade Lab simulator trades — both store session candles).
   *  The file is produced only when at least one trade's context
   *  validates; per-trade failures become warnings. */
  includeChartContext?: boolean;
}

export interface PackageSummary {
  fileName: string;
  filesIncluded: string[];
  tradeCount: number;
  closedCount: number;
  screenshotFiles: number;
  pdfIncluded: boolean;
  warnings: string[];
}

export interface PackageResult {
  blob: Blob;
  fileName: string;
  promptText: string;
  summary: PackageSummary;
  manifest: ScreenshotManifestEntry[];
  warnings: string[];
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * List screenshot storage objects for every screenshot-eligible trade
 * in the snapshot — real trades and Daily Replay trades (bounded
 * concurrency). Trade Lab simulator trades remain excluded. Returns
 * tradeKey → listed objects (path + the storage recorded time,
 * audit §G 1c). Listing uses the caller's own session; storage
 * policies restrict it to the user's own folder, so another user's
 * screenshots can never be listed.
 */
export async function listExportScreenshots(
  client: SupabaseClient,
  userId: string,
  snapshot: ExportSnapshot,
  onProgress?: ExportProgressFn,
): Promise<Map<string, ScreenshotListing[]>> {
  const eligible = snapshot.trades.filter((r) => r.source === "real" || r.isDailyReplay);
  const out = new Map<string, ScreenshotListing[]>();
  let done = 0;
  await mapPool(eligible, 4, async (rec) => {
    // Daily Replay trades union BOTH prefixes (plan §2.4): the
    // canonical session trade key and, when the trade was born as a
    // draft, its draft key — auto-captures and draft-era uploads live
    // under the draft prefix. Merged + deduped by storage path.
    const keys = [rec.tradeKey];
    if (rec.isDailyReplay) {
      const draftKey = snapshot.dailyReplay?.draftInfoByTradeKey?.get(rec.tradeKey)?.draftKey;
      if (draftKey && draftKey !== rec.tradeKey) keys.push(draftKey);
    }
    const listings: ScreenshotListing[] = [];
    for (const k of keys) {
      const list = await listScreenshots(client, userId, k);
      for (const s of list) {
        if (!listings.some((l) => l.path === s.path)) {
          listings.push({ path: s.path, createdAt: s.createdAt });
        }
      }
    }
    out.set(rec.tradeKey, listings);
    done++;
    onProgress?.(`Checking screenshots (${done}/${eligible.length})`, eligible.length ? (done / eligible.length) * 100 : 100);
  });
  return out;
}

export async function generateEdgePackage(
  client: SupabaseClient,
  userId: string,
  snapshot: ExportSnapshot,
  options: GeneratePackageOptions,
  onProgress?: ExportProgressFn,
): Promise<PackageResult> {
  const warnings: string[] = [...snapshot.warnings];
  const zipFileName = `growgreen-ai-edge-${snapshot.range.end}.zip`;

  /* ---- screenshots: list, then download bytes (bounded) ---- */
  let manifest: ScreenshotManifestEntry[] = [];
  const shotBytes = new Map<string, Uint8Array>(); // zip file path -> bytes
  if (options.includeScreenshots) {
    onProgress?.("Checking screenshots", 0);
    const listed = await listExportScreenshots(client, userId, snapshot, onProgress);
    manifest = buildScreenshotManifest(snapshot, listed, userId);
    // EVERY manifest entry is downloadable (audit §G 1a): the
    // representative-only download limit was retired by Karandeep's
    // 2026-10-18 ruling — entry, exit and manual images all ship.
    const downloadable = manifest;
    if (downloadable.length > 0) {
      let done = 0;
      await mapPool(downloadable, 4, async (entry) => {
        try {
          const { data, error } = await client.storage.from(BUCKET).download(entry.storagePath);
          if (error || !data) throw new Error(error?.message ?? "download returned no data");
          const bytes = new Uint8Array(await data.arrayBuffer());
          if (bytes.length === 0) throw new Error("downloaded file was empty");
          shotBytes.set(entry.file!, bytes);
          entry.status = "included";
        } catch (e) {
          entry.status = "unavailable";
          entry.file = null;
          warnings.push(`Screenshot ${entry.fileName} for ${entry.tradeId} could not be downloaded (${e instanceof Error ? e.message : "unknown error"}) - it is listed in the manifest as unavailable, not silently omitted.`);
        }
        done++;
        onProgress?.(`Downloading screenshots (${done}/${downloadable.length})`, (done / downloadable.length) * 100);
      });
    }
  }
  const coverage = summarizeScreenshotCoverage(snapshot, manifest, options.includeScreenshots);

  /* ---- Daily Replay artifacts (schema 2.0, DR selections only) ---- */
  const strategyJson = buildStrategyJson(snapshot);
  const includeTimeline = options.includeDecisionTimeline !== false && snapshot.dailyReplay != null;
  const timelineCsv = includeTimeline ? buildDecisionTimelineCsv(snapshot) : null;

  /* ---- chart context (Representative plan §5 S1.2; audit §G 2d) ----
   * Built from the sessions' STORED candles (replay_sessions.
   * candles), read through the caller's own RLS session, for Daily
   * Replay trades AND Trade Lab simulator trades (both store their
   * session candles; real trades store none and stay honestly
   * unavailable). For a PRE-COMPLETION DR trade (finalized draft,
   * attempt still active — no session row exists yet) the candle
   * source is the attempt's REVEALED candles via the owner RPC
   * dr_get_revealed: the revealed prefix starts at index 0 exactly
   * like the stored session array, so the boundary rules in
   * buildTradeChartContext (entry context strictly before the entry
   * candle, entry candle flagged, post-entry only to the exit,
   * nothing beyond) are identical. A fetch or validation failure
   * never aborts the package and never invents data: the trade
   * degrades to the standard unavailable reason. Also stamps
   * manifest entries' candleTime from their validated anchor candles
   * (any entry carrying a candle index — representative, entry and
   * exit captures alike). */
  let chartContextCsv: string | null = null;
  const representativeIncluded = manifest.some((e) => e.role === "representative" && e.status === "included");
  const contextRecs = snapshot.trades.filter((r) => r.source === "simulator");
  if (contextRecs.length > 0 && options.includeChartContext !== false) {
    onProgress?.("Building chart context", undefined);
    try {
      const drRecs = contextRecs.filter((r) => r.isDailyReplay);
      const attemptSession = new Map((snapshot.dailyReplay?.attempts ?? []).map((a) => [a.id, a.sessionId]));
      const attemptTimeframe = new Map((snapshot.dailyReplay?.attempts ?? []).map((a) => [a.id, a.timeframe ?? null]));
      const sessionIdFor = (tradeKey: string, attemptId: string | null): string =>
        (attemptId ? attemptSession.get(attemptId) : undefined) ?? tradeKey.slice(0, tradeKey.lastIndexOf(":"));
      const sessionIds = [...new Set(contextRecs.map((r) => sessionIdFor(r.tradeKey, r.attemptId)))];
      const candlesBySession = new Map<string, unknown>();
      if (typeof (client as unknown as { from?: unknown }).from === "function" && sessionIds.length > 0) {
        const { data, error } = await client.from("replay_sessions").select("id, candles").in("id", sessionIds);
        if (error) throw new Error(error.message);
        for (const row of (data ?? []) as unknown as { id: string; candles: unknown }[]) {
          candlesBySession.set(row.id, row.candles);
        }
      }
      // Pre-completion attempts (no session yet): revealed candles.
      const preAttemptIds = [...new Set(drRecs
        .filter((r) => r.attemptId && attemptSession.get(r.attemptId) == null)
        .map((r) => r.attemptId as string))];
      const candlesByAttempt = new Map<string, unknown>();
      if (typeof (client as unknown as { rpc?: unknown }).rpc === "function") {
        for (const attemptId of preAttemptIds) {
          try {
            const { data, error } = await client.rpc("dr_get_revealed", { p_attempt_id: attemptId });
            if (error) throw new Error(error.message);
            const revealed = (data as { candles?: unknown } | null)?.candles;
            if (Array.isArray(revealed)) candlesByAttempt.set(attemptId, revealed);
          } catch { /* degrades to the standard unavailable reason */ }
        }
      }
      const contexts = contextRecs.map((r) => buildTradeChartContext({
        tradeId: r.exportId,
        tradeKey: r.tradeKey,
        symbol: r.symbol,
        attemptId: r.attemptId,
        entryCandleIndex: r.entryCandleIndex,
        exitCandleIndex: r.exitCandleIndex,
        recordedEntryTime: r.entryTime,
        candles: r.attemptId && candlesByAttempt.has(r.attemptId)
          ? candlesByAttempt.get(r.attemptId)
          : candlesBySession.get(sessionIdFor(r.tradeKey, r.attemptId)),
        // §G 2a/2e: the attempt dataset's timeframe (DR only — Trade
        // Lab sessions record none) and the trade's recorded key
        // levels, joined into the context.
        timeframeMinutes: r.attemptId ? (attemptTimeframe.get(r.attemptId) ?? null) : null,
        keyLevels: r.keyLevels.map((k) => ({ price: k.price, type: k.type, interaction: k.interaction })),
      }));
      for (const ctx of contexts) {
        if (!ctx.available) continue;
        const timeByIndex = new Map(ctx.rows.map((row) => [row.candleIndex, row.candleTime]));
        for (const entry of manifest) {
          if (entry.tradeId !== ctx.tradeId || entry.candleIndex == null) continue;
          const t = timeByIndex.get(entry.candleIndex);
          if (t) entry.candleTime = t;
        }
      }
      chartContextCsv = buildChartContextCsv(contexts);
      const summary = summarizeChartContexts(contexts);
      for (const u of summary.unavailable) {
        warnings.push(`Chart context unavailable for ${u.tradeId}: ${u.reason} — the trade is exported without OHLCV context; nothing was invented.`);
      }
      for (const n of summary.notes) warnings.push(`Chart context note — ${n}`);
    } catch (e) {
      chartContextCsv = null;
      warnings.push(`Chart context (chart_context.csv) could not be built (${e instanceof Error ? e.message : "unknown error"}) — the package was produced without it; no OHLCV was invented.`);
    }
  }

  /* ---- text artifacts (all from the same snapshot + final manifest) ---- */
  onProgress?.("Building analytics", undefined);
  const analytics = buildAnalyticsJson(snapshot, manifest, coverage);
  const csv = buildTradesCsv(snapshot, manifest);

  /* ---- PDF (failure is reported, never faked) ---- */
  let pdfBytes: Uint8Array | null = null;
  let pdfFailureNote: string | null = null;
  if (options.includePdf) {
    onProgress?.("Building PDF report", undefined);
    try {
      const { buildTradingReportPdf } = await import("./edgeExportPdf");
      const images: PdfScreenshotImage[] = [];
      // §G 5a selection (cap unchanged at 3): representatives first
      // (manifest order), then round-robin — one further image per
      // trade in manifest order, repeating rounds — so one trade with
      // many attachments can no longer consume the whole allowance.
      const includedEntries = manifest.filter((e) => e.status === "included" && e.file && e.fileName);
      const orderedForPdf: ScreenshotManifestEntry[] = [];
      const seenForPdf = new Set<ScreenshotManifestEntry>();
      for (const e of includedEntries) {
        if (e.role === "representative") { orderedForPdf.push(e); seenForPdf.add(e); }
      }
      const tradeOrder: string[] = [];
      for (const e of includedEntries) if (!tradeOrder.includes(e.tradeId)) tradeOrder.push(e.tradeId);
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const tradeId of tradeOrder) {
          const next = includedEntries.find((e) => e.tradeId === tradeId && !seenForPdf.has(e));
          if (next) { orderedForPdf.push(next); seenForPdf.add(next); progressed = true; }
        }
      }
      for (const entry of orderedForPdf) {
        if (images.length >= 3) break;
        const bytes = shotBytes.get(entry.file!);
        if (!bytes || !entry.fileName) continue;
        const ext = entry.fileName.split(".").pop()?.toLowerCase();
        if (ext === "png") images.push({ tradeId: entry.tradeId, fileName: entry.fileName, bytes, format: "png" });
        else if (ext === "jpg" || ext === "jpeg") images.push({ tradeId: entry.tradeId, fileName: entry.fileName, bytes, format: "jpg" });
      }
      pdfBytes = await buildTradingReportPdf(snapshot, analytics, coverage, images);
    } catch (e) {
      pdfFailureNote = `The visual PDF report could not be generated (${e instanceof Error ? e.message : "unknown error"}). The package was produced WITHOUT Trading_Report.pdf - the CSV, JSON, prompt and README are complete.`;
      warnings.push(pdfFailureNote);
    }
  } else {
    pdfFailureNote = "The visual PDF report was not included (the option was turned off).";
  }
  const pdfIncluded = pdfBytes != null;

  const promptText = buildChatGptPrompt(snapshot, coverage, {
    pdfIncluded,
    timelineIncluded: includeTimeline,
    chartContextIncluded: chartContextCsv != null,
    representativeIncluded,
  });
  const readme = buildReadme(snapshot, coverage, manifest, {
    pdfIncluded, pdfFailureNote, zipFileName,
    timelineIncluded: includeTimeline,
    chartContextIncluded: chartContextCsv != null,
  });
  // Privacy: the downloadable manifest contains ONLY the public
  // projection — raw storage paths (account UUID, internal object ids)
  // and internal trade keys are never serialized into the ZIP.
  const manifestJson = JSON.stringify(
    { generatedAt: snapshot.generatedAt, coverage, entries: manifest.map(publicScreenshotManifestEntry) },
    null, 2,
  );

  /* ---- ZIP assembly ---- */
  onProgress?.("Packaging ZIP", 0);
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("trades.csv", csv);
  zip.file("analytics.json", JSON.stringify(analytics, null, 2));
  if (pdfBytes) zip.file("Trading_Report.pdf", pdfBytes);
  zip.file("ChatGPT_Prompt.txt", promptText);
  zip.file("README.txt", readme);
  zip.file("screenshots-manifest.json", manifestJson);
  if (timelineCsv) zip.file("decision_timeline.csv", timelineCsv);
  if (strategyJson) zip.file("strategy.json", JSON.stringify(strategyJson, null, 2));
  if (chartContextCsv) zip.file("chart_context.csv", chartContextCsv);
  if (options.includeScreenshots) {
    if (shotBytes.size > 0) {
      // Bytes are written at each manifest entry's full package path
      // (screenshots/<file> for real trades, trade_evidence/<trade
      // ID>/<file> for Daily Replay evidence — audit §G 1e), so the
      // ZIP layout and the manifest agree by construction.
      for (const [path, bytes] of shotBytes) zip.file(path, bytes);
    } else {
      const folder = zip.folder("screenshots");
      folder!.file("NO-SCREENSHOTS.txt", `No screenshots were available for the selected trades.\n\n${coverage.note}\n\nNothing was fabricated to fill this folder. See screenshots-manifest.json for the full manifest.\n`);
    }
  }
  const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }, (meta) => {
    onProgress?.("Packaging ZIP", meta.percent);
  });
  const blob = new Blob([new Uint8Array(data)], { type: "application/zip" });

  const filesIncluded = [
    "trades.csv", "analytics.json",
    ...(pdfIncluded ? ["Trading_Report.pdf"] : []),
    "ChatGPT_Prompt.txt", "README.txt", "screenshots-manifest.json",
    ...(timelineCsv ? ["decision_timeline.csv"] : []),
    ...(strategyJson ? ["strategy.json"] : []),
    ...(chartContextCsv ? ["chart_context.csv"] : []),
    ...(shotBytes.size > 0 ? [...shotBytes.keys()] : []),
  ];

  return {
    blob,
    fileName: zipFileName,
    promptText,
    manifest,
    warnings,
    summary: {
      fileName: zipFileName,
      filesIncluded,
      tradeCount: snapshot.counts.total,
      closedCount: snapshot.counts.closed,
      screenshotFiles: shotBytes.size,
      pdfIncluded,
      warnings,
    },
  };
}
