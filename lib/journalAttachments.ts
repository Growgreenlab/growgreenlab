/**
 * journalAttachments.ts — screenshot storage for journal trades.
 *
 * Screenshots live in the private Supabase Storage bucket
 * `journal-screenshots`, under `{userId}/{tradeKeySegment}/…` where the
 * tradeKeySegment is the trade_key with unsafe characters replaced
 * (e.g. `real:abc-123` → `real_abc-123`). Storage policies restrict
 * every operation to objects whose first path segment is the caller's
 * auth.uid(), so users can only ever reach their own screenshots.
 * Reads use short-lived signed URLs (1 hour) — never public URLs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const BUCKET = "journal-screenshots";
export const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const SIGNED_URL_TTL_SECONDS = 3600;

/** Storage-safe path segment for a trade_key (`real:abc` → `real_abc`). */
export function segment(tradeKey: string): string {
  return tradeKey.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "image";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "image";
}

/** Full storage path for a new screenshot upload. */
export function pathFor(userId: string, tradeKey: string, fileName: string): string {
  return `${userId}/${segment(tradeKey)}/${crypto.randomUUID()}-${safeFileName(fileName)}`;
}

/** Validate one screenshot file. Returns an error string, or null if OK. */
export function validateScreenshotFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return `${file.name}: unsupported file type${file.type ? ` (${file.type})` : ""} — use PNG, JPEG, WebP or GIF.`;
  }
  if (file.size <= 0) return `${file.name}: file is empty.`;
  if (file.size > MAX_BYTES) {
    return `${file.name}: ${(file.size / (1024 * 1024)).toFixed(1)} MB is over the 5 MB limit.`;
  }
  return null;
}

/**
 * Upload screenshots for a trade. Each file is validated first; valid
 * files are uploaded even when others fail. Returns the storage paths
 * that succeeded plus one error string per failed file.
 */
export async function uploadScreenshots(
  client: SupabaseClient,
  userId: string,
  tradeKey: string,
  files: File[],
): Promise<{ uploaded: string[]; errors: string[] }> {
  const uploaded: string[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const invalid = validateScreenshotFile(file);
    if (invalid) { errors.push(invalid); continue; }
    const path = pathFor(userId, tradeKey, file.name);
    const { error } = await client.storage.from(BUCKET).upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (error) errors.push(`${file.name}: ${error.message}`);
    else uploaded.push(path);
  }
  return { uploaded, errors };
}

/**
 * Upload ONE screenshot blob (e.g. an automatic chart capture) to a
 * DETERMINISTIC path — `{userId}/{segment(tradeKey)}/{fileName}` —
 * with upsert enabled, so a retry overwrites the same object instead
 * of piling up duplicates (contrast uploadScreenshots, whose random
 * names suit one-off manual uploads). Returns the storage path plus
 * an error string (null on success); the path is returned either way
 * so callers can record the intended location.
 */
export async function uploadScreenshotBlob(
  client: SupabaseClient,
  userId: string,
  tradeKey: string,
  fileName: string,
  blob: Blob,
): Promise<{ path: string; error: string | null }> {
  const path = `${userId}/${segment(tradeKey)}/${safeFileName(fileName)}`;
  const { error } = await client.storage.from(BUCKET).upload(path, blob, {
    contentType: "image/png",
    upsert: true,
  });
  return { path, error: error ? error.message : null };
}

/**
 * List a trade's screenshots with fresh signed URLs (1 hour TTL).
 * Returns [] on any error (missing bucket, no files, signed-url
 * failure) so callers can treat "no screenshots" uniformly.
 */
export async function listScreenshots(
  client: SupabaseClient,
  userId: string,
  tradeKey: string,
): Promise<{ path: string; url: string }[]> {
  try {
    const prefix = `${userId}/${segment(tradeKey)}`;
    const { data, error } = await client.storage.from(BUCKET).list(prefix, {
      limit: 100,
      sortBy: { column: "created_at", order: "asc" },
    });
    if (error || !data) return [];
    // Storage list results include folder entries and the
    // ".emptyFolderPlaceholder" object — real files have a non-null id.
    const paths = data
      .filter((e) => e.name && e.id != null && e.name !== ".emptyFolderPlaceholder")
      .map((e) => `${prefix}/${e.name}`);
    if (paths.length === 0) return [];
    const { data: signed, error: signError } = await client.storage
      .from(BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    if (signError || !signed) return [];
    const out: { path: string; url: string }[] = [];
    for (const s of signed) {
      if (s.signedUrl && s.path) out.push({ path: s.path, url: s.signedUrl });
    }
    return out;
  } catch {
    return [];
  }
}

/** Delete screenshots by storage path. Missing objects are ignored. */
export async function removeScreenshots(client: SupabaseClient, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await client.storage.from(BUCKET).remove(paths);
  } catch {
    // Best-effort cleanup — a failed removal must not block trade edits
    // or trade deletion; the objects remain owner-scoped regardless.
  }
}
