import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isSafeNext } from "../../../lib/subscribeResume";

/**
 * Handles Supabase auth callbacks (magic-link / OTP).
 * Exchanges the one-time `code` for a session, then sends the user
 * to `?next=` (defaults to /replay) — logged in, not as a guest.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/replay";
  const dest = new URL(isSafeNext(next) ? next : "/replay", url.origin);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  // No code or not configured — send to login with an explanation
  if (!code || !supabaseUrl || !supabaseKey) {
    const login = new URL("/login", url.origin);
    login.searchParams.set("error", "missing_code");
    login.searchParams.set("next", next);
    return NextResponse.redirect(login);
  }

  const res = NextResponse.redirect(dest);
  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (
        cookiesToSet: { name: string; value: string; options?: object }[]
      ) => {
        cookiesToSet.forEach(({ name, value, options }) =>
          res.cookies.set(name, value, options)
        );
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    // Exchange failed (expired link, wrong browser, etc.) — don't pretend
    // the user is logged in. Send them back to login with a clear message.
    const login = new URL("/login", url.origin);
    login.searchParams.set("error", "link_expired");
    login.searchParams.set("next", next);
    return NextResponse.redirect(login);
  }

  return res;
}
