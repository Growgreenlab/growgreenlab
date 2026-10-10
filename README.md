# Trade Replay Lab v2

A historical stock-trading simulator. Replay past market sessions candle by
candle and practice trading decisions — focused on US penny stocks and the
HOD (High of Day) breakout strategy.

**All trades are simulated. Nothing here places real orders.**

## Features

- Dark-theme trading UI, mobile responsive
- Hand-rolled canvas candlestick chart (no charting dependencies): volume bars,
  price + time axes, HOD line, stop-loss / take-profit lines, trade markers
- Replay controls: play, pause, next candle, speed (0.5x–8x), reset.
  Future candles are never revealed.
- Session setup: ticker symbol, trading date, replay start time
- Data sources:
  - **Sample data** — generated intraday tape, always badged
    `SAMPLE DATA — not real market prices`
  - **Twelve Data** — paste your *own* free API key (client-side only; it is
    never sent to our server or stored server-side) to load real 1-minute
    candles for any ticker + date
  - **CSV upload** — `datetime,open,high,low,close,volume` (tolerant headers)
  - **Download CSV** — export the loaded session and re-upload it later
- Simulated trading panel: market buy/sell, share quantity, stop-loss and
  take-profit brackets that trigger automatically as candles advance,
  virtual $100,000 cash, live realized + unrealized P/L, trade ledger.
  Badged `SIMULATED — not real orders` throughout.
- Supabase Auth (email magic link); replay and sessions routes require login
- Saved sessions in Supabase Postgres with Row Level Security — review,
  reload, and delete your own sessions from **My Sessions**

## Tech stack

- Next.js 15 (App Router) + TypeScript + React 19
- Supabase (`@supabase/supabase-js`, `@supabase/ssr`) — Auth + Postgres
- Zero charting libraries (canvas is hand-rolled in `components/CandleChart.tsx`)
- Pure, framework-free replay/trading engine in `lib/engine.ts`

## Run locally

```bash
npm install
cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev
```

Open http://localhost:3000. Sign in via the emailed magic link, then open
the Replay Lab.

## Project layout

```
app/                  # routes: / (landing), /login, /replay, /sessions
components/           # CandleChart, DataSourcePanel, ReplayControls, TradingPanel, Header
lib/
  engine.ts           # pure replay + simulated-trading engine (unit-testable)
  marketData.ts       # ET time helpers + deterministic sample-data generator
  marketData.twelve.ts# Twelve Data fetch/parse (client-side)
  marketData.csv.ts   # CSV parse + export
  types.ts
  supabaseClient.ts / supabaseServer.ts
middleware.ts         # protects /replay and /sessions
supabase/schema.sql   # tables + RLS — run once in the Supabase SQL editor
scripts/smoke.mjs     # node smoke test for the engine (see below)
```

## Tests

```bash
node scripts/smoke.mjs
```

Compiles `lib/engine.ts` + `lib/marketData*.ts` with `tsc` and runs engine
assertions: hidden futures, buy/sell P/L math, stop-loss and take-profit
triggers, gap handling, brackets, CSV round-trip, sample determinism, and
Twelve Data response parsing (with a mocked payload).
