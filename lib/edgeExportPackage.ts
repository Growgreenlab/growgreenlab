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
  buildAnalyticsJson, buildChatGptPrompt, buildReadme, buildScreenshotManifest,
  buildTradesCsv, publicScreenshotManifestEntry, summarizeScreenshotCoverage,
  type ExportSnapshot, type ScreenshotManifestEntry,
} from "./edgeExport";
import type { PdfScreenshotImage } from "./edgeExportPdf";

export type ExportProgressFn = (stage: string, pct?: number) => void;

export interface GeneratePackageOptions {
  includeScreenshots: boolean;
  includePdf: boolean;
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
 * List screenshot storage paths for every real trade in the snapshot
 * (bounded concurrency). Returns tradeKey → storage paths. Listing uses
 * the caller's own session; storage policies restrict it to the user's
 * own folder, so another user's screenshots can never be listed.
 */
export async function listExportScreenshots(
  client: SupabaseClient,
  userId: string,
  snapshot: ExportSnapshot,
  onProgress?: ExportProgressFn,
): Promise<Map<string, string[]>> {
  const realKeys = snapshot.trades.filter((r) => r.source === "real").map((r) => r.tradeKey);
  const out = new Map<string, string[]>();
  let done = 0;
  await mapPool(realKeys, 4, async (tradeKey) => {
    const list = await listScreenshots(client, userId, tradeKey);
    out.set(tradeKey, list.map((s) => s.path));
    done++;
    onProgress?.(`Checking screenshots (${done}/${realKeys.length})`, realKeys.length ? (done / realKeys.length) * 100 : 100);
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
    manifest = buildScreenshotManifest(snapshot, listed);
    if (manifest.length > 0) {
      let done = 0;
      await mapPool(manifest, 4, async (entry) => {
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
        onProgress?.(`Downloading screenshots (${done}/${manifest.length})`, (done / manifest.length) * 100);
      });
    }
  }
  const coverage = summarizeScreenshotCoverage(snapshot, manifest, options.includeScreenshots);

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
      for (const entry of manifest) {
        if (entry.status !== "included" || !entry.file || images.length >= 3) continue;
        const bytes = shotBytes.get(entry.file);
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

  const promptText = buildChatGptPrompt(snapshot, coverage, { pdfIncluded });
  const readme = buildReadme(snapshot, coverage, manifest, { pdfIncluded, pdfFailureNote, zipFileName });
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
  if (options.includeScreenshots) {
    const folder = zip.folder("screenshots");
    if (shotBytes.size > 0) {
      for (const [path, bytes] of shotBytes) folder!.file(path.split("/").pop()!, bytes);
    } else {
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
