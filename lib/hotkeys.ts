/**
 * hotkeys.ts — Trading hotkey definitions.
 * Phase A1: hardcoded defaults. Phase A2 will add customization.
 */

export type HotkeyAction =
  | "buy"
  | "exit"
  | "cancelOrders"
  | "playPause"
  | "stepForward"
  | "speed05"
  | "speed1"
  | "speed2"
  | "speed4"
  | "speed8";

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  buy: "b",
  exit: "x",
  cancelOrders: "c",
  playPause: " ",
  stepForward: "ArrowRight",
  speed05: "1",
  speed1: "2",
  speed2: "3",
  speed4: "4",
  speed8: "5",
};

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  buy: "Buy market",
  exit: "Exit position",
  cancelOrders: "Cancel all orders",
  playPause: "Play / pause",
  stepForward: "Step forward 1 candle",
  speed05: "Speed 0.5x",
  speed1: "Speed 1x",
  speed2: "Speed 2x",
  speed4: "Speed 4x",
  speed8: "Speed 8x",
};

/** True if the key event target is a text input (don't trigger hotkeys). */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return (
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" ||
    t.isContentEditable
  );
}

/** Display-friendly key name. */
export function prettyKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "ArrowRight") return "→";
  if (key === "ArrowLeft") return "←";
  return key.toUpperCase();
}
