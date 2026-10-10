"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";

function LoginInner() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/replay";
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const configured = isSupabaseConfigured();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configured) return;
    setError(null); setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}${next}` },
      });
      if (error) throw new Error(error.message);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 440, margin: "40px auto" }}>
      <div className="card">
        <h3>Sign in</h3>
        {!configured ? (
          <div className="err">
            Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and
            NEXT_PUBLIC_SUPABASE_ANON_KEY to your environment, then reload.
          </div>
        ) : sent ? (
          <div className="ok">
            Check your email for the magic link — it signs you straight in.
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="field">
              <label>Email address</label>
              <input className="input" type="email" required value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <button className="btn primary big" disabled={busy}>
              {busy ? "Sending…" : "Email me a sign-in link"}
            </button>
            <p className="hint" style={{ marginTop: 10 }}>
              Passwordless login — no password to remember or leak.
            </p>
          </form>
        )}
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="hint">Loading…</div>}>
      <LoginInner />
    </Suspense>
  );
}
