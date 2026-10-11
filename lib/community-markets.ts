// Market-based Chat Area configuration
// Topics are lightweight message labels — not separate rooms.

export interface MarketTopic {
  label: string;
  value: string; // stored in community_messages.topic
}

export interface MarketRoom {
  slug: string;
  name: string;
  description: string;
  category: "markets" | "community";
  topics: MarketTopic[];
}

const T = (label: string): MarketTopic => ({ label, value: label });

export const MARKET_TOPICS: Record<string, MarketTopic[]> = {
  "penny-stocks": [
    T("HOD Breakouts"),
    T("Premarket"),
    T("VWAP Pullbacks"),
    T("Low Float"),
    T("Trade Reviews"),
  ],
  "stock-market": [
    T("Technical Analysis"),
    T("Earnings"),
    T("Swing Trading"),
    T("Market Trends"),
  ],
  "options-trading": [
    T("Calls & Puts"),
    T("Options Strategies"),
    T("Greeks"),
    T("Expiration"),
    T("Risk Management"),
  ],
  "futures-trading": [
    T("Index Futures"),
    T("Price Action"),
    T("Scalping"),
    T("Risk Management"),
  ],
  "forex": [
    T("Currency Pairs"),
    T("Technical Analysis"),
    T("Economic Events"),
  ],
  "crypto": [
    T("Bitcoin"),
    T("Altcoins"),
    T("Technical Analysis"),
    T("Market Trends"),
  ],
  // Community rooms get a single default view
  "trading-psychology": [],
  "trading-education": [],
  "beginners": [],
  "general": [],
  "general-discussion": [],
  "premarket": [T("Premarket")],
  "announcements": [],
};

export function topicsForRoom(slug: string): MarketTopic[] {
  return MARKET_TOPICS[slug] ?? [];
}
