"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "../../../lib/supabaseClient";
import { isRoomMod, type CommunityRoom, type CommunityMessage } from "../../../lib/community";
import { topicsForRoom } from "../../../lib/community-markets";

const QUICK_REACTIONS = ["👍", "🔥", "📈", "💡"];
const PAGE_SIZE = 50;
const SEND_COOLDOWN_MS = 2000;

// ---------- SVG Icons ----------
const IconReply = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
);
const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
);
const IconBan = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
);
const IconClose = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
);
const IconSend = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
);
const IconDots = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
);
const IconBack = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
);
const IconRetry = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
);

// ---------- Helpers ----------
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function formatDateSeparator(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
function isSameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}
// Render URLs as clickable links, safely
function renderContent(content: string) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = content.split(urlRegex);
  return parts.map((part, i) =>
    urlRegex.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer"
        style={{ color: "var(--ggl-green)", textDecoration: "underline", wordBreak: "break-all" }}>
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

type MsgStatus = "sending" | "sent" | "failed";
interface UIMessage extends CommunityMessage {
  _status?: MsgStatus;
  _tempId?: string;
}

export default function CommunityRoomPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [room, setRoom] = useState<CommunityRoom | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [isMod, setIsMod] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<UIMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const nameCache = useRef<Record<string, string>>({});
  const lastSendAt = useRef<number>(0);
  const [newMsgCount, setNewMsgCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeTopic, setActiveTopic] = useState<string | null>(null);
  const activeTopicRef = useRef<string | null>(null);
  const [showDiscussionModal, setShowDiscussionModal] = useState(false);
  const [discussionTitle, setDiscussionTitle] = useState("");
  const [discussionTopic, setDiscussionTopic] = useState("");
  const [discussionBody, setDiscussionBody] = useState("");

  const isNearBottom = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  const scrollBottom = useCallback(() => {
    const el = messageListRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setNewMsgCount(0);
  }, []);

  // ---------- Data loading ----------
  const enrichMessages = useCallback(async (
    supabase: ReturnType<typeof createClient>,
    msgs: CommunityMessage[],
    currentUserId: string | null
  ): Promise<CommunityMessage[]> => {
    if (msgs.length === 0) return msgs;
    const userIds = [...new Set(msgs.map((m) => m.user_id))];
    const messageIds = msgs.map((m) => m.id);
    const replyIds = [...new Set(msgs.map((m) => m.reply_to).filter(Boolean))] as string[];

    const uncachedIds = userIds.filter((id) => !nameCache.current[id]);
    if (uncachedIds.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles").select("id, display_name, email").in("id", uncachedIds);
      for (const p of profiles ?? []) {
        nameCache.current[p.id] = p.display_name || (p.email ? p.email.split("@")[0] : null) || "Trader";
      }
      for (const id of uncachedIds) {
        if (!nameCache.current[id]) nameCache.current[id] = "Trader";
      }
    }

    let replyMap: Record<string, string> = {};
    if (replyIds.length > 0) {
      const { data: parents } = await supabase
        .from("community_messages").select("id, content").in("id", replyIds);
      for (const p of parents ?? []) replyMap[p.id] = (p.content as string).slice(0, 80);
    }

    const { data: allReacts } = await supabase
      .from("community_reactions").select("message_id, emoji, user_id").in("message_id", messageIds);
    const reactsByMsg: Record<string, Record<string, { count: number; reacted: boolean }>> = {};
    for (const r of allReacts ?? []) {
      const mid = r.message_id as string;
      if (!reactsByMsg[mid]) reactsByMsg[mid] = {};
      if (!reactsByMsg[mid][r.emoji]) reactsByMsg[mid][r.emoji] = { count: 0, reacted: false };
      reactsByMsg[mid][r.emoji].count++;
      if (r.user_id === currentUserId) reactsByMsg[mid][r.emoji].reacted = true;
    }

    for (const m of msgs) {
      m.author_name = nameCache.current[m.user_id] || "Trader";
      if (m.reply_to) m.reply_preview = replyMap[m.reply_to];
      const byEmoji = reactsByMsg[m.id] ?? {};
      m.reactions = Object.entries(byEmoji).map(([emoji, v]) => ({ emoji, ...v }));
    }
    return msgs;
  }, []);

  const loadMessages = useCallback(async (roomId: string, before?: string, topic?: string | null) => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    let query = supabase.from("community_messages")
      .select("*").eq("room_id", roomId).eq("is_deleted", false)
      .order("created_at", { ascending: false }).limit(PAGE_SIZE + 1);
    if (topic) query = query.eq("topic", topic);
    if (before) {
      const { data: beforeMsg } = await supabase
        .from("community_messages").select("created_at").eq("id", before).single();
      if (beforeMsg) query = query.lt("created_at", (beforeMsg as { created_at: string }).created_at);
    }
    const { data } = await query;
    const raw = ((data ?? []) as CommunityMessage[]).reverse();
    const hasMore = raw.length > PAGE_SIZE;
    const msgs = raw.slice(-PAGE_SIZE);
    const enriched = (await enrichMessages(supabase, msgs, user?.id ?? null)) as UIMessage[];
    enriched.forEach((m) => { m._status = "sent"; });
    if (before) {
      setMessages((prev) => [...enriched, ...prev]);
      setHasOlder(hasMore);
    } else {
      setMessages(enriched);
      setHasOlder(hasMore);
    }
    return enriched;
  }, [enrichMessages]);

  // Initial load — reset everything when switching rooms
  useEffect(() => {
    (async () => {
      // Clear immediately to prevent showing old room's messages
      setMessages([]);
      setActiveTopic(null);
      activeTopicRef.current = null;
      setNewMsgCount(0);
      setRoom(null);
      setLoading(true);
      setLoadError(false);
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        setSignedIn(!!user);
        setUserId(user?.id ?? null);
        const { data: roomData } = await supabase
          .from("community_rooms").select("*").eq("slug", slug).single();
        if (!roomData) return;
        setRoom(roomData);
        if (user) setIsMod(await isRoomMod(roomData.id));
        await loadMessages(roomData.id, undefined, null);
        setTimeout(scrollBottom, 150);
      } catch {
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Realtime
  useEffect(() => {
    if (!room) return;
    const supabase = createClient();
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const ch = supabase
      .channel(`room-${room.id}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "community_messages", filter: `room_id=eq.${room.id}` },
        async (payload) => {
          const newMsg = payload.new as CommunityMessage;
          if (newMsg.is_deleted) return;
          // Safety: ignore messages from other rooms (stale subscription race)
          if (newMsg.room_id !== room.id) return;
          // Respect topic filter — don't show messages from other topics
          const currentTopic = activeTopicRef.current;
          if (currentTopic && newMsg.topic !== currentTopic) return;
          const wasNearBottom = isNearBottom();
          const enriched = (await enrichMessages(supabase, [newMsg], userId)) as UIMessage[];
          enriched[0]._status = "sent";
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, enriched[0]];
          });
          if (wasNearBottom) {
            setTimeout(scrollBottom, 100);
          } else {
            setNewMsgCount((c) => c + 1);
          }
        })
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "community_messages", filter: `room_id=eq.${room.id}` },
        async (payload) => {
          const updated = payload.new as CommunityMessage;
          // Safety: ignore updates from other rooms
          if (updated.room_id !== room.id) return;
          if (updated.is_deleted) {
            setMessages((prev) => prev.filter((m) => m.id !== updated.id));
          } else {
            const enriched = (await enrichMessages(supabase, [updated], userId)) as UIMessage[];
            enriched[0]._status = "sent";
            setMessages((prev) => prev.map((m) => (m.id === updated.id ? enriched[0] : m)));
          }
        })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setReconnecting(false);
          if (reconnectTimer) clearTimeout(reconnectTimer);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setReconnecting(true);
        }
      });
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  // Close context menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    const close = () => setMenuOpenId(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpenId]);

  const requireAuth = () => {
    if (!signedIn) {
      sessionStorage.setItem("postLoginReturn", `/community/${slug}`);
      setShowSignIn(true);
      return false;
    }
    return true;
  };

  // ---------- Actions ----------
  const sendMessage = async (retryMsg?: UIMessage) => {
    if (!requireAuth() || !room) return;
    const content = retryMsg ? retryMsg.content : draft.trim();
    if (!content || sending) return;

    const now = Date.now();
    if (!retryMsg && now - lastSendAt.current < SEND_COOLDOWN_MS) {
      setError("Please wait a moment before sending another message.");
      return;
    }
    lastSendAt.current = now;
    setSending(true);
    setError(null);

    const tempId = retryMsg?._tempId || `temp-${now}-${Math.random().toString(36).slice(2)}`;
    const optimistic = (retryMsg || {
      id: tempId, _tempId: tempId, _status: "sending",
      room_id: room.id, user_id: userId || "", content,
      reply_to: replyTo?.id ?? null,
      topic: activeTopic, title: null,
      reply_preview: replyTo ? replyTo.content.slice(0, 80) : undefined,
      author_name: nameCache.current[userId || ""] || "You",
      created_at: new Date().toISOString(),
      reactions: [],
      is_edited: false, is_deleted: false,
      updated_at: new Date().toISOString(),
    }) as UIMessage;

    if (!retryMsg) {
      optimistic._status = "sending";
      setMessages((prev) => [...prev, optimistic]);
      setDraft("");
      setReplyTo(null);
      setTimeout(scrollBottom, 50);
      // Reset textarea height
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } else {
      setMessages((prev) => prev.map((m) => (m._tempId === tempId ? { ...m, _status: "sending" as MsgStatus } : m)));
    }

    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const displayName = user.user_metadata?.display_name as string | undefined;
      if (displayName) {
        await supabase.from("profiles")
          .upsert({ id: user.id, email: user.email, display_name: displayName }, { onConflict: "id" });
      }
      const { data: inserted, error } = await supabase.from("community_messages").insert({
        room_id: room.id, user_id: user.id, content,
        reply_to: retryMsg ? retryMsg.reply_to : replyTo?.id ?? null,
        topic: retryMsg ? (retryMsg as UIMessage).topic ?? null : activeTopic,
        title: retryMsg ? (retryMsg as UIMessage).title ?? null : null,
      }).select().single();
      if (error) throw new Error(error.message);
      // Replace optimistic with confirmed
      const enriched = (await enrichMessages(supabase, [inserted as CommunityMessage], user.id)) as UIMessage[];
      enriched[0]._status = "sent";
      setMessages((prev) => prev.map((m) =>
        (m._tempId === tempId || m.id === tempId) ? enriched[0] : m
      ));
    } catch (e) {
      setMessages((prev) => prev.map((m) =>
        (m._tempId === tempId || m.id === tempId)
          ? { ...m, _status: "failed" as MsgStatus }
          : m
      ));
      setError(e instanceof Error ? e.message : "Failed to send.");
    } finally {
      setSending(false);
    }
  };

  const startDiscussion = async () => {
    if (!requireAuth() || !room || !userId) return;
    const title = discussionTitle.trim();
    const body = discussionBody.trim();
    if (!title || !body) {
      setError("Please add both a title and message.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      // Server validates room_id — user cannot post to another market
      const { data: inserted, error } = await supabase.from("community_messages").insert({
        room_id: room.id, // locked to current market room
        user_id: user.id,
        content: body,
        title,
        topic: discussionTopic || null,
      }).select().single();
      if (error) throw new Error(error.message);
      const enriched = (await enrichMessages(supabase, [inserted as CommunityMessage], user.id)) as UIMessage[];
      enriched[0]._status = "sent";
      // Only show if it matches the active topic filter
      if (!activeTopic || activeTopic === (discussionTopic || null)) {
        setMessages((prev) => [...prev, enriched[0]]);
      }
      setShowDiscussionModal(false);
      setDiscussionTitle("");
      setDiscussionTopic("");
      setDiscussionBody("");
      setTimeout(scrollBottom, 100);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start discussion.");
    } finally {
      setSending(false);
    }
  };

  const toggleReaction = async (msg: UIMessage, emoji: string) => {
    if (!requireAuth() || !userId) return;
    const supabase = createClient();
    const { data: deleted } = await supabase.from("community_reactions")
      .delete().eq("message_id", msg.id).eq("user_id", userId).eq("emoji", emoji).select("id");
    if (!deleted || deleted.length === 0) {
      const { error } = await supabase.from("community_reactions")
        .insert({ message_id: msg.id, user_id: userId, emoji });
      if (error && !error.message.includes("duplicate")) { setError(error.message); return; }
    }
    const { data: reacts } = await supabase
      .from("community_reactions").select("emoji, user_id").eq("message_id", msg.id);
    const byEmoji: Record<string, { count: number; reacted: boolean }> = {};
    for (const r of reacts ?? []) {
      if (!byEmoji[r.emoji]) byEmoji[r.emoji] = { count: 0, reacted: false };
      byEmoji[r.emoji].count++;
      if (r.user_id === userId) byEmoji[r.emoji].reacted = true;
    }
    const newReactions = Object.entries(byEmoji).map(([e, v]) => ({ emoji: e, ...v }));
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, reactions: newReactions } : m)));
  };

  const deleteMessage = async (msg: UIMessage) => {
    if (!room) return;
    setMenuOpenId(null);
    if (!confirm("Delete this message?")) return;
    const supabase = createClient();
    await supabase.from("community_messages")
      .update({ is_deleted: true, updated_at: new Date().toISOString() }).eq("id", msg.id);
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
  };

  const banUser = async (msg: UIMessage) => {
    if (!room || !isMod) return;
    setMenuOpenId(null);
    const reason = prompt(`Ban ${msg.author_name} from this room? Enter a reason (or leave blank):`);
    if (reason === null) return;
    const supabase = createClient();
    const { error } = await supabase.from("community_bans").insert({
      user_id: msg.user_id, room_id: room.id,
      reason: reason || "No reason given", banned_by: userId,
    });
    if (error) setError(error.message);
    else await deleteMessage(msg);
  };

  const changeTopic = async (topic: string | null) => {
    if (!room || topic === activeTopic) return;
    setActiveTopic(topic);
    activeTopicRef.current = topic;
    setMessages([]);
    setNewMsgCount(0);
    await loadMessages(room.id, undefined, topic);
    setTimeout(scrollBottom, 150);
  };

  const loadOlder = async () => {
    if (!room || loadingOlder || messages.length === 0) return;
    const listEl = messageListRef.current;
    const prevScrollHeight = listEl?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      const oldest = messages.find((m) => !m._tempId && m._status !== "sending");
      if (oldest) await loadMessages(room.id, oldest.id, activeTopic);
      // Preserve scroll position after prepending
      requestAnimationFrame(() => {
        if (listEl) {
          listEl.scrollTop = listEl.scrollHeight - prevScrollHeight;
        }
      });
    } finally {
      setLoadingOlder(false);
    }
  };

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  // ---------- Render ----------
  if (loading) {
    return (
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 16px", color: "var(--ggl-muted)", textAlign: "center" }}>
        <div style={{ fontSize: 14 }}>Loading conversation…</div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Couldn't load the conversation</div>
        <div style={{ color: "var(--ggl-muted)", fontSize: 14, marginBottom: 16 }}>
          Check your connection and try again.
        </div>
        <button onClick={() => window.location.reload()}
          style={{ padding: "10px 24px", borderRadius: 10, cursor: "pointer", border: "none",
            background: "#42d879", color: "#06110b", fontSize: 14, fontWeight: 700 }}>
          Retry
        </button>
      </div>
    );
  }
  if (!room) {
    return (
      <div style={{ maxWidth: 760, margin: "0 auto", padding: 48, textAlign: "center" }}>
        <h1 style={{ fontSize: 20 }}>Room not found</h1>
        <Link href="/community" className="ggl-btn ggl-btn-outline">Back to Community</Link>
      </div>
    );
  }

  // Group consecutive messages from same user (within 5 min)
  const grouped: { msg: UIMessage; showHeader: boolean; showDate: boolean }[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const showDate = !prev || !isSameDay(prev.created_at, m.created_at);
    const showHeader = showDate || !prev || prev.user_id !== m.user_id ||
      (new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() > 5 * 60 * 1000);
    grouped.push({ msg: m, showHeader, showDate });
  });

  // Admin-only rooms (e.g. Announcements): signed-in non-mods can read but not post.
  const postingLocked = !!room.admin_only_posting && signedIn && !isMod;

  return (
    <div className="community-room-container" style={{
      maxWidth: 760, margin: "0 auto",
      height: "100dvh", display: "flex", flexDirection: "column",
      background: "#0a0e11", overflow: "hidden",
      boxSizing: "border-box", position: "relative",
    }}>
      {/* Compact room header */}
      <div style={{
        flexShrink: 0, zIndex: 20,
        background: "rgba(10,14,17,0.96)", backdropFilter: "blur(8px)",
        borderBottom: "1px solid rgba(255,255,255,0.07)",
        padding: "10px 12px",
        display: "flex", alignItems: "center", gap: 10,
        minWidth: 0, boxSizing: "border-box",
      }}>
        <Link href="/community" aria-label="Back to rooms"
          style={{ color: "var(--ggl-muted)", display: "flex", padding: 6, borderRadius: 8 }}>
          <IconBack />
        </Link>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {room.ticker ? `$${room.ticker} ` : "# "}{room.name}
          </div>
          {room.description && (
            <div style={{ fontSize: 11, color: "var(--ggl-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {room.description}
            </div>
          )}
        </div>
        {reconnecting && (
          <span style={{ fontSize: 11, color: "#fbbf24" }}>Reconnecting…</span>
        )}
        {signedIn && !postingLocked && (
          <button
            onClick={() => setShowDiscussionModal(true)}
            style={{
              flexShrink: 0, padding: "7px 14px", borderRadius: 16, cursor: "pointer",
              background: "rgba(66,216,121,0.12)", border: "1px solid rgba(66,216,121,0.3)",
              color: "#42d879", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
            }}
          >
            + Start Discussion
          </button>
        )}
      </div>

      {/* Topic filters */}
      {topicsForRoom(slug).length > 0 && (
        <div style={{
          flexShrink: 0, display: "flex", gap: 8, padding: "8px 12px",
          overflowX: "auto", borderBottom: "1px solid rgba(255,255,255,0.06)",
          background: "rgba(10,14,17,0.9)", scrollbarWidth: "none",
        }}>
          <button
            onClick={() => changeTopic(null)}
            style={{
              flexShrink: 0, padding: "6px 14px", borderRadius: 14, cursor: "pointer",
              fontSize: 12, fontWeight: activeTopic === null ? 700 : 400,
              background: activeTopic === null ? "rgba(66,216,121,0.15)" : "rgba(255,255,255,0.04)",
              border: activeTopic === null ? "1px solid rgba(66,216,121,0.4)" : "1px solid rgba(255,255,255,0.08)",
              color: activeTopic === null ? "#42d879" : "var(--ggl-muted)",
            }}
          >
            All Discussions
          </button>
          {topicsForRoom(slug).map((t) => (
            <button
              key={t.value}
              onClick={() => changeTopic(t.value)}
              style={{
                flexShrink: 0, padding: "6px 14px", borderRadius: 14, cursor: "pointer",
                fontSize: 12, fontWeight: activeTopic === t.value ? 700 : 400,
                background: activeTopic === t.value ? "rgba(66,216,121,0.15)" : "rgba(255,255,255,0.04)",
                border: activeTopic === t.value ? "1px solid rgba(66,216,121,0.4)" : "1px solid rgba(255,255,255,0.08)",
                color: activeTopic === t.value ? "#42d879" : "var(--ggl-muted)",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Messages — scrolls internally, never expands page */}
      <div ref={messageListRef} style={{
        flex: 1, minHeight: 0, minWidth: 0,
        overflowY: "auto", overflowX: "hidden",
        padding: "12px 12px 8px",
        display: "flex", flexDirection: "column", gap: 2,
        boxSizing: "border-box",
        WebkitOverflowScrolling: "touch",
      }}>
        {hasOlder && (
          <button onClick={loadOlder} disabled={loadingOlder}
            style={{
              alignSelf: "center", padding: "6px 16px", borderRadius: 16, cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.03)",
              color: "var(--ggl-muted)", fontSize: 12, marginBottom: 8,
            }}>
            {loadingOlder ? "Loading…" : "Load older messages"}
          </button>
        )}
        {messages.length === 0 && (
          <div style={{ color: "var(--ggl-muted)", textAlign: "center", padding: "48px 16px", fontSize: 14 }}>
            {activeTopic ? (
              <>No discussions in <strong style={{ color: "var(--ggl-text)" }}>{activeTopic}</strong> yet.<br /></>
            ) : (
              <>No messages yet.<br /></>
            )}
            {signedIn
              ? (activeTopic
                  ? `Start the first discussion in ${activeTopic} below.`
                  : `Start the first discussion in ${room?.name ?? "this market"}.`)
              : "Sign in to start the conversation."}
          </div>
        )}
        {grouped.map(({ msg: m, showHeader, showDate }) => (
          <div key={m._tempId || m.id}>
            {showDate && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "14px 0 8px" }}>
                <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
                <span style={{ fontSize: 11, color: "var(--ggl-muted)", fontWeight: 600 }}>{formatDateSeparator(m.created_at)}</span>
                <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
              </div>
            )}
            <div style={{
              padding: showHeader ? "8px 10px 6px" : "2px 10px 2px",
              borderRadius: 8,
              background: m._status === "failed" ? "rgba(248,113,113,0.05)" : "transparent",
              position: "relative",
              minWidth: 0, overflowWrap: "break-word", wordBreak: "break-word",
              boxSizing: "border-box",
            }}>
              {showHeader && (
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: m.user_id === userId ? "var(--ggl-green)" : "var(--ggl-text)" }}>
                    {m.author_name}
                  </span>
                  {m.topic && (
                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 8, background: "rgba(66,216,121,0.1)", color: "#42d879", fontWeight: 600 }}>
                      {m.topic}
                    </span>
                  )}
                  <span style={{ color: "var(--ggl-muted)", fontSize: 10 }}>{formatTime(m.created_at)}</span>
                  {m.is_edited && <span style={{ color: "var(--ggl-muted)", fontSize: 10 }}>(edited)</span>}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 2, position: "relative" }}>
                    {signedIn && m._status === "sent" && (
                      <button onClick={(e) => { e.stopPropagation(); setReplyTo(m); }}
                        aria-label="Reply" title="Reply"
                        style={{ background: "none", border: "none", color: "var(--ggl-muted)", cursor: "pointer", padding: 4, borderRadius: 4, display: "flex" }}>
                        <IconReply />
                      </button>
                    )}
                    {(isMod || m.user_id === userId) && m._status === "sent" && (
                      <button onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === m.id ? null : (m._tempId || m.id)); }}
                        aria-label="Message options" title="Options"
                        style={{ background: "none", border: "none", color: "var(--ggl-muted)", cursor: "pointer", padding: 4, borderRadius: 4, display: "flex" }}>
                        <IconDots />
                      </button>
                    )}
                    {menuOpenId === (m._tempId || m.id) && (
                      <div onClick={(e) => e.stopPropagation()} style={{
                        position: "absolute", right: 0, top: 24, zIndex: 30,
                        background: "#141a20", border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 8, padding: 4, minWidth: 140,
                        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                      }}>
                        <button onClick={() => deleteMessage(m)}
                          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px", background: "none", border: "none", color: "var(--ggl-text)", fontSize: 13, cursor: "pointer", borderRadius: 4 }}>
                          <IconTrash /> Delete
                        </button>
                        {isMod && m.user_id !== userId && (
                          <button onClick={() => banUser(m)}
                            style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px", background: "none", border: "none", color: "#f87171", fontSize: 13, cursor: "pointer", borderRadius: 4 }}>
                            <IconBan /> Ban user
                          </button>
                        )}
                      </div>
                    )}
                  </span>
                </div>
              )}
              {m.reply_to && m.reply_preview && (
                <div style={{ fontSize: 11, color: "var(--ggl-muted)", borderLeft: "2px solid var(--ggl-green)", paddingLeft: 8, marginBottom: 4 }}>
                  {m.reply_preview}…
                </div>
              )}
              <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: m._status === "sending" ? 0.6 : 1 }}>
                {m.title && (
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4, color: "var(--ggl-text)" }}>
                    {m.title}
                  </div>
                )}
                {renderContent(m.content)}
              </div>
              {/* Status / retry */}
              {m._status === "sending" && (
                <div style={{ fontSize: 10, color: "var(--ggl-muted)", marginTop: 2 }}>Sending…</div>
              )}
              {m._status === "failed" && (
                <button onClick={() => sendMessage(m)}
                  style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, background: "none", border: "1px solid rgba(248,113,113,0.3)", color: "#f87171", fontSize: 11, padding: "4px 10px", borderRadius: 12, cursor: "pointer" }}>
                  <IconRetry /> Failed — tap to retry
                </button>
              )}
              {/* Reactions */}
              {m._status === "sent" && ((m.reactions?.length ?? 0) > 0 || signedIn) && (
                <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                  {m.reactions?.map((r) => (
                    <button key={r.emoji} onClick={() => toggleReaction(m, r.emoji)}
                      aria-label={`React ${r.emoji}`}
                      style={{
                        fontSize: 12, padding: "3px 9px", borderRadius: 14, cursor: "pointer",
                        border: r.reacted ? "1px solid rgba(66,216,121,0.5)" : "1px solid rgba(255,255,255,0.1)",
                        background: r.reacted ? "rgba(66,216,121,0.12)" : "rgba(255,255,255,0.04)",
                        color: "var(--ggl-text)", display: "flex", alignItems: "center", gap: 4,
                      }}>
                      <span>{r.emoji}</span><span style={{ fontSize: 11, opacity: 0.8 }}>{r.count}</span>
                    </button>
                  ))}
                  {signedIn && QUICK_REACTIONS.filter((e) => !m.reactions?.some((r) => r.emoji === e)).slice(0, 2).map((e) => (
                    <button key={e} onClick={() => toggleReaction(m, e)} aria-label={`Add ${e} reaction`} title="React"
                      style={{ fontSize: 12, padding: "3px 9px", borderRadius: 14, cursor: "pointer", border: "1px solid rgba(255,255,255,0.07)", background: "transparent", opacity: 0.45 }}>
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} style={{ height: 8 }} />
      </div>

      {/* New messages indicator */}
      {newMsgCount > 0 && (
        <button onClick={scrollBottom}
          style={{
            position: "absolute", bottom: 90, left: "50%", transform: "translateX(-50%)",
            zIndex: 25, padding: "8px 16px", borderRadius: 20, cursor: "pointer",
            background: "var(--ggl-green)", color: "#06110b", border: "none",
            fontSize: 12, fontWeight: 700,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}>
          ↓ {newMsgCount} new message{newMsgCount > 1 ? "s" : ""}
        </button>
      )}

      {/* Composer — fixed at bottom of flex column */}
      <div style={{
        flexShrink: 0, zIndex: 20,
        background: "rgba(10,14,17,0.97)", backdropFilter: "blur(8px)",
        borderTop: "1px solid rgba(255,255,255,0.07)",
        padding: "10px 12px calc(10px + env(safe-area-inset-bottom))",
        boxSizing: "border-box", minWidth: 0,
      }}>
        {replyTo && (
          <div style={{ fontSize: 12, color: "var(--ggl-muted)", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(255,255,255,0.03)", padding: "6px 10px", borderRadius: 8 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Replying to <strong>{replyTo.author_name}</strong>
            </span>
            <button onClick={() => setReplyTo(null)} aria-label="Cancel reply"
              style={{ background: "none", border: "none", color: "var(--ggl-muted)", cursor: "pointer", padding: 4, display: "flex" }}>
              <IconClose />
            </button>
          </div>
        )}
        {error && <div style={{ color: "#f87171", fontSize: 12, marginBottom: 8 }}>{error}</div>}
        {postingLocked ? (
          <div style={{
            textAlign: "center", padding: "10px 16px", borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)",
            color: "var(--ggl-muted)", fontSize: 13,
          }}>
            📢 This room is for official announcements — only admins can post here.
          </div>
        ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={handleInput}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
            }}
            onFocus={() => { if (!signedIn) requireAuth(); }}
            placeholder={signedIn ? "Message…" : "Sign in to join the conversation…"}
            maxLength={2000}
            rows={1}
            aria-label="Message input"
            className="ggl-chat-input"
            style={{
              flex: 1, minWidth: 0, padding: "10px 16px", borderRadius: 22,
              border: "1px solid rgba(255,255,255,0.1)", background: "#1a2129",
              color: "#fff", fontSize: 16, resize: "none",
              maxHeight: 120, lineHeight: 1.4, fontFamily: "inherit",
              outline: "none", boxSizing: "border-box",
            }}
            onFocusCapture={(e) => {
              if (!signedIn) requireAuth();
              (e.target as HTMLTextAreaElement).style.borderColor = "rgba(66,216,121,0.4)";
            }}
            onBlurCapture={(e) => {
              (e.target as HTMLTextAreaElement).style.borderColor = "rgba(255,255,255,0.1)";
            }}
          />
          <button onClick={() => sendMessage()} disabled={sending || !draft.trim()}
            aria-label="Send message"
            style={{
              width: 40, height: 40, borderRadius: "50%", flexShrink: 0,
              border: "none", cursor: draft.trim() && !sending ? "pointer" : "default",
              background: draft.trim() && !sending ? "var(--ggl-green)" : "rgba(255,255,255,0.08)",
              color: draft.trim() && !sending ? "#06110b" : "var(--ggl-muted)",
              display: "flex", alignItems: "center", justifyContent: "center",
              opacity: sending ? 0.6 : 1,
            }}>
            <IconSend />
          </button>
        </div>
        )}
      </div>

      {/* Start Discussion modal */}
      {showDiscussionModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}
          onClick={() => setShowDiscussionModal(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#0d1319", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, padding: 24, width: "100%", maxWidth: 480, boxSizing: "border-box" }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 4px" }}>Start a Discussion</h2>
            <p style={{ color: "var(--ggl-muted)", fontSize: 13, margin: "0 0 16px" }}>
              Posting in <strong style={{ color: "var(--ggl-text)" }}>#{room?.name}</strong>
            </p>
            <input
              value={discussionTitle}
              onChange={(e) => setDiscussionTitle(e.target.value)}
              placeholder="Discussion title…"
              maxLength={200}
              aria-label="Discussion title"
              style={{
                width: "100%", padding: "10px 14px", borderRadius: 10, marginBottom: 12,
                border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)",
                color: "#fff", fontSize: 15, outline: "none", boxSizing: "border-box",
              }}
            />
            {topicsForRoom(slug).length > 0 && (
              <select
                value={discussionTopic}
                onChange={(e) => setDiscussionTopic(e.target.value)}
                aria-label="Topic"
                style={{
                  width: "100%", padding: "10px 14px", borderRadius: 10, marginBottom: 12,
                  border: "1px solid rgba(255,255,255,0.1)", background: "#1a2129",
                  color: "#fff", fontSize: 15, outline: "none", boxSizing: "border-box",
                }}
              >
                <option value="">No specific topic</option>
                {topicsForRoom(slug).map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            )}
            <textarea
              value={discussionBody}
              onChange={(e) => setDiscussionBody(e.target.value)}
              placeholder="Share your thoughts, analysis, or question…"
              rows={4}
              maxLength={2000}
              aria-label="Discussion message"
              style={{
                width: "100%", padding: "10px 14px", borderRadius: 10, marginBottom: 16,
                border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)",
                color: "#fff", fontSize: 15, outline: "none", resize: "vertical",
                boxSizing: "border-box", fontFamily: "inherit",
              }}
            />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setShowDiscussionModal(false)}
                style={{ padding: "10px 18px", borderRadius: 10, cursor: "pointer", background: "none", border: "1px solid rgba(255,255,255,0.12)", color: "var(--ggl-muted)", fontSize: 14 }}>
                Cancel
              </button>
              <button onClick={startDiscussion} disabled={sending || !discussionTitle.trim() || !discussionBody.trim()}
                style={{
                  padding: "10px 20px", borderRadius: 10, cursor: "pointer", border: "none",
                  background: sending || !discussionTitle.trim() || !discussionBody.trim() ? "rgba(66,216,121,0.2)" : "#42d879",
                  color: "#06110b", fontSize: 14, fontWeight: 700,
                }}>
                {sending ? "Posting…" : "Post Discussion"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sign-in modal */}
      {showSignIn && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}
          onClick={() => setShowSignIn(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#0d1319", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, padding: 28, maxWidth: 380, textAlign: "center" }}>
            <h2 style={{ fontSize: 19, fontWeight: 800, margin: "0 0 8px" }}>Join the conversation</h2>
            <p style={{ color: "var(--ggl-muted)", fontSize: 14, margin: "0 0 20px", lineHeight: 1.5 }}>
              Sign in to send messages, reply, and react.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <Link href={`/login?next=/community/${slug}`} className="ggl-btn ggl-btn-outline">Sign In</Link>
              <Link href={`/login?mode=signup&next=/community/${slug}`} className="ggl-btn ggl-btn-primary">Create Account</Link>
            </div>
            <button onClick={() => setShowSignIn(false)}
              style={{ marginTop: 14, background: "none", border: "none", color: "var(--ggl-muted)", cursor: "pointer", fontSize: 13 }}>
              Maybe later
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
