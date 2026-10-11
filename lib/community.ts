"use client";

import { createClient } from "./supabaseClient";

export interface CommunityRoom {
  id: string;
  name: string;
  slug: string;
  description: string;
  ticker: string | null;
  is_public: boolean;
  message_preview: boolean;
  category: string;
  created_at: string;
}

export interface CommunityMessage {
  id: string;
  room_id: string;
  user_id: string;
  content: string;
  reply_to: string | null;
  topic: string | null;
  title: string | null;
  is_edited: boolean;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
  // Joined
  author_name?: string;
  reply_preview?: string;
  reactions?: { emoji: string; count: number; reacted: boolean }[];
}

export interface CommunityMember {
  user_id: string;
  room_id: string;
  role: "member" | "moderator" | "admin";
}

/** Get display name for a user from profiles table, fallback to email prefix */
export async function getDisplayName(userId: string): Promise<string> {
  const supabase = createClient();
  const { data } = await supabase
    .from("profiles")
    .select("display_name, email")
    .eq("id", userId)
    .single();
  if (data?.display_name) return data.display_name;
  if (data?.email) return data.email.split("@")[0];
  return "Trader";
}

/** Check if current user is mod/admin of a room */
export async function isRoomMod(roomId: string): Promise<boolean> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase
    .from("community_members")
    .select("role")
    .eq("user_id", user.id)
    .eq("room_id", roomId)
    .single();
  return data?.role === "moderator" || data?.role === "admin";
}
