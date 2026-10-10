"use client";

import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";

type Mode = "signin" | "signup" | "magic";

function LoginInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const next = searchParams.get("next") ?? "/replay";
  const authError = searchParams.get("error");

  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(
    authError === "link_expired"
      ? "That link expired or was already used. Sign in below instead."
      : authError === "missing_code"
        ? "The sign-in link was incomplete. Sign in below instead."
        : null
  );
  const [busy, setBusy] = useState(false);
  const configured = isSupabaseConfigured();

  const goNext = () => {
    router.push(next.startsWith("/") ? next : "/replay");
    router.refresh();
  };

  const handlePasswordAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configured) return;
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { display_name: name.trim() },
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (error) throw new Error(error.message);
        setSent(true);
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw new Error(error.message);
        goNext();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configured) return;
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
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
    <div style={{ maxWidth: 440, margin: "40px auto", padding: "0 20px" }}>
      <div className="card">
        {!configured ? (
          <div className="err">
            Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and
            NEXT_PUBLIC_SUPABASE_ANON_KEY to your environment, then reload.
          </div>
        ) : sent ? (
          <div className="ok">
            <h3 style={{ margin: "0 0 8px" }}>Check your email</h3>
            <p style={{ margin: 0 }}>
              We sent a verification link to <b>{email}</b>. Click it to
              finish creating your account, then you'll be signed in.
            </p>
          </div>
        ) : (
          <>
            {/* Mode tabs */}
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              {(["signin", "signup"] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setError(null); }}
                  style={{
                    flex: 1,
                    padding: "10px",
                    borderRadius: 8,
                    border: "1px solid",
                    borderColor: mode === m ? "#42D879" : "#252D35",
                    background: mode === m ? "rgba(66,216,121,0.08)" : "transparent",
                    color: mode === m ? "#F5F6F7" : "#7F8993",
                    fontWeight: 600,
                    fontSize: 14,
                    cursor: "pointer",
                  }}
                >
                  {m === "signin" ? "Sign In" : "Create Account"}
                </button>
              ))}
            </div>

            <h3 style={{ margin: "0 0 16px" }}>
              {mode === "signin" ? "Welcome back" : mode === "signup" ? "Create your account" : "Sign in with email link"}
            </h3>

            {mode === "magic" ? (
              <form onSubmit={handleMagicLink}>
                <div className="field">
                  <label>Email address</label>
                  <input className="input" type="email" required value={email}
                    onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                </div>
                <button className="btn primary big" disabled={busy}>
                  {busy ? "Sending…" : "Email me a sign-in link"}
                </button>
              </form>
            ) : (
              <form onSubmit={handlePasswordAuth}>
                {mode === "signup" && (
                  <div className="field">
                    <label>Your name</label>
                    <input className="input" type="text" required value={name}
                      onChange={(e) => setName(e.target.value)} placeholder="Alex Trader" />
                  </div>
                )}
                <div className="field">
                  <label>Email address</label>
                  <input className="input" type="email" required value={email}
                    onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                </div>
                <div className="field">
                  <label>Password</label>
                  <input className="input" type="password" required value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === "signup" ? "Min. 6 characters" : "Your password"}
                    minLength={6} />
                </div>
                <button className="btn primary big" disabled={busy}>
                  {busy ? "Please wait…" : mode === "signin" ? "Sign In" : "Create Account"}
                </button>
              </form>
            )}

            {error && <div className="err" style={{ marginTop: 12 }}>{error}</div>}

            <p className="hint" style={{ marginTop: 16, textAlign: "center" }}>
              {mode === "magic" ? (
                <>Prefer a password? <button onClick={() => setMode("signin")} style={{ background: "none", border: "none", color: "#42D879", cursor: "pointer", fontSize: "inherit", padding: 0 }}>Sign in with password</button></>
              ) : (
                <>No password? <button onClick={() => setMode("magic")} style={{ background: "none", border: "none", color: "#42D879", cursor: "pointer", fontSize: "inherit", padding: 0 }}>Email me a sign-in link</button></>
              )}
            </p>

            <p className="hint" style={{ marginTop: 8, textAlign: "center" }}>
              <Link href="/replay" style={{ color: "#7F8993" }}>Continue as guest →</Link>
            </p>
          </>
        )}
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
