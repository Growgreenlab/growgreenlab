// Market-based Chat Area configuration
// Topics are lightweight message labels — not separate rooms.
// Simplified 2026-10-11: 4 topics per market, beginner-friendly labels.

export interface MarketTopic {
  label: string;
  value: string; // stored in community_messages.topic
}

const T = (label: string): MarketTopic => ({ label, value: label });

export const MARKET_TOPICS: Record<string, MarketTopic[]> = {
  "penny-stocks": [
    T("Trade Setups"),
    T("Premarket"),
    T("Trade Reviews"),
  ],
  "stock-market": [
    T("Trade Setups"),
    T("Market News"),
    T("Trade Reviews"),
  ],
  "options-trading": [
    T("Trade Setups"),
    T("Strategies"),
    T("Trade Reviews"),
  ],
  "futures-trading": [
    T("Trade Setups"),
    T("Market News"),
    T("Trade Reviews"),
  ],
  "forex": [
    T("Trade Setups"),
    T("Market News"),
    T("Trade Reviews"),
  ],
  "crypto": [
    T("Trade Setups"),
    T("Market News"),
    T("Trade Reviews"),
  ],
  // Community rooms: no topic filters, single discussion view
  "trading-psychology": [],
  "general": [],
  "announcements": [],
};

export function topicsForRoom(slug: string): MarketTopic[] {
  return MARKET_TOPICS[slug] ?? [];
}

// The six market cards shown on the Chat Area landing, in display order.
export const MARKET_CARDS = [
  {
    slug: "penny-stocks",
    name: "Penny Stocks",
    description: "Breakouts, premarket movers, and low-float plays.",
    color: "#42d879",
  },
  {
    slug: "stock-market",
    name: "Stock Market",
    description: "Large and mid-cap stocks, earnings, and trends.",
    color: "#60a5fa",
  },
  {
    slug: "options-trading",
    name: "Options Trading",
    description: "Calls, puts, strategies, and expiration plays.",
    color: "#a78bfa",
  },
  {
    slug: "futures-trading",
    name: "Futures Trading",
    description: "Index futures, price action, and scalping.",
    color: "#f59e0b",
  },
  {
    slug: "forex",
    name: "Forex",
    description: "Currency pairs and economic events.",
    color: "#38bdf8",
  },
  {
    slug: "crypto",
    name: "Crypto",
    description: "Bitcoin, altcoins, and crypto market moves.",
    color: "#f472b6",
  },
] as const;

// Community destinations shown below the market cards.
export const COMMUNITY_CARDS = [
  {
    slug: "trading-psychology",
    name: "Trading Psychology & Education",
    description: "Mindset, discipline, and learning resources.",
    color: "#6b7280",
  },
  {
    slug: "general",
    name: "General Discussion",
    description: "Anything trading-related that fits nowhere else.",
    color: "#6b7280",
  },
] as const;
