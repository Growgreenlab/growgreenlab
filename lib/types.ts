/** One intraday candle. `t` is epoch milliseconds. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Side = "buy" | "sell";

/** A simulated fill. `realizedPnl` is set on closing (sell) fills. */
export interface Fill {
  id: number;
  side: Side;
  qty: number;
  price: number;
  candleIndex: number;
  time: number;
  note?: string;
  realizedPnl: number;
}

export type DataSource = "sample" | "twelvedata" | "csv";

export interface SessionMeta {
  ticker: string;
  tradeDate: string; // YYYY-MM-DD
  source: DataSource;
  startIndex: number;
}
