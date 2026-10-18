/**
 * edgeExportPackage.test.ts — ZIP-integrity test for the AI Edge
 * Analysis Export package generator. Run: npx tsx lib/edgeExportPackage.test.ts
 *
 * Builds a small snapshot (real trade with partial exits + original plan
 * + one screenshot, a real trade without screenshots, a simulator trade),
 * generates the FULL package against a FAKE Supabase client whose storage
 * implements list / createSignedUrls / download (the exact surface
 * lib/journalAttachments.ts + the package use), then REOPENS the ZIP and
 * verifies every artifact: structure, JSON parse + counts, CSV parse +
 * stable IDs vs manifest, PDF magic bytes + pdf-lib load, and a
 * two-direction screenshot-file <-> manifest cross-check.
 */
import { calcRealTrade, groupFillsIntoTrades, type GroupedTrade, type RawFill, type RealFill } from "./journal";
import {
  buildExportSnapshot, type ExportMetaInput, type ExportRealTradeInput,
  type ExportSnapshotInput, type ExportUnifiedInput,
} from "./edgeExport";
import { generateEdgePackage } from "./edgeExportPackage";
import { deriveDrEvidence } from "./drTradeEvidence";
import type { DrEvent } from "./dailyReplayEvents";
import JSZip from "jszip";
import { inflateSync } from "node:zlib";

/** Extract searchable text from a pdf-lib-generated PDF: inflate the
 *  FlateDecode content streams, then decode the hex-string Tj operands
 *  pdf-lib writes for every drawText call (one operand per drawn
 *  string, so single-call strings stay contiguous). */
function extractPdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let all = raw;
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    try { all += "\n" + inflateSync(Buffer.from(raw.slice(start, end), "latin1")).toString("latin1"); } catch { /* not a flate stream */ }
  }
  const decoded: string[] = [];
  const hexRe = /<([0-9A-Fa-f]{4,})>\s*Tj/g;
  let h: RegExpExecArray | null;
  while ((h = hexRe.exec(all)) !== null) {
    decoded.push(Buffer.from(h[1], "hex").toString("latin1"));
  }
  return all + "\n" + decoded.join("\n");
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  const s = text.replace(/\r\n/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/* ---------------- fixtures ---------------- */
const R1_ID = "11111111-1111-1111-1111-111111111111";
const R2_ID = "22222222-2222-2222-2222-222222222222";
const S1_SESSION = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER = "user-00000000-0000-0000-0000-000000000001";
const SHOT_NAME = "0f5d2c10-0000-4000-8000-00000000000a-entry.png";
const SHOT_PATH = `${USER}/real_${R1_ID}/${SHOT_NAME}`;
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

const r1Fills: RealFill[] = [
  { id: "a1", side: "buy", qty: 100, price: 2.00, fees: 0.50, fill_time: "2026-10-13T13:45:00.000Z" },
  { id: "a2", side: "sell", qty: 40, price: 2.50, fees: 0.20, fill_time: "2026-10-13T14:15:00.000Z" },
  { id: "a3", side: "sell", qty: 60, price: 2.40, fees: 0.30, fill_time: "2026-10-13T14:30:00.000Z" },
];
const r1Meta: ExportMetaInput = {
  trade_key: `real:${R1_ID}`, setup_tag: "HOD breakout", hod_class: "clean", exec_grade: "B",
  entry_reasoning: null, exit_reasoning: null, followed_plan: true, confidence: 4,
  emotional_tags: [], mistakes: [], notes: null, lessons: null, would_take_again: null,
  key_levels: [{ price: 2.60, type: "Resistance", interaction: "Resistance rejection", notes: null }],
  original_stop_loss: 1.90, original_target: 2.60,
  plan_history: [{ at: "2026-10-13T15:00:00.000Z", field: "stop_loss", from: 1.90, to: 1.85 }],
};
const r1Calc = calcRealTrade(r1Fills, "long", 1.90, 2.60);
const r1: ExportRealTradeInput = {
  id: R1_ID, ticker: "TEST", trade_date: "2026-10-13", direction: "long", strategy: null,
  status: "closed", stop_loss: 1.85, target: 2.60, float_shares: null, relative_volume: null,
  market_conditions: null, fills: r1Fills, calc: r1Calc,
};
const r2Fills: RealFill[] = [
  { id: "b1", side: "buy", qty: 100, price: 3.00, fees: 0, fill_time: "2026-10-12T13:45:00.000Z" },
  { id: "b2", side: "sell", qty: 100, price: 3.30, fees: 0, fill_time: "2026-10-12T15:00:00.000Z" },
];
const r2: ExportRealTradeInput = {
  id: R2_ID, ticker: "MNDR", trade_date: "2026-10-12", direction: "long", strategy: null,
  status: "closed", stop_loss: null, target: null, float_shares: null, relative_volume: null,
  market_conditions: null, fills: r2Fills, calc: calcRealTrade(r2Fills, "long", null, null),
};
function sf(id: string, side: "buy" | "sell", qty: number, price: number, idx: number, pnl: number, t: string): RawFill {
  return { id, session_id: S1_SESSION, side, qty, price, candle_index: idx, candle_time: t, realized_pnl: pnl, created_at: t };
}
const s1: GroupedTrade = groupFillsIntoTrades([
  sf("c1", "buy", 100, 5.00, 0, 0, "2026-10-13T13:35:00.000Z"),
  sf("c2", "sell", 100, 5.50, 4, 50, "2026-10-13T13:40:00.000Z"),
], { id: S1_SESSION, ticker: "SIMX", trade_date: "2026-10-13", source: "sample" })[0];

const realU = (rt: ExportRealTradeInput): ExportUnifiedInput => ({
  key: `real:${rt.id}`, source: "real", ticker: rt.ticker, tradeDate: rt.trade_date, direction: rt.direction,
  entryPrice: rt.calc.avgEntry, exitPrice: null, qty: rt.calc.entryQty, realizedPnl: rt.calc.netRealized,
  isOpen: !rt.calc.isClosed, rMultiple: rt.calc.rMultiple,
});
const input: ExportSnapshotInput = {
  unified: [realU(r1), realU(r2), {
    key: s1.tradeKey, source: "simulator", ticker: s1.ticker, tradeDate: s1.tradeDate, direction: s1.direction,
    entryPrice: s1.entryPrice, exitPrice: s1.exitPrice, qty: s1.qty, realizedPnl: s1.realizedPnl, isOpen: false, rMultiple: s1.rMultiple,
  }],
  metas: { [`real:${R1_ID}`]: r1Meta },
  realTrades: [r1, r2],
  simTrades: [s1],
};
const snapshot = buildExportSnapshot(input, { range: { start: "2026-10-01", end: "2026-10-31" }, mode: "custom", source: "all" });

/* ---------------- fake supabase storage client ---------------- */
const fakeClient = {
  storage: {
    from: (_bucket: string) => ({
      list: async (prefix: string) => {
        if (prefix === `${USER}/real_${R1_ID}`) {
          return { data: [{ name: SHOT_NAME, id: "obj-1", created_at: "2026-10-13T14:00:00.000Z" }], error: null };
        }
        return { data: [], error: null };
      },
      createSignedUrls: async (paths: string[]) => ({
        data: paths.map((p) => ({ path: p, signedUrl: `https://signed.example/${p}`, error: null })),
        error: null,
      }),
      download: async (path: string) => {
        if (path === SHOT_PATH) return { data: new Blob([new Uint8Array(FAKE_PNG)]), error: null };
        return { data: null, error: { message: "Object not found" } };
      },
    }),
  },
} as any;

/* ---- fixtures: privacy + consistency package (Issues 1-4) ----
 * RW: real win, gross +50 with $1 recorded fees -> net +49, WITH a
 * screenshot stored under a FAKE ACCOUNT UUID path (privacy probe).
 * RL: real loss -20 (2026-10-12). SW: simulator win +50 (fee-free).
 * Chronology: RL -20 -> SW +50 -> RW +49; per-trade max drawdown $20.
 * Overall: grossProfit 99 (49 net real + 50 fee-free sim), grossLoss 20,
 * net 79. */
const FAKE_ACCT = "123e4567-e89b-12d3-a456-426614174000";
const RW_ID = "44444444-4444-4444-4444-444444444444";
const RL_ID = "55555555-5555-5555-5555-555555555555";
const SW_SESSION = "99999999-9999-9999-9999-999999999999";
const OBJ_NAME = "cafef00d-0000-4000-8000-0000000000ff-chart.png";
const RW_PATH = `${FAKE_ACCT}/real_${RW_ID}/${OBJ_NAME}`;
const rwFills: RealFill[] = [
  { id: "w1", side: "buy", qty: 100, price: 2.00, fees: 0.50, fill_time: "2026-10-13T13:45:00.000Z" },
  { id: "w2", side: "sell", qty: 100, price: 2.50, fees: 0.50, fill_time: "2026-10-13T14:15:00.000Z" },
];
const rlFills: RealFill[] = [
  { id: "l1", side: "buy", qty: 100, price: 3.00, fees: 0, fill_time: "2026-10-12T13:45:00.000Z" },
  { id: "l2", side: "sell", qty: 100, price: 2.80, fees: 0, fill_time: "2026-10-12T15:00:00.000Z" },
];
const rwTrade: ExportRealTradeInput = {
  id: RW_ID, ticker: "PRIV", trade_date: "2026-10-13", direction: "long", strategy: null,
  status: "closed", stop_loss: null, target: null, float_shares: null, relative_volume: null,
  market_conditions: null, fills: rwFills, calc: calcRealTrade(rwFills, "long", null, null),
};
const rlTrade: ExportRealTradeInput = {
  id: RL_ID, ticker: "LOSS", trade_date: "2026-10-12", direction: "long", strategy: null,
  status: "closed", stop_loss: null, target: null, float_shares: null, relative_volume: null,
  market_conditions: null, fills: rlFills, calc: calcRealTrade(rlFills, "long", null, null),
};
const swTrade: GroupedTrade = groupFillsIntoTrades([
  sf("d1", "buy", 100, 5.00, 0, 0, "2026-10-13T13:35:00.000Z"),
  sf("d2", "sell", 100, 5.50, 4, 50, "2026-10-13T13:40:00.000Z"),
], { id: SW_SESSION, ticker: "SIMW", trade_date: "2026-10-13", source: "sample" })[0];
const privInput: ExportSnapshotInput = {
  unified: [realU(rwTrade), realU(rlTrade), {
    key: swTrade.tradeKey.replace(S1_SESSION, SW_SESSION), source: "simulator", ticker: swTrade.ticker, tradeDate: swTrade.tradeDate,
    direction: swTrade.direction, entryPrice: swTrade.entryPrice, exitPrice: swTrade.exitPrice, qty: swTrade.qty,
    realizedPnl: swTrade.realizedPnl, isOpen: false, rMultiple: swTrade.rMultiple,
  }],
  metas: {},
  realTrades: [rwTrade, rlTrade],
  simTrades: [{ ...swTrade, tradeKey: swTrade.tradeKey.replace(S1_SESSION, SW_SESSION) }],
};
const privSnapshot = buildExportSnapshot(privInput, { range: { start: "2026-10-01", end: "2026-10-31" }, mode: "custom", source: "all" });
const privClient = {
  storage: {
    from: (_bucket: string) => ({
      list: async (prefix: string) => prefix === `${FAKE_ACCT}/real_${RW_ID}`
        ? { data: [{ name: OBJ_NAME, id: "obj-9", created_at: "2026-10-13T14:00:00.000Z" }], error: null }
        : { data: [], error: null },
      createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: "https://signed.example/x", error: null })), error: null }),
      download: async (path: string) => path === RW_PATH
        ? { data: new Blob([new Uint8Array(FAKE_PNG)]), error: null }
        : { data: null, error: { message: "Object not found" } },
    }),
  },
} as any;

async function main() {
  const result = await generateEdgePackage(fakeClient, USER, snapshot, { includeScreenshots: true, includePdf: true });
  check("package file name", result.fileName === "growgreen-ai-edge-2026-10-31.zip");
  check("summary pdf included", result.summary.pdfIncluded === true);
  check("summary screenshot files = 1", result.summary.screenshotFiles === 1);

  const zip = await JSZip.loadAsync(new Uint8Array(await result.blob.arrayBuffer()));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  for (const expected of ["trades.csv", "analytics.json", "Trading_Report.pdf", "ChatGPT_Prompt.txt", "README.txt", "screenshots-manifest.json"]) {
    check(`zip contains ${expected}`, names.includes(expected));
  }
  const shotZipPath = `screenshots/TRADE-${R1_ID}-shot-1.png`;
  check("zip contains screenshot under stable name", names.includes(shotZipPath));
  const shotBytes = await zip.file(shotZipPath)!.async("uint8array");
  check("screenshot bytes round-trip exactly", shotBytes.length === FAKE_PNG.length && shotBytes.every((b, i) => b === FAKE_PNG[i]));

  // analytics.json parses + counts + manifest agreement
  const analytics = JSON.parse(await zip.file("analytics.json")!.async("string"));
  check("analytics counts match snapshot", analytics.metadata.counts.total === 3 && analytics.metadata.counts.closed === 3);
  check("analytics manifest has the screenshot", (analytics.metadata.screenshotManifest as any[]).length === 1 && analytics.metadata.screenshotManifest[0].status === "included");
  check("analytics tradesIndex references screenshot", (analytics.tradesIndex as any[]).find((t) => t.tradeId === `TRADE-${R1_ID}`)?.screenshots?.[0] === `TRADE-${R1_ID}-shot-1.png`);

  // standalone manifest parses and agrees
  const manifestDoc = JSON.parse(await zip.file("screenshots-manifest.json")!.async("string"));
  check("manifest doc entries = 1", manifestDoc.entries.length === 1 && manifestDoc.entries[0].file === shotZipPath);

  // CSV parses; stable IDs in CSV == trade IDs known to manifest/index
  const csvRows = parseCsv(await zip.file("trades.csv")!.async("string"));
  check("csv rows = header + 3", csvRows.length === 4);
  const csvIds = csvRows.slice(1).map((r) => r[0]).sort();
  const indexIds = (analytics.tradesIndex as any[]).map((t) => t.tradeId).sort();
  check("csv ids == analytics tradesIndex ids", JSON.stringify(csvIds) === JSON.stringify(indexIds));
  check("manifest trade id is one of the csv ids", csvIds.includes(manifestDoc.entries[0].tradeId));

  // two-direction cross-check: every screenshots/ file has a manifest entry; every included entry has a file
  const zipShots = names.filter((n) => n.startsWith("screenshots/"));
  const manifestIncluded = (manifestDoc.entries as any[]).filter((e) => e.status === "included").map((e) => e.file);
  check("every zip screenshot has a manifest entry", zipShots.every((f) => manifestIncluded.includes(f)));
  check("every included manifest entry has a zip file", manifestIncluded.every((f) => zipShots.includes(f)));

  // PDF validity: magic bytes + pdf-lib can load it + page count >= 2
  const pdfBytes = await zip.file("Trading_Report.pdf")!.async("uint8array");
  check("pdf starts with %PDF", new TextDecoder().decode(pdfBytes.slice(0, 4)) === "%PDF");
  const { PDFDocument } = await import("pdf-lib");
  const pdfDoc = await PDFDocument.load(pdfBytes);
  check("pdf loads and has >= 2 pages", pdfDoc.getPageCount() >= 2);

  // README + prompt consistency
  const readme = await zip.file("README.txt")!.async("string");
  check("readme lists Trading_Report.pdf", readme.includes("Trading_Report.pdf"));
  check("readme has privacy warning", readme.includes("PRIVACY WARNING"));
  check("prompt mentions the package range", result.promptText.includes("2026-10-01 to 2026-10-31"));
  check("prompt carries rules + sections", result.promptText.includes("15. Explain what additional evidence") && result.promptText.includes("K. Data limitations and confidence assessment"));

  /* ---- variant: screenshots OFF ---- */
  const noShots = await generateEdgePackage(fakeClient, USER, snapshot, { includeScreenshots: false, includePdf: true });
  const zip2 = await JSZip.loadAsync(new Uint8Array(await noShots.blob.arrayBuffer()));
  const names2 = Object.keys(zip2.files).filter((n) => !zip2.files[n].dir);
  check("screenshots off: no screenshots/ files", !names2.some((n) => n.startsWith("screenshots/")));
  const manifest2 = JSON.parse(await zip2.file("screenshots-manifest.json")!.async("string"));
  check("screenshots off: manifest empty + coverage note", manifest2.entries.length === 0 && String(manifest2.coverage.note).includes("turned off"));

  /* ---- variant: PDF OFF ---- */
  const noPdf = await generateEdgePackage(fakeClient, USER, snapshot, { includeScreenshots: true, includePdf: false });
  const zip3 = await JSZip.loadAsync(new Uint8Array(await noPdf.blob.arrayBuffer()));
  const names3 = Object.keys(zip3.files).filter((n) => !zip3.files[n].dir);
  check("pdf off: no Trading_Report.pdf in zip", !names3.includes("Trading_Report.pdf"));
  const readme3 = await zip3.file("README.txt")!.async("string");
  check("pdf off: README does not claim the PDF", !readme3.includes("- Trading_Report.pdf\n") && readme3.includes("not included"));
  check("pdf off: summary agrees", noPdf.summary.pdfIncluded === false);

  /* ---- variant: download failure -> unavailable, package still built ---- */
  const failingClient = {
    storage: {
      from: (_bucket: string) => ({
        list: async (prefix: string) => prefix === `${USER}/real_${R1_ID}`
          ? { data: [{ name: SHOT_NAME, id: "obj-1", created_at: "2026-10-13T14:00:00.000Z" }], error: null }
          : { data: [], error: null },
        createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: "https://signed.example/x", error: null })), error: null }),
        download: async () => ({ data: null, error: { message: "boom" } }),
      }),
    },
  } as any;
  const failedDl = await generateEdgePackage(failingClient, USER, snapshot, { includeScreenshots: true, includePdf: false });
  check("failed download: entry marked unavailable", failedDl.manifest.length === 1 && failedDl.manifest[0].status === "unavailable");
  check("failed download: warning surfaced", failedDl.warnings.some((w) => w.includes("could not be downloaded")));
  const zip4 = await JSZip.loadAsync(new Uint8Array(await failedDl.blob.arrayBuffer()));
  const names4 = Object.keys(zip4.files).filter((n) => !zip4.files[n].dir);
  check("failed download: NO-SCREENSHOTS note file present", names4.includes("screenshots/NO-SCREENSHOTS.txt"));

  /* ---- privacy + consistency package (Issues 1-4 regression) ---- */
  {
    const res = await generateEdgePackage(privClient, FAKE_ACCT, privSnapshot, { includeScreenshots: true, includePdf: true });
    check("priv: generation produced a ZIP", !!res.blob && res.summary.pdfIncluded);
    const zip = await JSZip.loadAsync(new Uint8Array(await res.blob.arrayBuffer()));
    const names = Object.keys(zip.files);
    const shotPath = `screenshots/TRADE-${RW_ID}-shot-1.png`;

    // Screenshot bytes still exported under the stable package name.
    const shotFile = zip.file(shotPath);
    check("priv: screenshot present under stable name", !!shotFile);
    const privShotBytes = shotFile ? await shotFile.async("uint8array") : new Uint8Array(0);
    check("priv: screenshot bytes intact", privShotBytes.length === FAKE_PNG.length && privShotBytes.every((b, i) => b === FAKE_PNG[i]));

    // NO artifact may contain the account UUID, the internal object
    // name, any storage path, or a storagePath key.
    const csvT = await zip.file("trades.csv")!.async("string");
    const analyticsT = await zip.file("analytics.json")!.async("string");
    const manifestT = await zip.file("screenshots-manifest.json")!.async("string");
    const readmeT = await zip.file("README.txt")!.async("string");
    const promptT = await zip.file("ChatGPT_Prompt.txt")!.async("string");
    const pdfBytes = await zip.file("Trading_Report.pdf")!.async("uint8array");
    const pdfT = extractPdfText(pdfBytes);
    const artifacts: Record<string, string> = { csv: csvT, analytics: analyticsT, manifest: manifestT, readme: readmeT, prompt: promptT, pdf: pdfT };
    for (const [label, text] of Object.entries(artifacts)) {
      check(`priv: no account UUID in ${label}`, !text.includes(FAKE_ACCT));
      check(`priv: no internal object name in ${label}`, !text.includes("cafef00d"));
      check(`priv: no storagePath key in ${label}`, !text.includes("storagePath"));
      check(`priv: no bucket path segment in ${label}`, !text.includes(`real_${RW_ID}/`));
    }

    // Manifest still maps stable trade ID <-> package file <-> status.
    const manifestDoc = JSON.parse(manifestT) as any;
    const entry = (manifestDoc.entries as any[]).find((e) => e.tradeId === `TRADE-${RW_ID}`);
    check("priv: manifest entry maps id/file/status", !!entry && entry.file === shotPath && entry.status === "included" && entry.symbol === "PRIV" && entry.type === "trade-screenshot");
    // Deliberate update (Representative plan §5 S1.2): the public set
    // gains role / representativeSource / candleIndex / candleTime —
    // still NO storagePath, tradeKey or account identifiers.
    check("priv: manifest entry keys are exactly the public set", !!entry && JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(["candleIndex", "candleTime", "capturedAt", "file", "fileName", "representativeSource", "role", "status", "symbol", "tradeId", "type"]));

    // Analytics: gross values on the documented net basis + definitions.
    const analytics = JSON.parse(analyticsT) as any;
    check("gross: overall grossProfit = 99 (49 net real + 50 fee-free sim)", Math.abs(analytics.overall.grossProfit - 99) < 1e-6);
    check("gross: overall grossLoss = 20", Math.abs(analytics.overall.grossLoss - 20) < 1e-6);
    check("gross: overall net = 79", Math.abs(analytics.overall.netRealizedPnl - 79) < 1e-6);
    check("gross: definition present in JSON", String(analytics.metadata.calculationDefinitions.grossProfit).includes("fee-free") && String(analytics.metadata.calculationDefinitions.grossProfit).includes("NOT a pre-fee figure"));
    check("gross: README carries the definition", readmeT.includes("- grossProfit:") && readmeT.includes("NOT a pre-fee figure"));
    check("gross: perSource note carries fee basis", String(analytics.perSource.note).includes("fee-free"));

    // Rounding transparency in all three artifacts.
    check("rounding: note in JSON metadata", typeof analytics.metadata.rounding === "string" && analytics.metadata.rounding.includes("cent"));
    check("rounding: note in README", readmeT.includes("ROUNDING & RECONCILIATION"));
    check("rounding: note in PDF text", pdfT.includes("Rounding & reconciliation"));

    // PDF: gross figures + drawdown chart trough == headline ($20).
    check("pdf: stats table shows gross pair $99.00 / $20.00", pdfT.includes("$99.00 / $20.00"));
    check("pdf: gross footnote present", pdfT.includes("NOT before fees") && pdfT.includes("fee-free"));
    check("pdf: drawdown chart titled per-trade", pdfT.includes("per trade"));
    check("pdf: drawdown chart min label == -headline (-$20.00)", pdfT.includes("min -$20.00"));
    check("pdf: headline maximum drawdown $20.00 present", pdfT.includes("$20.00"));
  }

  /* ---- schema 2.0: Daily Replay package contents ---- */
  {
    const DR_SESSION = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const ATT = "a1111111-1111-4111-8111-111111111111";
    const drTrade: GroupedTrade = groupFillsIntoTrades([
      sf("x1", "buy", 100, 10.00, 5, 0, "2026-10-15T13:35:00.000Z"),
      sf("x2", "sell", 100, 11.00, 9, 100, "2026-10-15T13:39:00.000Z"),
    ], { id: DR_SESSION, ticker: "DRCO", trade_date: "2026-10-15", source: "daily_replay" })[0];
    // groupFillsIntoTrades' sf helper hardcodes S1_SESSION above; rebuild key:
    const drGrouped: GroupedTrade = { ...drTrade, tradeKey: `${DR_SESSION}:1`, sessionId: DR_SESSION, fills: drTrade.fills.map((f) => ({ ...f, session_id: DR_SESSION })) };
    const drEvents: DrEvent[] = [
      { seq: 1, type: "order_filled", wallTs: 1760600000000, marketIdx: 5, marketTs: 1760544300000, payload: { side: "buy", qty: 100, price: 10, candleIndex: 5 } },
      { seq: 2, type: "risk_snapshot", wallTs: 1760600001000, marketIdx: 5, marketTs: 1760544300000, payload: { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 } },
      { seq: 3, type: "order_filled", wallTs: 1760600100000, marketIdx: 9, marketTs: 1760544540000, payload: { side: "sell", qty: 100, price: 11, candleIndex: 9 } },
      { seq: 4, type: "position_closed", wallTs: 1760600100000, marketIdx: 9, marketTs: 1760544540000, payload: { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "target", unrealizedPnl: 0 } },
    ];
    const derived = deriveDrEvidence({ attemptId: ATT, trades: [drGrouped], events: drEvents });
    const drInput: ExportSnapshotInput = {
      unified: [{
        key: drGrouped.tradeKey, source: "simulator", ticker: "DRCO", tradeDate: "2026-10-15",
        direction: "long", entryPrice: 10, exitPrice: 11, qty: 100, realizedPnl: 100, isOpen: false,
        rMultiple: derived.byTradeKey.get(drGrouped.tradeKey)?.rMultiple ?? null,
        sessionSource: "daily_replay", attemptId: ATT,
      }],
      metas: {},
      realTrades: [],
      simTrades: [drGrouped],
      drAttempts: [{ id: ATT, sessionId: DR_SESSION, strategyVersionId: null, status: "finished", startIndex: 4, createdAt: "2026-10-16T16:00:00Z", finishedAt: "2026-10-16T16:30:00Z", ticker: "DRCO", tradeDate: "2026-10-15" }],
      drEvidence: derived.byTradeKey,
      drEvents: drEvents.map((event, i) => ({ id: `ev-${i + 1}`, attemptId: ATT, event })),
      drEventTradeKeys: new Map([[ATT, derived.eventTradeKey]]),
      strategies: [], strategyVersions: [],
    };
    const drSnap = buildExportSnapshot(drInput, { range: { start: "2026-10-01", end: "2026-10-31" }, mode: "custom", source: "daily_replay" });
    const DR_SHOT = "dr-shot.png";
    const drClient = {
      storage: {
        from: (_bucket: string) => ({
          list: async (prefix: string) => prefix === `${USER}/${DR_SESSION}_1`
            ? { data: [{ name: DR_SHOT, id: "obj-dr", created_at: "2026-10-16T16:10:00.000Z" }], error: null }
            : { data: [], error: null },
          createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: "https://signed.example/y", error: null })), error: null }),
          download: async (path: string) => path === `${USER}/${DR_SESSION}_1/${DR_SHOT}`
            ? { data: new Blob([new Uint8Array(FAKE_PNG)]), error: null }
            : { data: null, error: { message: "Object not found" } },
        }),
      },
    } as any;
    const res = await generateEdgePackage(drClient, USER, drSnap, { includeScreenshots: true, includePdf: false });
    check("2.0 pkg: filesIncluded lists decision_timeline.csv + strategy.json",
      res.summary.filesIncluded.includes("decision_timeline.csv") && res.summary.filesIncluded.includes("strategy.json"));
    const zip = await JSZip.loadAsync(new Uint8Array(await res.blob.arrayBuffer()));
    check("2.0 pkg: ZIP contains decision_timeline.csv", !!zip.file("decision_timeline.csv"));
    check("2.0 pkg: ZIP contains strategy.json", !!zip.file("strategy.json"));
    const tlText = await zip.file("decision_timeline.csv")!.async("string");
    check("2.0 pkg: timeline names the attempt + trade", tlText.includes(ATT) && tlText.includes("risk_snapshot"));
    const sjText = await zip.file("strategy.json")!.async("string");
    check("2.0 pkg: strategy.json notes unbound attempt", sjText.includes(ATT));
    check("2.0 pkg: DR screenshot bytes included", res.summary.screenshotFiles === 1 && !!zip.file(`screenshots/${res.manifest[0]?.fileName}`));
    check("2.0 pkg: manifest marks DR screenshot included", res.manifest.length === 1 && res.manifest[0].status === "included");
    const noTl = await generateEdgePackage(drClient, USER, drSnap, { includeScreenshots: true, includePdf: false, includeDecisionTimeline: false });
    const zip2 = await JSZip.loadAsync(new Uint8Array(await noTl.blob.arrayBuffer()));
    check("2.0 pkg: timeline toggle off omits the file but keeps strategy.json",
      !zip2.file("decision_timeline.csv") && !!zip2.file("strategy.json"));
    check("2.0 pkg: prompt does not list an omitted timeline", !noTl.promptText.includes("decision_timeline.csv - the"));
  }

  /* ---- Phase D/E: listExportScreenshots draft-prefix union ---- */
  {
    const { listExportScreenshots } = await import("./edgeExportPackage");
    const PKG_SESSION = "66666666-6666-4666-8666-666666666666";
    const PKG_TL_SESSION = "77777777-7777-4777-8777-777777777777";
    const PKG_ATT = "c1111111-1111-4111-8111-111111111111";
    const drKey = `${PKG_SESSION}:1`;
    const tlKey = `${PKG_TL_SESSION}:1`;
    const draftKey = `dr:${PKG_ATT}:g0:c1`;
    const canonPrefix = `${USER}/${PKG_SESSION}_1`;
    const draftPrefix = `${USER}/dr_${PKG_ATT}_g0_c1`;
    const tlPrefix = `${USER}/${PKG_TL_SESSION}_1`;
    const pkgInput: ExportSnapshotInput = {
      unified: [
        {
          key: drKey, source: "simulator", ticker: "DRPKG", tradeDate: "2026-10-15",
          direction: "long", entryPrice: 10, exitPrice: 11, qty: 100, realizedPnl: 100,
          isOpen: false, rMultiple: 2, sessionSource: "daily_replay", attemptId: PKG_ATT,
        },
        {
          key: tlKey, source: "simulator", ticker: "TLPKG", tradeDate: "2026-10-15",
          direction: "long", entryPrice: 5, exitPrice: 5.5, qty: 100, realizedPnl: 50,
          isOpen: false, rMultiple: null, sessionSource: "sample", attemptId: null,
        },
      ],
      metas: {},
      realTrades: [],
      simTrades: [],
      drAttempts: [{ id: PKG_ATT, sessionId: PKG_SESSION, strategyVersionId: null, status: "finished", startIndex: 4, createdAt: "2026-10-16T16:00:00Z", finishedAt: "2026-10-16T16:30:00Z", ticker: "DRPKG", tradeDate: "2026-10-15" }],
      drEvidence: new Map(),
      drEvents: [],
      drEventTradeKeys: new Map(),
      strategies: [], strategyVersions: [],
      drDraftKeys: new Map([[drKey, { draftKey, autoCapture: {} }]]),
    };
    const pkgSnap = buildExportSnapshot(pkgInput, { range: { start: "2026-10-01", end: "2026-10-31" }, mode: "custom", source: "all" });
    check("phaseDE pkg: snapshot carries the draft-key mapping",
      pkgSnap.dailyReplay?.draftInfoByTradeKey.get(drKey)?.draftKey === draftKey);

    const recorded: string[] = [];
    const unionClient = {
      storage: {
        from: (_bucket: string) => ({
          list: async (prefix: string) => {
            recorded.push(prefix);
            if (prefix === canonPrefix) return { data: [{ name: "canon.png", id: "obj-c", created_at: "2026-10-16T16:05:00.000Z" }, { name: "canon.png", id: "obj-c-dup", created_at: "2026-10-16T16:05:00.000Z" }], error: null };
            if (prefix === draftPrefix) return { data: [{ name: "auto-entry-c5.png", id: "obj-d", created_at: "2026-10-16T16:06:00.000Z" }], error: null };
            return { data: [], error: null };
          },
          createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: "https://signed.example/z", error: null })), error: null }),
          download: async () => ({ data: null, error: { message: "not used in this test" } }),
        }),
      },
    } as any;
    const listedMap = await listExportScreenshots(unionClient, USER, pkgSnap);
    const drPaths = listedMap.get(drKey) ?? [];
    check("phaseDE pkg: DR trade lists BOTH canonical and draft prefixes",
      recorded.includes(canonPrefix) && recorded.includes(draftPrefix));
    check("phaseDE pkg: DR paths include objects from both prefixes",
      drPaths.includes(`${canonPrefix}/canon.png`) && drPaths.includes(`${draftPrefix}/auto-entry-c5.png`) && drPaths.length === 2);
    check("phaseDE pkg: DR paths deduped by path", new Set(drPaths).size === drPaths.length);
    check("phaseDE pkg: Trade Lab sim trade still lists nothing",
      !recorded.includes(tlPrefix) && !listedMap.has(tlKey));
  }

  /* ---- Representative plan §6.2: one image per DR trade, end to end ---- */
  {
    const PSESS = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const PATT = "c3333333-3333-4333-8333-333333333333";
    const PDRAFT = `dr:${PATT}:g0:c1`;
    const PDSEG = `dr_${PATT}_g0_c1`;
    const pTrade0: GroupedTrade = groupFillsIntoTrades([
      sf("y1", "buy", 100, 10.00, 5, 0, "2026-10-15T13:35:00.000Z"),
      sf("y2", "sell", 100, 11.00, 9, 100, "2026-10-15T13:39:00.000Z"),
    ], { id: PSESS, ticker: "PKGR", trade_date: "2026-10-15", source: "daily_replay" })[0];
    const pGrouped: GroupedTrade = { ...pTrade0, tradeKey: `${PSESS}:1`, sessionId: PSESS, fills: pTrade0.fills.map((f) => ({ ...f, session_id: PSESS })) };
    const pEvents: DrEvent[] = [
      { seq: 1, type: "order_filled", wallTs: 1760600000000, marketIdx: 5, marketTs: 1760544300000, payload: { side: "buy", qty: 100, price: 10, candleIndex: 5 } },
      { seq: 2, type: "risk_snapshot", wallTs: 1760600001000, marketIdx: 5, marketTs: 1760544300000, payload: { entry: 10, qty: 100, stopLoss: 9.5, takeProfit: 11, plannedRisk: 50, rewardRisk: 2 } },
      { seq: 3, type: "order_filled", wallTs: 1760600100000, marketIdx: 9, marketTs: 1760544540000, payload: { side: "sell", qty: 100, price: 11, candleIndex: 9 } },
      { seq: 4, type: "position_closed", wallTs: 1760600100000, marketIdx: 9, marketTs: 1760544540000, payload: { qty: 100, price: 11, realizedPnl: 100, sessionRealized: 100, reason: "target", unrealizedPnl: 0 } },
    ];
    const pDerived = deriveDrEvidence({ attemptId: PATT, trades: [pGrouped], events: pEvents });
    const P_ENTRY = `${USER}/${PDSEG}/auto-entry-c6.png`;
    const P_EXIT = `${USER}/${PDSEG}/auto-exit-c10.png`;
    const P_MANUAL = `${USER}/${PDSEG}/manual.png`;
    const P_REVIEW = `${USER}/${PSESS}_1/review.png`;
    const pInput: ExportSnapshotInput = {
      unified: [{
        key: pGrouped.tradeKey, source: "simulator", ticker: "PKGR", tradeDate: "2026-10-15",
        direction: "long", entryPrice: 10, exitPrice: 11, qty: 100, realizedPnl: 100, isOpen: false,
        rMultiple: 2, sessionSource: "daily_replay", attemptId: PATT,
      }],
      metas: {}, realTrades: [], simTrades: [pGrouped],
      drAttempts: [{ id: PATT, sessionId: PSESS, strategyVersionId: null, status: "finished", startIndex: 4, createdAt: "2026-10-16T16:00:00Z", finishedAt: "2026-10-16T16:30:00Z", ticker: "PKGR", tradeDate: "2026-10-15" }],
      drEvidence: pDerived.byTradeKey,
      drEvents: pEvents.map((event, i) => ({ id: `pev-${i + 1}`, attemptId: PATT, event })),
      drEventTradeKeys: new Map([[PATT, pDerived.eventTradeKey]]),
      strategies: [], strategyVersions: [],
      drDraftKeys: new Map([[pGrouped.tradeKey, {
        draftKey: PDRAFT,
        autoCapture: {
          entry: { path: P_ENTRY, candleIndex: 5, status: "captured" },
          exit: { path: P_EXIT, candleIndex: 9, status: "captured" },
        },
      }]]),
    };
    const pSnap = buildExportSnapshot(pInput, { range: { start: "2026-10-01", end: "2026-10-31" }, mode: "custom", source: "daily_replay" });
    const CBASE = Date.UTC(2026, 9, 15, 13, 30, 0);
    const pCandles = Array.from({ length: 12 }, (_, i) => ({
      t: CBASE + i * 60000, o: 10 + i * 0.1, h: 10.2 + i * 0.1, l: 9.9 + i * 0.1, c: 10.1 + i * 0.1, v: 1000 + i * 100,
    }));
    const mkPkgClient = (opts: { failEntryDownload?: boolean; failCandles?: boolean } = {}) => ({
      storage: {
        from: (_bucket: string) => ({
          list: async (prefix: string) => {
            if (prefix === `${USER}/${PDSEG}`) {
              return { data: [
                { name: "auto-entry-c6.png", id: "o1", created_at: "2026-10-16T16:05:00.000Z" },
                { name: "auto-exit-c10.png", id: "o2", created_at: "2026-10-16T16:09:00.000Z" },
                { name: "manual.png", id: "o3", created_at: "2026-10-16T16:20:00.000Z" },
              ], error: null };
            }
            if (prefix === `${USER}/${PSESS}_1`) {
              return { data: [{ name: "review.png", id: "o4", created_at: "2026-10-16T16:25:00.000Z" }], error: null };
            }
            return { data: [], error: null };
          },
          createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: "https://signed.example/p", error: null })), error: null }),
          download: async (path: string) => {
            if (opts.failEntryDownload && path === P_ENTRY) return { data: null, error: { message: "entry bytes gone" } };
            return { data: new Blob([new Uint8Array(FAKE_PNG)]), error: null };
          },
        }),
      },
      from: (_table: string) => ({
        select: (_cols: string) => ({
          in: async (_col: string, _ids: string[]) => opts.failCandles
            ? { data: null, error: { message: "db down" } }
            : { data: [{ id: PSESS, candles: pCandles }], error: null },
        }),
      }),
    }) as any;

    const resP = await generateEdgePackage(mkPkgClient(), USER, pSnap, { includeScreenshots: true, includePdf: false });
    check("rep pkg: exactly ONE screenshot file in the summary", resP.summary.screenshotFiles === 1);
    const zipP = await JSZip.loadAsync(new Uint8Array(await resP.blob.arrayBuffer()));
    const shotNames = Object.keys(zipP.files).filter((n) => n.startsWith("screenshots/") && !n.endsWith("/"));
    check("rep pkg: ZIP screenshots/ holds exactly one image", shotNames.length === 1);
    const repEntry = resP.manifest.find((e) => e.role === "representative");
    check("rep pkg: the ZIP image IS the representative", repEntry?.status === "included" && shotNames[0] === `screenshots/${repEntry.fileName}`);
    check("rep pkg: manifest lists all 4 images; 3 are not-included",
      resP.manifest.length === 4 && resP.manifest.filter((e) => e.status === "not-included").length === 3);
    check("rep pkg: representative candleTime stamped from stored candles",
      repEntry?.candleTime === "2026-10-15T13:35:00.000Z" && repEntry?.candleIndex === 5 && repEntry?.representativeSource === "auto_entry");
    const tradesCsvP = await zipP.file("trades.csv")!.async("string");
    const pRows = parseCsv(tradesCsvP);
    const pShotCol = pRows[0].indexOf("screenshot_files");
    check("rep pkg: trades.csv names only the representative file",
      pRows.length === 2 && pRows[1][pShotCol] === repEntry?.fileName);
    const analyticsP = JSON.parse(await zipP.file("analytics.json")!.async("string"));
    check("rep pkg: analytics tradesIndex lists only the representative",
      JSON.stringify(analyticsP.tradesIndex[0].screenshots) === JSON.stringify([repEntry?.fileName]));
    check("rep pkg: chart_context.csv in ZIP + filesIncluded",
      !!zipP.file("chart_context.csv") && resP.summary.filesIncluded.includes("chart_context.csv"));
    const ccText = await zipP.file("chart_context.csv")!.async("string");
    const ccRows = parseCsv(ccText).slice(1);
    check("rep pkg: chart_context sections are 5 entry / 1 final / 4 post",
      ccRows.filter((r) => r[3] === "entry_context").length === 5
      && ccRows.filter((r) => r[3] === "entry_candle_final").length === 1
      && ccRows.filter((r) => r[3] === "post_entry_development").length === 4);
    check("rep pkg: prompt carries the chart-analysis section + file line",
      resP.promptText.includes("REPRESENTATIVE SCREENSHOT & CHART ANALYSIS") && resP.promptText.includes("chart_context.csv - per-trade historical OHLCV"));
    check("rep pkg: no chart-context warnings on the happy path",
      !resP.warnings.some((w) => w.includes("Chart context unavailable") || w.includes("could not be built")));

    /* representative download failure: reported, NEVER substituted */
    const resFail = await generateEdgePackage(mkPkgClient({ failEntryDownload: true }), USER, pSnap, { includeScreenshots: true, includePdf: false });
    const failRep = resFail.manifest.find((e) => e.role === "representative");
    check("rep fail: representative marked unavailable", failRep?.status === "unavailable");
    check("rep fail: NO image substituted (0 files, others still not-included)",
      resFail.summary.screenshotFiles === 0 && resFail.manifest.filter((e) => e.status === "not-included").length === 3);
    check("rep fail: warning surfaced", resFail.warnings.some((w) => w.includes("could not be downloaded")));
    const zipFail = await JSZip.loadAsync(new Uint8Array(await resFail.blob.arrayBuffer()));
    check("rep fail: ZIP has the NO-SCREENSHOTS note, no image bytes",
      !!zipFail.file("screenshots/NO-SCREENSHOTS.txt") && !Object.keys(zipFail.files).some((n) => n.endsWith(".png")));

    /* candle fetch failure: warning, package continues, no invention */
    const resNoCc = await generateEdgePackage(mkPkgClient({ failCandles: true }), USER, pSnap, { includeScreenshots: true, includePdf: false });
    const zipNoCc = await JSZip.loadAsync(new Uint8Array(await resNoCc.blob.arrayBuffer()));
    check("cc fail: package still produced with the representative image",
      resNoCc.summary.screenshotFiles === 1 && !!zipNoCc.file("trades.csv"));
    check("cc fail: chart_context.csv honestly absent", !zipNoCc.file("chart_context.csv"));
    check("cc fail: warning explains the omission", resNoCc.warnings.some((w) => w.includes("could not be built")));
    check("cc fail: representative candleTime stays null (not invented)",
      resNoCc.manifest.find((e) => e.role === "representative")?.candleTime === null);
    check("cc fail: prompt omits the chart file line", !resNoCc.promptText.includes("chart_context.csv - per-trade"));

    /* toggle off */
    const resOff = await generateEdgePackage(mkPkgClient(), USER, pSnap, { includeScreenshots: true, includePdf: false, includeChartContext: false });
    const zipOff = await JSZip.loadAsync(new Uint8Array(await resOff.blob.arrayBuffer()));
    check("cc off: no chart_context.csv and no cc warnings",
      !zipOff.file("chart_context.csv") && !resOff.warnings.some((w) => w.includes("Chart context")));

    /* PDF: only the representative can appear (D8) */
    const resPdf = await generateEdgePackage(mkPkgClient(), USER, pSnap, { includeScreenshots: true, includePdf: true });
    check("rep pdf: PDF built from the single included representative",
      resPdf.summary.pdfIncluded === true && resPdf.summary.screenshotFiles === 1);
  }

  console.log(`edgeExportPackage tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("edgeExportPackage tests crashed:", e); process.exit(1); });
