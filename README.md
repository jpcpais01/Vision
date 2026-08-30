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
3. **Fetch the barrier — never guess it.** At the open, the barrier is
   captured from the most exact source that answers (see "About the price
   feed" below): Polymarket's own live Chainlink relay first, the on-chain
   Chainlink read behind it, and only the running display feed
   (Binance/CoinGecko) as an absolute last resort. If there is no price
   at all, the window is sat out rather than trading on a guess.
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
6. **Settle at the close.** The close is captured the same exacting way as
   the barrier — Polymarket's exact settlement source first — since a $1–2
   discrepancy there could flip a recorded win/loss relative to what
   Polymarket itself resolved. Recorded either way, traded or not.

## About the price feed

This app uses two *different* feeds for two *different* jobs, because they
have opposite requirements.

**The barrier and the close decide win or loss, so they have to be exact.**
Polymarket settles these markets on **Chainlink Data Streams BTC/USD**, and
Chainlink does not offer that stream for free — it needs commercial
credentials. Polymarket itself runs a public Real-Time Data Service that
relays that exact stream, with no key and no auth, specifically so people
can see the same price the markets resolve against — this is as close to
"exactly what Polymarket uses" as a free integration gets. Behind it sits
the free on-chain Chainlink aggregator (the same asset, independently read,
but far slower to update) as a fallback for the rare moment the relay has
gone quiet. Both are consulted only at the two instants that actually
matter — the barrier at open, the close at settlement (`Engine.captureExact`
in `src/lib/engine.ts`) — never for the running display, and every window's
history records exactly which of the two answered (`barrierSource`,
`closeSource`), so a fallback is always visible, never silent.

**The running display in between just needs to be smooth and free**, since
it never decides an outcome by itself — it only drives what you watch tick
and the volatility estimate the simulation trades on. Binance's public
trade stream (`wss://stream.binance.com:9443/ws/btcusdt@trade`) is the
primary source there — one exchange's own tape, not a cross-exchange
aggregate, but genuinely continuous and free — with CoinGecko's
cross-exchange index (`https://api.coingecko.com/api/v3/simple/price`)
polled every 2s as its fallback.

Two free alternatives were tried for the *exact* side before this design and
dropped, both for the same reason — not reachable from a real deployment,
not just from this development sandbox — which is exactly why this now
tries Polymarket's own relay first but never *only* relies on it: **Pyth
Network's free Hermes service** looked right (endpoint, price feed id and
response shape all confirmed against Pyth's own source on GitHub) but its
public gateway returned `Unauthorized` on every request once actually
deployed, for reasons that could not be diagnosed without network access to
it; and a **CoinGecko-only** design worked but its public index refreshes
its own cached value only every 30–60s, too coarse to be the exact side of
anything.

> Every endpoint, message shape, and header here — Polymarket's RTDS relay,
> the on-chain Chainlink call, Binance's trade stream, CoinGecko's
> `x-cg-demo-api-key` header — is taken directly from each provider's own
> source on GitHub, not guessed. What is not independently exercised from
> this development sandbox (no route to `polymarket.com` here) is whether
> Polymarket's relay actually stays connected in a real deployment; the
> on-chain fallback means the exact side keeps working, just slower to
> update, even if it doesn't.

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
| `CHAINLINK_RPC_URL` | no | Any Ethereum RPC, for the on-chain fallback behind the barrier/close. |

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
  chainlinkFeed.ts   the exact source — Polymarket's live relay (browser WebSocket)
  chainlink.ts       the exact source's fallback — on-chain Chainlink read
  binanceFeed.ts     the running display (browser WebSocket)
  coingecko.ts       the running display's fallback (BTC/USD index)
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
- **Polymarket's own relay's real-world reliability is unverified from this
  sandbox** (no route to `polymarket.com` here). Check the "Chainlink"
  status badge in a real deployment — if it stays offline and the on-chain
  fallback is slow to answer too, the barrier/close capture (not the
  display) will be slower than instant, though never wrong.
- **If neither Chainlink source answers at all** (both the relay and the
  on-chain fallback), the barrier or close falls back to the running
  display feed (Binance/CoinGecko) as a last resort rather than sitting the
  window out — labelled honestly (`barrierSource`/`closeSource`), but at
  that point no longer Polymarket's exact number.
- **The edge may not exist.** A five-minute Bitcoin binary is close to a coin
  flip and Polymarket's book is not naive. Run paper mode until the numbers say
  something before risking real money.

Not financial advice.
