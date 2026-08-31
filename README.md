# Vision — Bitcoin strategy bots

A small Next.js app that paper-trades Bitcoin against a shared Monte Carlo
simulation, running more than one strategy at once as independent bots —
each with its own settings, its own positions, and its own P&L, on its own
page. Runs on Vercel. No LLM, no API key required to run — just Binance's
live price, its real order book, and the simulation.

## How it works

Every 20 seconds, on the wall clock (:00, :20, :40…), a fresh cycle begins —
shared by every bot, computed once:

1. **Take the live price as the reference.** Whatever Binance's BTCUSDT
   perpetual trade stream last reported is this cycle's start price — never
   a separate fetch, never anything else.
2. **Simulate 10,000 paths.** A driftless Monte Carlo: 10,000 random walks,
   one second at a time, for the 20 seconds of the cycle, using the plain
   realised volatility of the last 60 one-second price points. Unlike a
   single end-of-window probability, this keeps every path's price at every
   second of the cycle — not just where it might end up, but how far it
   should plausibly have gotten by any given second along the way.
3. **Watch the live price against that distribution.** At every tick, check
   what share of the 10,000 simulated paths reached at least as far from the
   start price, in the same direction, by that same second. That share is
   falling as the move gets more extreme — a low number means the current
   price is a rare draw from the model's own distribution right now. This
   part — the simulation and the tail probability it produces — is identical
   for every bot; nothing about it depends on which strategy is watching.
4. **Each bot decides for itself once that gets unlikely enough.** Its own
   configured threshold, its own side of the bet:
   - **Reversion** bets *against* the move — the price has strayed further
     than the simulation thinks likely, so it should snap back toward more
     probable levels.
   - **Momentum** bets *with* the move — the same unlikely distance is read
     as evidence that something real, not noise, is driving the price, and
     it keeps going.

   That one word — which side to take — is the entire difference between
   the two. At most one position open at a time, per bot.
5. **Force-close before the cycle ends**, at each bot's own configured
   second, whatever the price is doing by then.

## Multiple bots, one market

There is one shared engine per browser tab — one Binance connection, one
cycle timer, one Monte Carlo simulation — because duplicating that per
strategy would just be the same computation run twice for no reason. What
each bot owns independently is its config, its open position, its trade
history, and its P&L. The top nav switches which bot's dashboard you're
looking at; **Start**, **Stop**, and **Stop all** act on the shared engine
underneath all of them, so every bot keeps trading regardless of which page
is open — switching pages never pauses anything.

Adding a new strategy means adding one entry to `src/lib/strategies.ts` —
a name, a blurb, and which side of an unlikely move it takes. Everything
else (the simulation, the feed, the fills, the dashboard, the settings, the
history) is already generic across strategies.

## About the price feed and the fills

Everything here is **Binance USD-M futures**, not spot — deliberately.
Spot cannot sell short without borrowed margin, and both strategies need
SHORT to be exactly as real as LONG. Every price — the cycle's reference,
the running display, the volatility estimate — comes from the BTCUSDT
perpetual's public trade stream (`wss://fstream.binance.com/ws/btcusdt@aggTrade`),
free and with no key. A REST poll of the futures ticker is the only
fallback, used only when the stream has nothing fresh. No other exchange,
market, or index is ever blended in.

Paper trading, but every fill is priced the way a real order actually
would be, not approximated:

- **Real resting depth.** Every open and close walks the futures book
  (`/fapi/v1/depth`) level by level, consuming size and reporting a short
  fill when the book runs out rather than inventing liquidity that wasn't
  there.
- **Real order latency.** A market order doesn't fill against the book as
  it looked the instant you decided to trade — it fills against however
  the book looks once the order actually reaches the exchange. Every fill
  fetches the book after the same ~150ms a real order round trip would
  take, not at the instant of the signal.
- **Real lot sizes.** Every filled quantity is rounded down to Binance's
  own `LOT_SIZE` step for BTCUSDT (fetched from `/fapi/v1/exchangeInfo`
  and cached), the same precision a live order would be forced onto —
  never a fractional size no real order could land on.
- **Real fees.** Every open and close pays Binance's standard USD-M
  futures taker fee (0.05% per side, no VIP tier or BNB discount assumed)
  against the notional value of the fill, deducted from the recorded P&L.

Every one of these calls — the tick stream, the ticker fallback, the
order-book fetch, `exchangeInfo` — goes straight from the browser to
`binance.com`, never through this app's own server. Binance's REST API
returns 451 for requests from US-based server IPs, which is where a
Vercel serverless function runs by default; a real browser's own
connection isn't affected.

What's still not modelled: leverage and liquidation risk (every position
is sized as plain 1x notional exposure, not a margined bet), and funding
rate accrual (real, but negligible over a hold of at most ~19 seconds).

## Setup

```bash
npm install
npm run dev
```

No `.env.local` is required. Press **Start** on any strategy page — it
connects to Binance and begins running 20-second cycles for every bot at
once. Each bot's own **Trade automatically** stays off until you turn it
on, so you can watch it decide first.

### Environment variables

Everything is optional.

| Variable | Needed | What for |
|---|---|---|
| `VISION_ACCESS_TOKEN` | recommended | Puts the whole app behind a shared secret. A Vercel URL is public by default. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | recommended | Keeps every bot's position history across restarts. Without it, history lives in memory and is lost on every cold start. |

Deploy: push, import at [vercel.com/new](https://vercel.com/new), add the
variables you want, done. No build configuration needed.

## Settings

Per bot, four things, all on sliders or a toggle:

- **Trade automatically** — off means this bot watches and logs, but never buys
- **Flag when probability drops below** — how unlikely the current move has
  to be, versus the simulation, before it's a signal (default 10%)
- **Close trades at second** — force-close whatever's open this many seconds
  into the 20-second cycle (default 19)
- **Stake per trade** — fixed USD amount per position (default $20)

**Stop all** in the header is global — every bot, immediately. Resetting one
bot's own stop (shown once that bot is stopped) only re-arms that one.

## Layout

```
src/lib/
  strategies.ts      the strategy roster — name, blurb, and which side of an unlikely move each bet takes
  binanceFeed.ts      the shared price source — Binance futures' live trade stream (browser WebSocket)
  binanceBook.ts       real futures order-book depth, lot-size rounding, and the paper fill model
  series.ts             one-second price sampling and realised volatility
  montecarlo.ts          the driftless Monte Carlo — full-cycle path simulation, shared by every bot
  engine.ts               the 20-second cycle loop, running every bot off the one shared simulation
  store.ts                 per-bot position and cycle history
src/app/
  [strategy]/            one route per bot — /reversion, /momentum
  api/config/[strategy]/  api/state/[strategy]/  — per-bot config and history, access control only;
                          every Binance call is made directly from the browser
src/components/
  EngineProvider.tsx     the one engine instance, created at the root layout so it survives navigation
  Header.tsx              the shared nav and the global Start/Stop/Stop-all
  StrategyDashboard.tsx   one bot's page — price, chart, read, history, log, settings
```

## Tests

```bash
npm test
```

17 tests, no network needed. The ones that matter: the simulated tail
probability matches the closed-form lognormal tail; it sits at ~50% right at
the start price and falls as a move gets more extreme; the simulated
probability band widens over time and always brackets the start price;
volatility recovers a known sigma from a realised one-second tape and never
collapses to zero with no data; a paper fill walks real depth on both sides
(USD-sized to open, quantity-sized to close) and reports shortfalls
honestly; a filled quantity is rounded down to a real lot size, never up;
reversion and momentum take opposite sides of the same unlikely move.

## Known limits

- **The tab must stay open.** The loop runs in the browser. Closing it stops
  every bot, which is the safer default anyway.
- **If Binance's stream ever drops**, a REST poll of the ticker price stands
  in until it reconnects — still genuine, just slower to update.
- **This is paper trading only.** There is no live order path in this app.
- **Leverage and liquidation risk aren't modelled.** Every position is a
  plain 1x notional exposure, not a margined bet.
- **The edge may not exist, for either strategy.** They cannot both be right
  about the same move — that's the point of running them side by side. Watch
  the numbers before assuming either one.

Not financial advice.
