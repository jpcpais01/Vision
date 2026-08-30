# Vision — Polymarket BTC 5-minute UP/DOWN

A small Next.js app that trades Polymarket's Bitcoin 5-minute up/down markets.
Runs on Vercel. Paper mode by default. No LLM, no API key required to run —
just prices and a Monte Carlo simulation.

## How it works

Every five minutes Polymarket opens a new market: will Bitcoin be higher in five
minutes than it is right now? Vision plays one cycle per window.

1. **Calibrate first.** There is no seeded history. On start, the app spends
   `CALIBRATION_MIN_SEC` (5 minutes by default) gathering nothing but real,
   live price ticks before it will touch a window — long enough for the
   volatility estimate behind every probability to be real rather than a
   generic placeholder. It keeps a rolling 30-minute tape after that.
2. **Wait for a fresh window.** Once calibrated, it never joins a window
   already in progress — the whole bet is measured against the price at the
   open, and joining late means guessing that number.
3. **Fetch the barrier — never guess it.** At the open, the price to beat is
   read from **Polymarket's own live relay of the Chainlink price stream**
   these markets actually settle on (see "About the price feed" below). If
   that is unreachable it falls back to the free on-chain Chainlink read, and
   only as a last resort to the app's own Binance-derived price — and it says
   which one it used, in the UI and in the log.
4. **Run the only model there is.** A driftless Monte Carlo: `paths` random
   walks are simulated forward from the *current* price, using the realised
   volatility of the last 30 minutes of real ticks, for however many seconds
   are left in the window. `P(UP)` is the share that finish above the
   barrier. No forecast, no prior, no external opinion feeds it — recomputed
   roughly once a second for as long as the window is open.
5. **Buy whichever side is worth more than it costs.** Both UP and DOWN are
   evaluated every tick: if the simulation's probability for a side beats what
   the market is charging for it by more than the configured minimum edge, it
   buys that side. There is no pinned direction — either side can trade, and
   which one wins is decided fresh each time.
6. **Settle at the close** and record the window, traded or not.

## About the price feed

Polymarket settles these markets on **Chainlink Data Streams BTC/USD**, and
Chainlink does not offer that stream for free — it needs commercial
credentials. But Polymarket runs a **public Real-Time Data Service** that
relays it, with no key and no auth, specifically so people can see the same
price the markets resolve against:

```
wss://ws-live-data.polymarket.com
topic: crypto_prices_chainlink
```

The app connects to this directly from the browser (`src/lib/chainlinkFeed.ts`)
and uses it as the primary source for the barrier — the one number the whole
system is measured against. Behind it sit two fallbacks: the free on-chain
Chainlink aggregator (`chainlink.ts`, much slower — it only updates on a 0.5%
deviation or an hourly heartbeat) and, last, the app's own Binance-derived
tape. Every window's history records which source was actually used
(`barrierSource`), so a fallback is always visible, never silent.

Second-to-second prices — the tape the volatility estimate and the live chart
are built from — come from **Binance**, which is free, needs no key, and
publishes real 1-second resolution. It is one exchange's tape rather than an
oracle aggregate, so it is continuously re-anchored to whichever Chainlink
read arrives most recently (the live relay when connected, the on-chain read
every 30 seconds otherwise): the difference is added to every Binance price,
past and future, so the level tracks the settlement oracle while the
movement is Binance's real tape.

> This repository's sandbox has no route to `polymarket.com`, so the RTDS
> client's protocol details (endpoint, subscribe message, ping) are taken
> directly from Polymarket's own `real-time-data-client` source on GitHub,
> but the connection itself has not been exercised against the live
> endpoint. If it does not connect in your deployment, the two fallbacks mean
> the app still runs correctly — it will just say so in Activity and use the
> on-chain or Binance-derived barrier instead.

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
| `CHAINLINK_RPC_URL` | no | Any Ethereum RPC, for the on-chain fallback. |

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
  binance.ts        live price
  chainlink.ts       the on-chain fallback read
  chainlinkFeed.ts   Polymarket's live Chainlink relay (browser WebSocket)
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

24 tests, no network needed. The ones that matter: at the barrier with nothing
else known the simulation is a coin flip; being on either side of the barrier
moves P(UP) the right way and by a symmetric amount; more volatility pulls a
winning position back toward even; a finished window is decided, not
simulated; a real 30-minute tape clears the fallback threshold in the
volatility estimate; the Chainlink anchor re-levels history and live ticks by
exactly the same amount; paper fills walk real depth and report shortfalls;
market discovery uses Polymarket's deterministic slug grid rather than a
text search, with a case that reproduces a real bug (a market whose own date
fields would have produced the wrong window).

## Known limits

- **The tab must stay open.** The loop runs in the browser. Closing it stops
  trading, which is the safer default anyway.
- **The RTDS connection is unverified**, per the caveat above. It degrades
  safely if it doesn't work in your environment.
- **Binance is a proxy** for the parts of the tape the settlement oracle
  cannot supply fast enough — the volatility estimate, the chart. See "About
  the price feed."
- **Paper settlement uses the app's own live price**, so it can disagree with
  the on-chain result at the boundary on a very close window.
- **The edge may not exist.** A five-minute Bitcoin binary is close to a coin
  flip and Polymarket's book is not naive. Run paper mode until the numbers say
  something before risking real money.

Not financial advice.
