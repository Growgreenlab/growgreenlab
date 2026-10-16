"use client";

/**
 * React binding for the Academy progress store (lib/academy/progress).
 *
 * Loads the guest record immediately, then — if a Supabase session
 * exists — merges with the server best-effort. If the academy tables
 * don't exist yet (migration not applied) or anything fails, the hook
 * silently stays in guest mode: `synced` only becomes true after a
 * sync round-trip actually succeeded, and the UI never claims
 * otherwise.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, isSupabaseConfigured } from "../../lib/supabaseClient";
import {
  browserStorage,
  emptyAcademyState,
  loadGuestState,
  saveGuestState,
  syncAcademyProgress,
  type AcademyState,
  type ProgressSyncClient,
} from "../../lib/academy/progress";

export function useAcademyProgress() {
  const [state, setState] = useState<AcademyState>(() => emptyAcademyState());
  const [ready, setReady] = useState(false);
  const [synced, setSynced] = useState(false);
  const stateRef = useRef(state);
  const userIdRef = useRef<string | null>(null);
  const syncingRef = useRef(false);

  const adopt = useCallback((next: AcademyState) => {
    stateRef.current = next;
    setState(next);
    saveGuestState(browserStorage(), next);
  }, []);

  const runSync = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid || syncingRef.current || !isSupabaseConfigured()) return;
    syncingRef.current = true;
    try {
      const res = await syncAcademyProgress(
        createClient() as unknown as ProgressSyncClient,
        uid,
        stateRef.current
      );
      if (res.synced) {
        setSynced(true);
        if (JSON.stringify(res.state) !== JSON.stringify(stateRef.current)) adopt(res.state);
      }
    } catch {
      /* fail soft: guest mode continues */
    } finally {
      syncingRef.current = false;
    }
  }, [adopt]);

  useEffect(() => {
    const guest = loadGuestState(browserStorage());
    stateRef.current = guest;
    setState(guest);
    setReady(true);
    if (!isSupabaseConfigured()) return;
    const supabase = createClient();
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      userIdRef.current = data.user?.id ?? null;
      if (data.user) void runSync();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      const uid = session?.user?.id ?? null;
      const changed = uid !== userIdRef.current;
      userIdRef.current = uid;
      if (uid && changed) void runSync();
      if (!uid) setSynced(false);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [runSync]);

  /** Apply a pure state transition, persist locally, sync best-effort. */
  const update = useCallback(
    (fn: (s: AcademyState) => AcademyState) => {
      const next = fn(stateRef.current);
      if (next === stateRef.current) return;
      adopt(next);
      void runSync();
    },
    [adopt, runSync]
  );

  return { state, ready, synced, update };
}
