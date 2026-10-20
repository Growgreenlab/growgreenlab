"use client";

/**
 * /admin/access — complimentary access administration.
 *
 * Convenience UI ONLY: every action re-authorizes inside Postgres
 * (the admin RPCs check is_app_admin() server-side), and this page
 * renders nothing useful unless the caller's own session passes
 * that same check. Non-admins — signed in or not — get a plain
 * "not available" view, indistinguishable from a missing page.
 * There is no user directory to search by design: grants are made
 * by exact account user ID, and no backend exists that could look
 * users up by email.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient, isSupabaseConfigured } from "../../../lib/supabaseClient";
import {
  adminCreatePromo,
  adminDeactivatePromo,
  adminGrantAccess,
  adminListGrants,
  adminListPromos,
  adminRevokeGrant,
  checkIsAppAdmin,
  type AccessGrantRow,
  type PromoCodeRow,
} from "../../../lib/accessAdmin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const PROMO_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{9,63}$/;

/** Random key in XXXX-XXXX-XXXX form, from the unambiguous alphabet
 *  the server enforces (no 0/O, 1/I/L): 12 chars ≈ 59 bits. */
function generatePromoCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
    .map((s) => s.join(""))
    .join("-");
}

function promoStatus(p: PromoCodeRow, now: number): string {
  if (!p.active) return "Deactivated";
  if (p.expires_at && new Date(p.expires_at).getTime() <= now) return "Expired";
  return "Active";
}

function grantStatus(g: AccessGrantRow, now: number): string {
  if (g.revoked_at) return "Revoked";
  if (new Date(g.starts_at).getTime() > now) return "Scheduled";
  if (g.expires_at && new Date(g.expires_at).getTime() <= now) return "Expired";
  return "Active";
}

export default function AdminAccessPage() {
  const [phase, setPhase] = useState<"checking" | "denied" | "ready">("checking");
  const [target, setTarget] = useState("");
  const [source, setSource] = useState<"admin" | "trial">("admin");
  const [duration, setDuration] = useState("");
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState("");
  const [grants, setGrants] = useState<AccessGrantRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pCode, setPCode] = useState("");
  const [pLabel, setPLabel] = useState("");
  const [pDuration, setPDuration] = useState("30");
  const [pMax, setPMax] = useState("");
  const [pPerUser, setPPerUser] = useState("1");
  const [pExpiry, setPExpiry] = useState("");
  const [promos, setPromos] = useState<PromoCodeRow[]>([]);
  const [promoMsg, setPromoMsg] = useState<string | null>(null);
  const [pBusy, setPBusy] = useState(false);
  /** Plaintext of the just-created key — shown exactly once. The
   *  server stored only its sha-256 fingerprint, so once this state
   *  is cleared the code can never be displayed again. */
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);

  const loadGrants = useCallback(async (filterUser: string) => {
    const supabase = createClient();
    const r = await adminListGrants(
      supabase,
      UUID_RE.test(filterUser.trim()) ? filterUser.trim() : null,
    );
    if (r.ok) setGrants(r.grants);
  }, []);

  const loadPromos = useCallback(async () => {
    const r = await adminListPromos(createClient());
    if (r.ok) setPromos(r.promos);
  }, []);

  useEffect(() => {
    (async () => {
      if (!isSupabaseConfigured()) { setPhase("denied"); return; }
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setPhase("denied"); return; }
      if (!(await checkIsAppAdmin(supabase))) { setPhase("denied"); return; }
      setPhase("ready");
      loadGrants("");
      loadPromos();
    })();
  }, [loadGrants, loadPromos]);

  if (phase === "checking") {
    return <div className="wrap" style={{ padding: 40 }}><p className="hint">Loading…</p></div>;
  }
  if (phase === "denied") {
    return (
      <div className="wrap" style={{ paddingTop: 28, maxWidth: 760 }}>
        <h2 style={{ margin: "0 0 8px" }}>Not available</h2>
        <p className="hint">
          This page is not available for your account. If you were looking for
          your plan, see <Link href="/billing">Billing</Link>.
        </p>
      </div>
    );
  }

  const grant = async () => {
    const t = target.trim();
    if (!UUID_RE.test(t)) { setMsg("Enter a valid account user ID (UUID)."); return; }
    const days = duration.trim() === "" ? null : Number(duration);
    if (days !== null && (!Number.isInteger(days) || days <= 0)) {
      setMsg("Duration must be a whole number of days, or blank for permanent.");
      return;
    }
    setBusy(true);
    setMsg(null);
    const r = await adminGrantAccess(createClient(), {
      targetUserId: t,
      source,
      durationDays: days,
      note: note.trim() === "" ? null : note.trim(),
    });
    setBusy(false);
    if (r.ok) {
      setMsg(`Grant created (${r.grantId ?? "ok"}).`);
      setTarget(""); setDuration(""); setNote("");
      loadGrants(filter);
    } else {
      setMsg(`Grant failed: ${r.error ?? "unknown error"}`);
    }
  };

  const revoke = async (g: AccessGrantRow) => {
    setBusy(true);
    setMsg(null);
    const r = await adminRevokeGrant(createClient(), g.id);
    setBusy(false);
    setMsg(r.ok ? "Grant revoked." : `Revoke failed: ${r.error ?? "unknown error"}`);
    if (r.ok) loadGrants(filter);
  };

  const createPromo = async () => {
    const code = pCode.trim().toUpperCase();
    if (!PROMO_CODE_RE.test(code)) {
      setPromoMsg("Code must be 10–64 characters of A–Z, 0–9, dash or underscore. Use Generate for a ready-made key.");
      return;
    }
    const days = Number(pDuration);
    if (!Number.isInteger(days) || days <= 0) {
      setPromoMsg("Duration must be a whole number of days (each redemption grants that many days of Pro).");
      return;
    }
    const max = pMax.trim() === "" ? null : Number(pMax);
    if (max !== null && (!Number.isInteger(max) || max <= 0)) {
      setPromoMsg("Max redemptions must be a positive whole number, or blank for unlimited.");
      return;
    }
    const perUser = Number(pPerUser);
    if (!Number.isInteger(perUser) || perUser <= 0) {
      setPromoMsg("Per-user limit must be a positive whole number.");
      return;
    }
    let expiresAt: string | null = null;
    if (pExpiry.trim() !== "") {
      const d = new Date(pExpiry);
      if (Number.isNaN(d.getTime())) { setPromoMsg("Key expiry date is not a valid date."); return; }
      expiresAt = d.toISOString();
    }
    setPBusy(true);
    setPromoMsg(null);
    const r = await adminCreatePromo(createClient(), {
      code,
      label: pLabel.trim() === "" ? null : pLabel.trim(),
      durationDays: days,
      maxRedemptions: max,
      perUserLimit: perUser,
      expiresAt,
    });
    setPBusy(false);
    if (r.ok) {
      setCreatedCode(code);
      setCodeCopied(false);
      setPromoMsg(null);
      setPCode(""); setPLabel(""); setPMax(""); setPPerUser("1"); setPExpiry("");
      loadPromos();
    } else {
      setPromoMsg(`Key creation failed: ${r.error ?? "unknown error"}`);
    }
  };

  const copyCreatedCode = async () => {
    if (!createdCode) return;
    try {
      await navigator.clipboard.writeText(createdCode);
      setCodeCopied(true);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = createdCode;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCodeCopied(true);
      } catch { /* admin can still select the code text manually */ }
    }
    setTimeout(() => setCodeCopied(false), 2000);
  };

  const deactivatePromo = async (p: PromoCodeRow) => {
    setPBusy(true);
    setPromoMsg(null);
    const r = await adminDeactivatePromo(createClient(), p.id);
    setPBusy(false);
    setPromoMsg(r.ok ? "Key deactivated — it can no longer be redeemed." : `Deactivate failed: ${r.error ?? "unknown error"}`);
    if (r.ok) loadPromos();
  };

  const now = Date.now();

  return (
    <div className="wrap" style={{ paddingTop: 28, paddingBottom: 48, maxWidth: 900 }}>
      <h2 style={{ margin: "0 0 6px" }}>Access grants</h2>
      <p className="hint" style={{ margin: "0 0 20px" }}>
        Grant or revoke complimentary Pro by account user ID. Every action is
        authorized and audit-logged in the database. Owner grants are
        permanent and cannot be revoked here.
      </p>

      {msg && <div className="card" style={{ padding: "12px 16px", marginBottom: 14 }}>{msg}</div>}

      <div className="card" style={{ padding: 18, display: "grid", gap: 10, marginBottom: 16 }}>
        <strong>New grant</strong>
        <label className="hint">Account user ID
          <input value={target} onChange={(e) => setTarget(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            autoComplete="off" spellCheck={false}
            style={{ display: "block", width: "100%", padding: "8px 10px", marginTop: 4 }} />
        </label>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label className="hint">Source
            <select value={source} onChange={(e) => setSource(e.target.value as "admin" | "trial")}
              style={{ display: "block", padding: "8px 10px", marginTop: 4 }}>
              <option value="admin">Complimentary (admin)</option>
              <option value="trial">Trial</option>
            </select>
          </label>
          <label className="hint">Duration in days (blank = permanent)
            <input value={duration} onChange={(e) => setDuration(e.target.value)}
              inputMode="numeric" placeholder="30"
              style={{ display: "block", width: 160, padding: "8px 10px", marginTop: 4 }} />
          </label>
          <label className="hint" style={{ flex: "1 1 220px" }}>Note
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Why — e.g. coaching client, tester, promo"
              style={{ display: "block", width: "100%", padding: "8px 10px", marginTop: 4 }} />
          </label>
        </div>
        <div>
          <button className="btn primary" disabled={busy} onClick={grant}>
            {busy ? "Working…" : "Grant access"}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 18, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
          <strong style={{ marginRight: "auto" }}>Grants</strong>
          <label className="hint">Filter by user ID
            <input value={filter} onChange={(e) => setFilter(e.target.value)}
              autoComplete="off" spellCheck={false}
              style={{ display: "block", width: 280, padding: "8px 10px", marginTop: 4 }} />
          </label>
          <button className="btn" disabled={busy} onClick={() => loadGrants(filter)}>Refresh</button>
        </div>
        {grants.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>No grants found.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  {["User", "Source", "Starts", "Expires", "Status", "Note", ""].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border, #333)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grants.map((g) => {
                  const status = grantStatus(g, now);
                  return (
                    <tr key={g.id}>
                      <td className="num" style={{ padding: "6px 8px" }}>{g.user_id.slice(0, 8)}…</td>
                      <td style={{ padding: "6px 8px" }}>{g.source}</td>
                      <td className="num" style={{ padding: "6px 8px" }}>{fmtDate(g.starts_at)}</td>
                      <td className="num" style={{ padding: "6px 8px" }}>{g.expires_at ? fmtDate(g.expires_at) : "Permanent"}</td>
                      <td style={{ padding: "6px 8px" }}>{status}</td>
                      <td style={{ padding: "6px 8px" }}>{g.note ?? ""}</td>
                      <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                        {g.source === "owner"
                          ? <span className="hint">Protected</span>
                          : status === "Active" || status === "Scheduled"
                            ? <button className="btn" disabled={busy} onClick={() => revoke(g)}>Revoke</button>
                            : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 18, display: "grid", gap: 10, marginTop: 16 }}>
        <strong>Promo keys</strong>
        <p className="hint" style={{ margin: 0 }}>
          Create a key and hand it out — anyone who redeems it on their
          Billing page gets Pro for the key&apos;s duration. Only the
          key&apos;s fingerprint (sha-256) is stored, so a key&apos;s code
          can never be shown again after creation.
        </p>

        {createdCode && (
          <div style={{ border: "1px solid var(--accent, #3ba55d)", borderRadius: 8, padding: "12px 14px", display: "grid", gap: 8 }}>
            <strong>Key created — copy it now</strong>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <code className="num" style={{ fontSize: 18, letterSpacing: 1 }}>{createdCode}</code>
              <button className="btn" onClick={copyCreatedCode}>{codeCopied ? "Copied ✓" : "Copy"}</button>
              <button className="btn" onClick={() => setCreatedCode(null)}>Dismiss</button>
            </div>
            <span className="hint">
              ⚠ This code is shown only once — only its fingerprint is stored.
              Copy it now. If you lose it, deactivate the key below and create a new one.
            </span>
          </div>
        )}

        {promoMsg && <div style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: "10px 14px" }}>{promoMsg}</div>}

        <div style={{ display: "grid", gap: 10 }}>
          <label className="hint">Code
            <span style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <input value={pCode} onChange={(e) => setPCode(e.target.value)}
                placeholder="e.g. INSTA-PROMO-2026"
                autoComplete="off" spellCheck={false}
                style={{ flex: 1, padding: "8px 10px" }} />
              <button type="button" className="btn" onClick={() => setPCode(generatePromoCode())}>Generate</button>
            </span>
          </label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <label className="hint" style={{ flex: "1 1 200px" }}>Label
              <input value={pLabel} onChange={(e) => setPLabel(e.target.value)}
                placeholder="e.g. Instagram promo"
                style={{ display: "block", width: "100%", padding: "8px 10px", marginTop: 4 }} />
            </label>
            <label className="hint">Duration in days
              <input value={pDuration} onChange={(e) => setPDuration(e.target.value)}
                inputMode="numeric" placeholder="30"
                style={{ display: "block", width: 130, padding: "8px 10px", marginTop: 4 }} />
            </label>
            <label className="hint">Max redemptions (blank = unlimited)
              <input value={pMax} onChange={(e) => setPMax(e.target.value)}
                inputMode="numeric" placeholder="Unlimited"
                style={{ display: "block", width: 170, padding: "8px 10px", marginTop: 4 }} />
            </label>
            <label className="hint">Per-user limit
              <input value={pPerUser} onChange={(e) => setPPerUser(e.target.value)}
                inputMode="numeric" placeholder="1"
                style={{ display: "block", width: 110, padding: "8px 10px", marginTop: 4 }} />
            </label>
            <label className="hint">Key expires (optional)
              <input type="datetime-local" value={pExpiry} onChange={(e) => setPExpiry(e.target.value)}
                style={{ display: "block", padding: "8px 10px", marginTop: 4 }} />
            </label>
          </div>
          <div>
            <button className="btn primary" disabled={pBusy} onClick={createPromo}>
              {pBusy ? "Working…" : "Create key"}
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <strong style={{ marginRight: "auto" }}>Keys</strong>
          <button className="btn" disabled={pBusy} onClick={loadPromos}>Refresh</button>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Deactivating a key stops new redemptions. Grants already redeemed
          keep running until their own expiry.
        </p>
        {promos.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>No promo keys yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  {["Label", "Duration", "Redeemed", "Per user", "Key expires", "Status", "Created", ""].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border, #333)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {promos.map((p) => {
                  const status = promoStatus(p, now);
                  return (
                    <tr key={p.id}>
                      <td style={{ padding: "6px 8px" }}>{p.label ?? "—"}</td>
                      <td className="num" style={{ padding: "6px 8px" }}>{p.duration_days} days</td>
                      <td className="num" style={{ padding: "6px 8px" }}>{p.redeemed_count} / {p.max_redemptions ?? "∞"}</td>
                      <td className="num" style={{ padding: "6px 8px" }}>{p.per_user_limit}</td>
                      <td className="num" style={{ padding: "6px 8px" }}>{p.expires_at ? fmtDate(p.expires_at) : "Never"}</td>
                      <td style={{ padding: "6px 8px" }}>{status}</td>
                      <td className="num" style={{ padding: "6px 8px" }}>{fmtDate(p.created_at)}</td>
                      <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                        {status === "Active"
                          ? <button className="btn" disabled={pBusy} onClick={() => deactivatePromo(p)}>Deactivate</button>
                          : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
