"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";
import { formatMoney, formatSigned } from "../../lib/engine";

interface Row {
  id: string;
  ticker: string;
  trade_date: string;
  source: string;
  realized_pnl: number | null;
  created_at: string;
}

export default function SessionsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guest, setGuest] = useState(false);

  const load = async () => {
    if (!isSupabaseConfigured()) {
      setError("Supabase is not configured.");
      setLoading(false);
      return;
    }
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      setGuest(!user);
      const { data, error } = await supabase
        .from("replay_sessions")
        .select("id,ticker,trade_date,source,realized_pnl,created_at")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      setRows(data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load sessions.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (id: string) => {
    if (!confirm("Delete this saved session and its trades?")) return;
    try {
      const supabase = createClient();
      const { error } = await supabase.from("replay_sessions").delete().eq("id", id);
      if (error) throw new Error(error.message);
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed.");
    }
  };

  return (
    <div>
      <h2 style={{ margin: "18px 0 6px" }}>My Sessions</h2>
      <p className="hint">Saved replay sessions. Reload one to review it candle by candle, or delete it.</p>
      <div className="section">
        {loading && <div className="hint">Loading…</div>}
        {error && <div className="err">{error}</div>}
        {!loading && !error && rows.length === 0 && (
          <div className="card">
            <p className="hint">
              {guest
                ? "Sign in to save sessions to your account and open them on any device."
                : "No saved sessions yet. Run a replay, then hit “Save session”."}
            </p>
            {guest ? (
              <Link href="/login" className="btn primary">Sign in</Link>
            ) : (
              <Link href="/replay" className="btn primary">Open Replay Lab</Link>
            )}
          </div>
        )}
        {rows.map((r) => (
          <div className="sessionitem" key={r.id}>
            <div className="meta">
              <strong>{r.ticker}</strong> · {r.trade_date} · {r.source}
              <small>
                {new Date(r.created_at).toLocaleString()} · P/L{" "}
                <span className={`num ${(r.realized_pnl ?? 0) >= 0 ? "pos" : "neg"}`}>
                  {formatSigned(r.realized_pnl ?? 0)}
                </span>
              </small>
            </div>
            <div className="actions">
              <Link href={`/replay?session=${r.id}`} className="btn primary">Reload</Link>
              <button className="btn danger" onClick={() => remove(r.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      <div className="hint">Cash on save: virtual {formatMoney(100000)} starting equity. All simulated.</div>
    </div>
  );
}
