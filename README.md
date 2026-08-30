# Vision — Polymarket BTC 5-minute UP/DOWN

A small Next.js app that trades Polymarket's Bitcoin 5-minute up/down markets.
Runs on Vercel. Paper mode by default.

## How it works

Every five minutes Polymarket opens a new market: will Bitcoin be higher in five
minutes than it is right now? Vision plays one cycle per window.

1. **Wait for a fresh window.** It never joins one already in progress — the
   whole bet is measured against the price at the open, and joining late means
   guessing that number.
2. **At the open, record the price.** That is the barrier the market settles on.
3. **Ask the model once.** It gets the last 30 minutes of prices at 10-second
   resolution plus the current price, and answers with two things only:

   ```json
   { "direction": "UP", "probability": 62 }
   ```

   No confidence score, no commentary. The direction fixes which side we are
   allowed to trade for the rest of the window. The probability seeds step 4.
4. **Re-check that answer every second.** By the time the model replies, Bitcoin
   has already moved — and it keeps moving for another four minutes. A Monte
   Carlo simulation turns the model's probability into a drift, applies it only
   to the seconds remaining, and starts from the price *right now*. So the
   number we trade on is never the number the model returned.
5. **Buy when we are far enough ahead.** If our probability beats what the
   market charges for that side by more than the minimum edge (5% by default),
   it buys. Only that side, only once per window.
6. **Settle at the close** and record the window, traded or not.

The point of step 4 is worth stating plainly: a call of "UP at 70%" on a window
where Bitcoin has since dropped well below the barrier with a minute left comes
out *low*, because the recovery needed in the time remaining is not plausible at
the current volatility. The model picks a side; the simulation decides whether
that side is still worth paying for.

### Does the model actually help?

Probably the fairest thing to say is: unknown, and worth measuring. Over five
minutes Bitcoin is close to a coin flip, and the model's answer is already
slightly stale when it arrives.

So every simulation is run twice on the same random draws — once primed with the
model's call, once with a neutral 50/50 prior — and both are scored against what
actually happened. The app shows the comparison directly: if the model adds
nothing, the two Brier scores match and it says so, and you can set its weight to
0 in Settings and trade on the volatility maths alone.

## Setup

```bash
npm install
cp .env.example .env.local     # add OPENROUTER_API_KEY
npm run dev
```

Press **Start**. It waits for the next window, then runs cycles. **Trade
automatically** stays off until you turn it on, so you can watch it decide first.

### Environment variables

| Variable | Needed | What for |
|---|---|---|
| `OPENROUTER_API_KEY` | **yes** | Without it the model can't be asked and nothing trades. |
| `OPENROUTER_MODEL` | no | Defaults to `deepseek/deepseek-v4-flash-0731`. |
| `VISION_ACCESS_TOKEN` | recommended | Puts the whole app behind a shared secret. A Vercel URL is public, and in live mode this page spends money. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | recommended | Keeps trade history across restarts. Without it, history lives in memory and is lost on every cold start. |
| `POLYMARKET_PRIVATE_KEY` | live only | Polygon key holding USDC.e. |
| `ALLOW_LIVE_TRADING` | live only | Must be exactly `true`. Live orders are refused otherwise, whatever the UI says. |
| `CHAINLINK_RPC_URL` | no | Any Ethereum RPC, for the cross-check readout. |

Deploy: push, import at [vercel.com/new](https://vercel.com/new), add the
variables, done. No build configuration needed.

## About the price feed

Polymarket settles these markets on **Chainlink Data Streams BTC/USD**. Chainlink
does not offer that stream without commercial credentials, and its free on-chain
feed is a different, much slower product — it moves on a 0.5% deviation or an
hourly heartbeat, so it cannot produce a 10-second series at all.

So the app uses **Pyth**, which is free, needs no key, and is built the same way:
an aggregate of major exchange prices rather than one venue's tape. It is not the
settlement feed and will not match it to the cent. The free Chainlink feed is
still read every 30 seconds purely to show the gap between the two, so a
divergence is visible rather than silent.

If you get Chainlink Data Streams credentials, swapping the source is one file
(`src/lib/pyth.ts`).

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

Six things, all on sliders:

- **Minimum edge** — how far ahead of the market price to require before buying
- **Stake per trade** — fixed dollars per position
- **Stop after losing** — daily loss limit
- **How much to trust the model** — 0 ignores its call entirely
- **Don't enter with less than** — seconds left on the clock
- **Paper / Live**

## Layout

```
src/lib/
  pyth.ts        price feed (+ the Chainlink cross-check)
  market.ts      finding the live 5-minute market
  book.ts        order book maths, and the paper fill model
  clob.ts        Polymarket reads
  llm.ts         the prompt, the call, and tolerant parsing
  montecarlo.ts  the per-second probability update
  engine.ts      the loop
  live.ts        real order placement
  store.ts       trade history
src/app/api/     server routes — all secrets, all validation
src/components/  the app
```

## Tests

```bash
npm test
```

25 tests, no network needed. The ones that matter: the simulation reproduces the
prior it was given when the full window remains, collapses when price has moved
against the call, and ignores the model entirely at zero weight; malformed model
replies are rejected rather than guessed at; paper fills walk real depth and
report shortfalls; the forecast call shares one timeout budget across retries and
fails fast on a bad key.

## Known limits

- **The tab must stay open.** The loop runs in the browser. Closing it stops
  trading, which is the safer default anyway.
- **The price is a proxy**, not the settlement feed. See above.
- **Paper settlement uses our feed**, so it can disagree with the on-chain result
  at the boundary on a very close window.
- **The edge may not exist.** A five-minute Bitcoin binary is close to a coin
  flip and Polymarket's book is not naive. Run paper mode until the numbers say
  something before risking real money.

Not financial advice.
