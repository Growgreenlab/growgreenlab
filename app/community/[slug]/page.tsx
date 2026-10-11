"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "../../../lib/supabaseClient";
import { getDisplayName, isRoomMod, type CommunityRoom, type CommunityMessage } from "../../../lib/community";

const QUICK_REACTIONS = ["👍", "🔥", "📈", "💡"];

export default function CommunityRoomPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [room, setRoom] = useState<CommunityRoom | null>(null);
  const [messages, setMessages] = useState<CommunityMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [isMod, setIsMod] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<CommunityMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nameCache = useRef<Record<string, string>>({});

  const scrollBottom = () => bottomRef.current?.scrollIntoView({ behavior: "smooth" });

  // Load room + messages + auth state
  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      setSignedIn(!!user);
      setUserId(user?.id ?? null);

      const { data: roomData } = await supabase
        .from("community_rooms")
        .select("*")
        .eq("slug", slug)
        .single();
      if (!roomData) { setLoading(false); return; }
      setRoom(roomData);
      if (user) setIsMod(await isRoomMod(roomData.id));

      await loadMessages(roomData.id);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const loadMessages = async (roomId: string) => {
    const supabase = createClient();
    const { data } = await supabase
      .from("community_messages")
      .select("*")
      .eq("room_id", roomId)
      .eq("is_deleted", false)
      .order("created_at", { ascending: true })
      .limit(200);
    const msgs = (data ?? []) as CommunityMessage[];
    // Resolve author names + reactions
    for (const m of msgs) {
      if (!nameCache.current[m.user_id]) {
        nameCache.current[m.user_id] = await getDisplayName(m.user_id);
      }
      m.author_name = nameCache.current[m.user_id];
      if (m.reply_to) {
        const { data: parent } = await supabase
          .from("community_messages")
          .select("content")
          .eq("id", m.reply_to)
          .single();
        m.reply_preview = parent?.content?.slice(0, 80);
      }
      const { data: reacts } = await supabase
        .from("community_reactions")
        .select("emoji, user_id")
        .eq("message_id", m.id);
      const byEmoji: Record<string, { count: number; reacted: boolean }> = {};
      for (const r of reacts ?? []) {
        if (!byEmoji[r.emoji]) byEmoji[r.emoji] = { count: 0, reacted: false };
        byEmoji[r.emoji].count++;
        const { data: { user } } = await supabase.auth.getUser();
        if (r.user_id === user?.id) byEmoji[r.emoji].reacted = true;
      }
      m.reactions = Object.entries(byEmoji).map(([emoji, v]) => ({ emoji, ...v }));
    }
    setMessages(msgs);
    setTimeout(scrollBottom, 100);
  };

  // Realtime subscription
  useEffect(() => {
    if (!room) return;
    const supabase = createClient();
    const ch = supabase
      .channel(`room-${room.id}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "community_messages",
        filter: `room_id=eq.${room.id}`,
      }, () => loadMessages(room.id))
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "community_messages",
        filter: `room_id=eq.${room.id}`,
      }, () => loadMessages(room.id))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  const requireAuth = () => {
    if (!signedIn) {
      // Save return path so login redirects back to this room
      sessionStorage.setItem("postLoginReturn", `/community/${slug}`);
      setShowSignIn(true);
      return false;
    }
    return true;
  };

  const sendMessage = async () => {
    if (!requireAuth() || !room || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const { error } = await supabase.from("community_messages").insert({
        room_id: room.id,
        user_id: user.id,
        content: draft.trim(),
        reply_to: replyTo?.id ?? null,
      });
      if (error) throw new Error(error.message);
      setDraft("");
      setReplyTo(null);
      await loadMessages(room.id);
      scrollBottom();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send.");
    } finally {
      setSending(false);
    }
  };

  const toggleReaction = async (msg: CommunityMessage, emoji: string) => {
    if (!requireAuth() || !userId) return;
    const supabase = createClient();
    const existing = msg.reactions?.find((r) => r.emoji === emoji && r.reacted);
    if (existing) {
      await supabase.from("community_reactions")
        .delete()
        .eq("message_id", msg.id)
        .eq("user_id", userId)
        .eq("emoji", emoji);
    } else {
      const { error } = await supabase.from("community_reactions").insert({
        message_id: msg.id, user_id: userId, emoji,
      });
      if (error) { setError(error.message); return; }
    }
    if (room) await loadMessages(room.id);
  };

  const deleteMessage = async (msg: CommunityMessage) => {
    if (!room) return;
    if (!confirm("Delete this message?")) return;
    const supabase = createClient();
    // Soft delete so replies don't break
    await supabase.from("community_messages")
      .update({ is_deleted: true, updated_at: new Date().toISOString() })
      .eq("id", msg.id);
    await loadMessages(room.id);
  };

  if (loading) {
    return <div style={{ maxWidth: 800, margin: "0 auto", padding: 48, color: "var(--ggl-muted)" }}>Loading…</div>;
  }
  if (!room) {
    return (
      <div style={{ maxWidth: 800, margin: "0 auto", padding: 48, textAlign: "center" }}>
        <h1>Room not found</h1>
        <Link href="/community" className="ggl-btn ggl-btn-outline">Back to Community</Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "24px 16px 120px", minHeight: "80vh", display: "flex", flexDirection: "column" }}>
      <div style={{ marginBottom: 16 }}>
        <Link href="/community" style={{ color: "var(--ggl-muted)", fontSize: 13, textDecoration: "none" }}>← All rooms</Link>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: "8px 0 4px" }}>
          {room.ticker ? `$${room.ticker} ` : "# "}{room.name}
        </h1>
        {room.description && <p style={{ color: "var(--ggl-muted)", fontSize: 14, margin: 0 }}>{room.description}</p>}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
        {messages.length === 0 && (
          <p style={{ color: "var(--ggl-muted)", textAlign: "center", padding: 32 }}>
            No messages yet. {signedIn ? "Start the conversation!" : "Sign in to start the conversation."}
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} style={{
            background: "rgba(255,255,255,0.02)", border: "1px solid var(--ggl-border)",
            borderRadius: 10, padding: "12px 14px",
          }}>
            {m.reply_to && m.reply_preview && (
              <div style={{ fontSize: 12, color: "var(--ggl-muted)", borderLeft: "2px solid var(--ggl-green)",
                paddingLeft: 8, marginBottom: 6 }}>
                ↩ {m.reply_preview}…
              </div>
            )}
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{m.author_name}</span>
              <span style={{ color: "var(--ggl-muted)", fontSize: 11 }}>
                {new Date(m.created_at).toLocaleString()}
                {m.is_edited && " (edited)"}
              </span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                {signedIn && (
                  <button onClick={() => setReplyTo(m)} title="Reply"
                    style={{ background: "none", border: "none", color: "var(--ggl-muted)", cursor: "pointer", fontSize: 13 }}>↩</button>
                )}
                {(isMod || m.user_id === userId) && (
                  <button onClick={() => deleteMessage(m)} title="Delete"
                    style={{ background: "none", border: "none", color: "var(--ggl-muted)", cursor: "pointer", fontSize: 13 }}>🗑</button>
                )}
              </span>
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{m.content}</div>
            {/* Reactions */}
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {m.reactions?.map((r) => (
                <button key={r.emoji} onClick={() => toggleReaction(m, r.emoji)}
                  style={{
                    fontSize: 13, padding: "2px 8px", borderRadius: 12, cursor: "pointer",
                    border: r.reacted ? "1px solid var(--ggl-green)" : "1px solid var(--ggl-border)",
                    background: r.reacted ? "rgba(66,216,121,0.1)" : "transparent",
                    color: "var(--ggl-text)",
                  }}>
                  {r.emoji} {r.count}
                </button>
              ))}
              {signedIn && QUICK_REACTIONS.filter(e => !m.reactions?.some(r => r.emoji === e)).slice(0, 2).map((e) => (
                <button key={e} onClick={() => toggleReaction(m, e)} title="React"
                  style={{ fontSize: 13, padding: "2px 8px", borderRadius: 12, cursor: "pointer",
                    border: "1px dashed var(--ggl-border)", background: "transparent", opacity: 0.5 }}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        background: "rgba(6,10,12,0.95)", backdropFilter: "blur(8px)",
        borderTop: "1px solid var(--ggl-border)", padding: "12px 16px",
      }}>
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          {replyTo && (
            <div style={{ fontSize: 12, color: "var(--ggl-muted)", marginBottom: 8,
              display: "flex", justifyContent: "space-between" }}>
              <span>↩ Replying to {replyTo.author_name}</span>
              <button onClick={() => setReplyTo(null)} style={{ background: "none", border: "none", color: "var(--ggl-muted)", cursor: "pointer" }}>✕</button>
            </div>
          )}
          {error && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 8 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              onFocus={() => { if (!signedIn) requireAuth(); }}
              placeholder={signedIn ? "Share your thoughts…" : "Sign in to join the conversation…"}
              maxLength={2000}
              style={{
                flex: 1, padding: "10px 14px", borderRadius: 8,
                border: "1px solid var(--ggl-border)", background: "rgba(255,255,255,0.03)",
                color: "var(--ggl-text)", fontSize: 14,
              }}
            />
            <button onClick={sendMessage} disabled={sending || !draft.trim()}
              className="ggl-btn ggl-btn-primary" style={{ flexShrink: 0 }}>
              {sending ? "…" : "Send"}
            </button>
          </div>
        </div>
      </div>

      {/* Sign-in prompt modal */}
      {showSignIn && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
          padding: 20,
        }} onClick={() => setShowSignIn(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "#0d1319", border: "1px solid var(--ggl-border)", borderRadius: 16,
            padding: 32, maxWidth: 400, textAlign: "center",
          }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Join the conversation</h2>
            <p style={{ color: "var(--ggl-muted)", fontSize: 14, margin: "0 0 24px", lineHeight: 1.5 }}>
              Sign in to send messages, reply, and react in the Grow Green Lab community.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <Link href={`/login?next=/community/${slug}`} className="ggl-btn ggl-btn-outline">Sign In</Link>
              <Link href={`/login?mode=signup&next=/community/${slug}`} className="ggl-btn ggl-btn-primary">Create Account</Link>
            </div>
            <button onClick={() => setShowSignIn(false)}
              style={{ marginTop: 16, background: "none", border: "none", color: "var(--ggl-muted)", cursor: "pointer", fontSize: 13 }}>
              Maybe later
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
