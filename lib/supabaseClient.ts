import { createBrowserClient } from "@supabase/ssr";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export function isSupabaseConfigured(): boolean {
  return url.length > 0 && anonKey.length > 0 && !url.includes("your-project");
}

/** Browser Supabase client. Call only when isSupabaseConfigured(). */
export function createClient() {
  return createBrowserClient(url, anonKey);
}
