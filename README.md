# Vision — Bitcoin strategy bots

A small Next.js app that paper-trades Bitcoin against a shared Monte Carlo
simulation, running more than one strategy at once as independent bots —
each with its own settings, its own positions, and its own P&L, on its own
page. Runs on Vercel. No LLM, no API key required to run — just Binance's
live price, its real order book, and the simulation.

## How it works

Every 60 seconds, on the wall clock (:00, :01:00, :02:00…), a fresh cycle
begins — shared by every bot, computed once:

1. **Take the live price as the reference.** Whatever Binance's BTCUSDT
   perpetual trade stream last reported is this cycle's start price — never
   a separate fetch, never anything else.
2. **Simulate 1,000 paths.** A driftless Monte Carlo: 1,000 random walks,
   one second at a time, for the 60 seconds of the cycle, using the plain
   realised volatility of the last 60 one-second price points. Unlike a
   single end-of-window probability, this keeps every path's price at every
   second of the cycle — not just where it might end up, but how far it
   should plausibly have gotten by any given second along the way.
3. **Watch the live price against that distribution — but only from second
   10 to second 50.** No entries in the first 10 seconds (there's barely any
   tape yet to react to) or the last 10 (no bot should ever be mid-decision
   right as the next cycle is about to begin). Inside that window, at every
   tick, check what share of the simulated paths reached at least as far
   from the start price, in the same direction, by that same second. That
   share is falling as the move gets more extreme — a low number means the
   current price is a rare draw from the model's own distribution right now.
   This part — the simulation and the tail probability it produces — is
   identical for every bot; nothing about it depends on which strategy is
   watching.
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
   second (never later than second 50), whatever the price is doing by then.

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

Paper trading, but every fill is priced against the real market, not
approximated:

- **Real resting depth.** Every open and close walks the futures book
  (`/fapi/v1/depth`) level by level, consuming size and reporting a short
  fill when the book runs out rather than inventing liquidity that wasn't
  there. The fetch is made fresh at the moment of the decision — its own
  real round-trip time already is the delay between deciding to trade and
  the book an order would actually land against, so nothing artificial is
  added on top of it.
- **Real lot sizes.** Every filled quantity is rounded down to Binance's
  own `LOT_SIZE` step for BTCUSDT (fetched from `/fapi/v1/exchangeInfo`
  and cached), the same precision a live order would be forced onto —
  never a fractional size no real order could land on.
- **No fees.** Not modelled — every reported P&L is gross.

Every one of these calls — the tick stream, the ticker fallback, the
order-book fetch, `exchangeInfo` — goes straight from the browser to
`binance.com`, never through this app's own server. Binance's REST API
returns 451 for requests from US-based server IPs, which is where a
Vercel serverless function runs by default; a real browser's own
connection isn't affected.

Every price tick is timestamped against the local clock at the moment
it's received, not Binance's own embedded trade time — the engine buckets
ticks into cycles against the same local clock, so timestamping against a
different one would silently filter fresh ticks out of the current cycle
until local time caught up to it.

What's still not modelled: fees, margin as a real constraint (see
**Leverage** below), and funding rate accrual (real, but negligible over a
hold of at most 40 seconds).

## Look and feel

The whole app is one screen — no page scroll, `100dvh` top to bottom. The
chart is the point of it: full bleed, no card border, its own always-dark
"screen" regardless of site theme, with the probability cone glowing on top
of it and the live price a pulsing dot. Everything else — price, countdown,
tail probability, the open position's live P&L — is drawn as HUD overlays
directly on that screen instead of separate stacked cards, arcade-style.
Trade history and the activity log live behind one **History** button
instead of taking up permanent space on the page.

## Setup

```bash
npm install
npm run dev
```

No `.env.local` is required. Press **Start** on any strategy page — it
connects to Binance and begins running 60-second cycles for every bot at
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

Per bot, six things, all on sliders or a toggle:

- **Trade automatically** — off means this bot watches and logs, but never buys
- **Flag when probability drops below** — how unlikely the current move has
  to be, versus the simulation, before it's a signal (default 10%)
- **Close trades at second** — force-close whatever's open this many seconds
  into the 60-second cycle (default 50, and capped there — see below)
- **Stake per trade** — fixed USD margin per position (default $20)
- **Leverage** — 1x to 10x, multiplies notional exposure (default 1x — see below)
- **Max slippage** — reject a new entry if the fill price moves against it by
  more than this many dollars while the order is filling (default $50 — see
  below)

Entries are never allowed in the first or last 10 seconds of a cycle,
regardless of these settings — not a setting, a fixed rule (`ENTRY_MARGIN_SEC`
in `src/lib/config.ts`). The first 10 seconds barely have any tape to react
to yet; the last 10 exist so no bot is ever mid-decision right as the next
cycle begins. **Close trades at second** can be pulled earlier than 50, but
never later.

**Stake** is margin, not exposure — a position's actual notional size is
`stakeUsd × leverage`, which is what the fill actually walks the order book
for. Margin is never modelled as a real constraint, though: there's no
liquidation, ever, at any leverage — a highly leveraged position just has
P&L that moves proportionally faster in both directions, unconditionally.
The leverage a position opened with is captured on the position itself, so
changing the setting mid-session never relabels an already-open trade.

**Max slippage** is the same protection a real exchange gives a
limit-protected (marketable-limit) market order: between the tick that
triggered the decision and the order-book fetch that fills it, the price can
have moved on, and the fill should never be allowed to land arbitrarily far
from the price that justified the trade. Only an *adverse* move counts
against the limit — paying more for a long, or selling for less on a short,
than the triggering price — a favorable move never blocks a trade, exactly
like Binance's own Price Protect. Real venues offer this natively (Binance
Price Protect, an IOC limit order with a price bound); it's a real,
recognized order-protection mechanism, not something invented for this app.
It only ever blocks a fresh entry — a scheduled close always goes through,
same as a real position that must be exited regardless of price.

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
  engine.ts               the 60-second cycle loop, running every bot off the one shared simulation
  store.ts                 per-bot position and cycle history
src/app/
  [strategy]/            one route per bot — /reversion, /momentum
  api/config/[strategy]/  api/state/[strategy]/  — per-bot config and history, access control only;
                          every Binance call is made directly from the browser
src/components/
  EngineProvider.tsx     the one engine instance, created at the root layout so it survives navigation
  AppShell.tsx            the single-viewport-height shell (no page scroll) plus the scanline overlay
  Header.tsx              the shared nav and the global Start/Stop/Stop-all
  StrategyDashboard.tsx   one bot's page — the chart and its HUD overlays, a stat strip, settings and history as modals
  Charts.tsx              the price line against the simulated probability cone, full bleed
  HistoryPanel.tsx        positions and the activity log, tabbed, behind one button
  Settings.tsx            the six per-bot settings, as a modal
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
reversion and momentum take opposite sides of the same unlikely move;
leverage clamps to [1x, 10x] on write and defaults to 1x; max slippage
clamps to a positive dollar amount on write.

## Known limits

- **The tab must stay open.** The loop runs in the browser. Closing it stops
  every bot, which is the safer default anyway.
- **If Binance's stream ever drops**, a REST poll of the ticker price stands
  in until it reconnects — still genuine, just slower to update.
- **This is paper trading only.** There is no live order path in this app.
- **Fees and liquidation risk aren't modelled.** Every reported P&L is gross,
  and margin is never a real constraint — leverage (up to 10x) scales
  notional exposure and P&L, but no position is ever force-closed for it.
- **The edge may not exist, for either strategy.** They cannot both be right
  about the same move — that's the point of running them side by side. Watch
  the numbers before assuming either one.

Not financial advice.
