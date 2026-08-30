# Vision — Polymarket BTC 5-minute UP/DOWN

A small Next.js app that trades Polymarket's Bitcoin 5-minute up/down markets.
Runs on Vercel. Paper mode by default. No LLM, no API key required to run —
just prices and a Monte Carlo simulation.

## How it works

Every five minutes Polymarket opens a new market: will Bitcoin be higher in five
minutes than it is right now? Vision plays one cycle per window.

1. **Calibrate first.** There is no seeded history. On start, the app spends
   `CALIBRATION_MIN_SEC` (1 minute by default) gathering nothing but real,
   live price ticks before it will touch a window — long enough for the
   volatility estimate behind every probability to be real rather than a
   generic placeholder. It keeps a rolling 30-minute tape after that.
2. **Wait for a fresh window.** Once calibrated, it never joins a window
   already in progress — the whole bet is measured against the price at the
   open, and joining late means guessing that number.
3. **Fetch the barrier — never guess it.** At the open, the price to beat is
   the freshest **CoinGecko** price already on hand (see "About the price
   feed" below) — never a separate fetch, never anything else. If there is
   no price yet, the window is sat out rather than trading on a guess.
4. **Run the only model there is.** A driftless Monte Carlo: `paths` random
   walks are simulated forward from the *current* price, using the plain
   average realised volatility of the last 10 15-second candles, for however
   many seconds are left in the window. `P(UP)` is the share that finish
   above the barrier. No forecast, no prior, no external opinion feeds it —
   recomputed roughly once a second for as long as the window is open.
5. **Buy whichever side is worth more than it costs.** Both UP and DOWN are
   evaluated every tick: if the simulation's probability for a side beats what
   the market is charging for it by more than the configured minimum edge, it
   buys that side. There is no pinned direction — either side can trade, and
   which one wins is decided fresh each time.
6. **Settle at the close** and record the window, traded or not.

## About the price feed

Polymarket settles these markets on **Chainlink Data Streams BTC/USD**, and
Chainlink does not offer that stream for free — it needs commercial
credentials. Two free alternatives were tried and dropped before landing
here, both for the same reason: they turned out not to be reachable from a
real deployment, not just from this development sandbox.

- **Polymarket's own Real-Time Data Service** (a public WebSocket relay of
  the Chainlink stream) never delivered usable live updates in practice.
- **Pyth Network's free Hermes service** looked right — endpoint, price feed
  id and response shape were all confirmed against Pyth's own source on
  GitHub — but its public gateway returned `Unauthorized` on every request
  once actually deployed, for reasons that could not be diagnosed without
  network access to it.

So this now uses **CoinGecko**: a free, well-known price index that
aggregates BTC/USD across many exchanges — not one exchange's own tape, not
a guess, but also not the exact feed Polymarket itself settles on.

```
https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd
```

The engine polls this every 2 seconds (`src/lib/coingecko.ts`, via
`/api/coingecko`) as its **only** price source — the barrier, the live price
on screen, and the tape the volatility estimate and chart are built from all
come from it. CoinGecko has no free push/streaming option, so there is no
separate "live" connection to track; the poll loop is the whole feed. It
works with no key at a low rate limit; setting `COINGECKO_API_KEY` (a free
Demo key from coingecko.com, no payment) raises the limit and is what let
polling move from a 5–10s interval down to 2s.

> Endpoint, query params, the `x-cg-demo-api-key` header, and the response
> shape are all taken directly from CoinGecko's own `coingecko-typescript`
> client source on GitHub — not guessed.

## Setup

```bash
npm install
npm run dev
```

No `.env.local` is required for paper mode. Press **Start** — it calibrates,
then waits for the next window and runs cycles. **Trade automatically** stays
off until you turn it on, so you can watch it decide first.

### Environment variables

Every one of these is optional for paper trading.

| Variable | Needed | What for |
|---|---|---|
| `VISION_ACCESS_TOKEN` | recommended | Puts the whole app behind a shared secret. A Vercel URL is public, and in live mode this page spends money. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | recommended | Keeps trade history across restarts. Without it, history lives in memory and is lost on every cold start. |
| `POLYMARKET_PRIVATE_KEY` | live only | Polygon key holding USDC.e. |
| `ALLOW_LIVE_TRADING` | live only | Must be exactly `true`. Live orders are refused otherwise, whatever the UI says. |
| `COINGECKO_API_KEY` | recommended | Free Demo key from coingecko.com — raises the rate limit enough for 2s polling. Works without it, just slower and more likely to be throttled. |

Deploy: push, import at [vercel.com/new](https://vercel.com/new), add the
variables you want, done. No build configuration needed.

## Live mode

Three independent conditions must all hold before a real order is sent:

1. `ALLOW_LIVE_TRADING=true` **in the server environment** — not a UI toggle.
2. `POLYMARKET_PRIVATE_KEY` configured server-side. It is read in one file and
   never reaches the browser.
3. The kill switch is off.

The browser proposes and the server disposes. On every order the server re-reads
the kill switch from its own storage, re-fetches the order book, and re-clamps
the stake against its own copy of the config — so editing the request in devtools
changes nothing that matters.

**Stop all** engages the kill switch: a server-side flag checked on every order
request, plus cancellation of any resting orders, plus auto-trade off.

## Settings

Five things, all on sliders, plus the mode:

- **Minimum edge** — how far ahead of the market price to require before buying
- **Stake per trade** — fixed dollars per position
- **Stop after losing** — daily loss limit
- **Don't enter with less than** — seconds left on the clock
- **Paper / Live**

## Layout

```
src/lib/
  coingecko.ts       the only price source (BTC/USD index)
  market.ts          finding the live 5-minute market
  book.ts            order book maths, and the paper fill model
  clob.ts            Polymarket reads
  montecarlo.ts       the driftless simulation
  engine.ts           the loop
  live.ts             real order placement
  store.ts            trade history
src/app/api/         server routes — all secrets, all validation
src/components/      the app
```

## Tests

```bash
npm test
```

21 tests, no network needed. The ones that matter: at the barrier with nothing
else known the simulation is a coin flip; being on either side of the barrier
moves P(UP) the right way and by a symmetric amount; more volatility pulls a
winning position back toward even; a finished window is decided, not
simulated; a real 15-second tape clears the fallback threshold in the
volatility estimate; paper fills walk real depth and report shortfalls;
market discovery uses Polymarket's deterministic slug grid rather than a
text search, with a case that reproduces a real bug (a market whose own date
fields would have produced the wrong window).

## Known limits

- **The tab must stay open.** The loop runs in the browser. Closing it stops
  trading, which is the safer default anyway.
- **The price is CoinGecko's index, not Chainlink Data Streams.** Polymarket
  settles on the latter, which needs paid credentials to read for free.
  CoinGecko tracks the same asset closely but is not guaranteed to agree to
  the cent at the boundary of a very close window.
- **The tape updates every 2 seconds, not continuously.** CoinGecko has no
  free push/streaming option, so this is a poll loop, not a live feed. Without
  `COINGECKO_API_KEY` the free rate limit may force this slower still.
- **The edge may not exist.** A five-minute Bitcoin binary is close to a coin
  flip and Polymarket's book is not naive. Run paper mode until the numbers say
  something before risking real money.

Not financial advice.
