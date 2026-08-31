# Vision — Bitcoin mean reversion

A small Next.js app that paper-trades Bitcoin mean reversion. Runs on Vercel.
No LLM, no prediction market, no API key required to run — just Binance's
live price, its real order book, and a Monte Carlo simulation.

## How it works

Every 20 seconds, on the wall clock (:00, :20, :40…), a fresh cycle begins:

1. **Take the live price as the reference.** Whatever Binance's BTCUSDT trade
   stream last reported is this cycle's start price — never a separate fetch,
   never anything else.
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
   price is a rare draw from the model's own distribution right now.
4. **Bet on reversion when it's unlikely enough.** Once that probability
   drops below the configured threshold, that's the signal: buy if the price
   dipped unusually low, sell if it spiked unusually high, theorising it
   reverts toward more probable levels. At most one position open at a time.
5. **Force-close before the cycle ends**, at the configured second, whatever
   the price is doing by then.

## About the price feed

Every price in this app — the cycle's reference, the running display, the
volatility estimate — comes from Binance's public trade stream
(`wss://stream.binance.com:9443/ws/btcusdt@trade`), free and with no key,
streaming every executed BTCUSDT trade in real time. A REST poll of
Binance's own ticker is the only fallback, used only when the stream has
nothing fresh. No other exchange or index is ever blended in.

Every simulated fill — opening and closing a position — is priced by
walking Binance's real resting depth (`/api/v3/depth`), consuming levels one
at a time and reporting a short fill when the book runs out rather than
inventing liquidity that wasn't there. Paper trading, but priced exactly the
way a live order would be.

## Setup

```bash
npm install
npm run dev
```

No `.env.local` is required. Press **Start** — it connects to Binance and
begins running 20-second cycles immediately. **Trade automatically** stays
off until you turn it on, so you can watch it decide first.

### Environment variables

Everything is optional.

| Variable | Needed | What for |
|---|---|---|
| `VISION_ACCESS_TOKEN` | recommended | Puts the whole app behind a shared secret. A Vercel URL is public by default. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | recommended | Keeps position history across restarts. Without it, history lives in memory and is lost on every cold start. |

Deploy: push, import at [vercel.com/new](https://vercel.com/new), add the
variables you want, done. No build configuration needed.

## Settings

Four things, all on sliders or a toggle:

- **Trade automatically** — off means it watches and tells you, but never buys
- **Flag when probability drops below** — how unlikely the current move has
  to be, versus the simulation, before it's a signal (default 10%)
- **Close trades at second** — force-close whatever's open this many seconds
  into the 20-second cycle (default 19)
- **Stake per trade** — fixed USD amount per position (default $20)

## Layout

```
src/lib/
  binanceFeed.ts    the only price source — Binance's live trade stream (browser WebSocket)
  binanceBook.ts     real order-book depth, and the paper fill model
  series.ts           one-second price sampling and realised volatility
  montecarlo.ts        the driftless Monte Carlo — full-cycle path simulation
  engine.ts             the 20-second cycle loop
  store.ts               position and cycle history
src/app/api/          server routes — access control, storage, Binance proxies
src/components/       the app
```

## Tests

```bash
npm test
```

15 tests, no network needed. The ones that matter: the simulated tail
probability matches the closed-form lognormal tail; it sits at ~50% right at
the start price and falls as a move gets more extreme; the simulated
probability band widens over time and always brackets the start price;
volatility recovers a known sigma from a realised one-second tape and never
collapses to zero with no data; a paper fill walks real depth on both sides
(USD-sized to open, quantity-sized to close) and reports shortfalls honestly.

## Known limits

- **The tab must stay open.** The loop runs in the browser. Closing it stops
  trading, which is the safer default anyway.
- **If Binance's stream ever drops**, a REST poll of the ticker price stands
  in until it reconnects — still genuine, just slower to update.
- **This is paper trading only.** There is no live order path in this app.
- **The edge may not exist.** Mean reversion on a 20-second Bitcoin window is
  a real but well-picked-over idea. Run it and look at the numbers before
  assuming anything.

Not financial advice.
