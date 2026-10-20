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
  adminGrantAccess,
  adminListGrants,
  adminRevokeGrant,
  checkIsAppAdmin,
  type AccessGrantRow,
} from "../../../lib/accessAdmin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
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

  const loadGrants = useCallback(async (filterUser: string) => {
    const supabase = createClient();
    const r = await adminListGrants(
      supabase,
      UUID_RE.test(filterUser.trim()) ? filterUser.trim() : null,
    );
    if (r.ok) setGrants(r.grants);
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
    })();
  }, [loadGrants]);

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
    </div>
  );
}
