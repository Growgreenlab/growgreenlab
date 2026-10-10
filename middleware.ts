import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PROTECTED = ["/replay", "/sessions"];

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  // Without Supabase configured we cannot verify auth; pages handle it.
  if (!url || !key || url.includes("your-project")) return res;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (
        cookiesToSet: { name: string; value: string; options?: CookieOptions }[]
      ) => {
        cookiesToSet.forEach(({ name, value, options }) =>
          res.cookies.set(name, value, options)
        );
      },
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const needsAuth = PROTECTED.some((p) => req.nextUrl.pathname.startsWith(p));
  if (needsAuth && !user) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return res;
}

export const config = {
  matcher: ["/replay/:path*", "/sessions/:path*"],
};
