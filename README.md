# Vision — Polymarket BTC 5-minute UP/DOWN

A production-ready Next.js/TypeScript trading system for Polymarket's Bitcoin
5-minute UP/DOWN binary markets. It runs on Vercel, uses the official Polymarket
CLOB APIs and WebSockets, real exchange price data, the Chainlink BTC/USD
reference feed, and an LLM forecast through OpenRouter — refined by a conditional
Monte Carlo probability updater before anything is traded.

Two modes: **PAPER** (entirely real market data, simulated fills) and **LIVE**
(real orders, real money, behind three independent safety gates).

---

## What it actually does

Each 5-minute window runs one cycle:

1. **Capture the barrier.** The market resolves on whether BTC closes above its
   price at the window's open. That price is captured to the tick and is the
   single number every downstream probability refers to.
2. **Send the tape to the LLM.** The last hour of 10-second closes goes to
   `deepseek/deepseek-v4-flash-0731` via OpenRouter, encoded as dollar offsets
   from the barrier, with realised volatility, multi-horizon returns and the
   random-walk anchor precomputed. The model is asked for a **calibrated
   probability**, told 0.50 is the right answer when it has no view, and told it
   is scored by Brier.
3. **Keep recording while it thinks.** The BTC path continues to accumulate
   during the model's round trip. Those seconds are not dead time — they are the
   information the model could not have had.
4. **Run the conditional Monte Carlo.** When the forecast lands:
   - realised volatility is re-estimated from recent 10-second returns;
   - the LLM's P(UP) is converted into a **drift**, not blended as a number —
     the drift `m = σ·Φ⁻¹(p)/√T` is the one consistent with that probability
     under the estimated volatility;
   - simulation starts from the price **now**, so the already-realised portion of
     the window is carried in the initial condition rather than re-simulated;
   - only the remaining seconds are simulated;
   - P(UP) is the share of paths finishing above the barrier.
5. **Compare against the executable book.** The updated probability is compared
   against the real Polymarket CLOB ask, not the midpoint, and the trade is taken
   only if every edge, liquidity, spread, timing and risk gate passes.
6. **Settle and score.** The window is recorded whether or not it was traded,
   with the forecast, the simulation, the book, the decision and the reason for
   any rejection.

The behaviour this buys you: a bullish LLM call that BTC has already run 40 bps
against, with 60 seconds left, comes out of the updater as a *low* probability —
because the drift needed to recover the barrier in the time remaining is
implausible under the realised volatility. A naive pipeline would still trade it.

---

## Quick start

```bash
npm install
cp .env.example .env.local     # add OPENROUTER_API_KEY at minimum
npm run dev                    # http://localhost:3000
```

Press **Start engine**. It connects the feeds and runs cycles immediately;
**Auto-trade** stays off until you switch it on, so you can watch it decide
before you let it act.

```bash
npm test          # 62 tests: quant core, risk gates, parsing, metrics
npm run typecheck
npm run build
```

## Deploying to Vercel

1. Push this repo and import it at [vercel.com/new](https://vercel.com/new).
   The framework preset is detected; no build configuration is needed.
2. Add the environment variables below under **Settings → Environment
   Variables**. Every one of them is server-side; none is prefixed
   `NEXT_PUBLIC_`, and none is ever returned to the browser.
3. Deploy.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | **yes** | Forecasts fail without it; everything else still runs. |
| `OPENROUTER_MODEL` | no | Defaults to `deepseek/deepseek-v4-flash-0731`. |
| `VISION_ACCESS_TOKEN` | strongly recommended | When set, every API route requires an `x-vision-token` header and the UI asks for it once. A Vercel URL is public by default — and in LIVE mode this dashboard spends money. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | recommended | Durable trade and window history. Without them, state lives in process memory and is wiped on every serverless cold start. |
| `CHAINLINK_RPC_URL` | no | Any Ethereum mainnet JSON-RPC endpoint. Defaults to a public node. |
| `CHAINLINK_BTC_USD_FEED` | no | Defaults to the mainnet BTC/USD aggregator. |
| `POLYMARKET_PRIVATE_KEY` | LIVE only | Polygon key of the wallet holding USDC.e. |
| `POLYMARKET_FUNDER_ADDRESS` | LIVE only | Set if funds sit in a Polymarket proxy/Safe wallet. |
| `POLYMARKET_SIGNATURE_TYPE` | LIVE only | `0` EOA, `1` email/magic proxy, `2` browser-wallet Safe proxy. |
| `POLYMARKET_API_KEY` / `_SECRET` / `_PASSPHRASE` | no | Pre-derived L2 credentials; derived from the private key on first use if omitted. |
| `ALLOW_LIVE_TRADING` | LIVE only | Must be exactly `true`. LIVE orders are refused otherwise, whatever the UI says. |

See `.env.example` for the annotated full list.

### Setting up durable storage (Upstash Redis)

Without this, trades and window history live in process memory and are wiped on
every serverless cold start — which is exactly the data a paper test exists to
produce. The free tier is more than enough: the app writes a couple of small
records per 5-minute window.

1. Create a database at [console.upstash.com](https://console.upstash.com) →
   **Create Database**. Pick the region closest to your Vercel deployment region
   (every write is a round trip); type **Regional** is fine.
2. On the database page open the **REST API** tab and copy the two values
   labelled `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Use the
   **REST** credentials, not the `redis://` connection string — this app speaks
   Upstash's HTTP API so it works from any runtime with no connection pooling.
3. Set both, locally in `.env.local` and in **Vercel → Settings → Environment
   Variables**:

   ```bash
   UPSTASH_REDIS_REST_URL=https://your-db-12345.upstash.io
   UPSTASH_REDIS_REST_TOKEN=AX...
   ```

4. Restart (Vercel: redeploy — env changes are not picked up by a running
   deployment) and confirm it took:

   ```bash
   curl -s https://your-app.vercel.app/api/health | jq '{storage, storageOk, storageLatencyMs, storageError}'
   # { "storage": "upstash", "storageOk": true, "storageLatencyMs": 34, "storageError": null }
   ```

   The dashboard shows the same thing as a badge beside the tab bar: **durable
   storage** (green) when the round trip succeeds, **storage unreachable** (red)
   with the error on hover when the credentials are configured but wrong, and
   **in-memory storage** (grey) when they are absent. Configured is not the same
   as reachable, so the health check actually issues a `PING` rather than
   inferring from the presence of the variables.

Alternatively, if you deploy on Vercel you can add the Upstash integration from
the **Storage** tab of your project — it injects both variables for you and no
manual copying is needed.

**What gets stored.** Five keys under a `vision:` prefix: `config`,
`killswitch`, and hashes of `trades`, `cycles` and `logs`. Trades and cycles are
keyed by id so a re-post of an updated record (`PENDING` → `OPEN` → `WON`)
overwrites rather than duplicating, which is what makes the persistence retryable
after a dropped connection. History is capped at 2,000 trades, 2,000 windows and
1,000 log lines. **Reset records** in the Performance tab clears them.

---

## Enabling LIVE mode

Three independent conditions must all hold before a single real order is sent:

1. `ALLOW_LIVE_TRADING=true` **in the server environment** — not a UI toggle.
2. `POLYMARKET_PRIVATE_KEY` configured server-side.
3. The request asks for LIVE mode and the server-side kill switch is off.

The wallet must already be set up for Polymarket: USDC.e on Polygon, the CTF
Exchange contracts approved, and the account registered. Vision does not handle
onboarding or approvals — it places orders against an account that already works.

**The client proposes; the server disposes.** Nothing the browser sends is
trusted for anything that matters. On every order the server re-fetches the order
book, re-clamps size against the server-held risk config, re-checks the price
bounds and spread, and reads the kill switch. Editing the request in devtools
cannot exceed a configured cap.

## Safety controls

- **Kill switch** — sets a server-side flag checked on every order request (so a
  stale browser tab cannot trade through it), cancels every resting order on the
  account, forces auto-trade off, and stops the engine.
- **Risk limits** — max position in dollars and as a fraction of bankroll, max
  concurrent positions, trades per hour, trades per day, daily loss limit, and a
  consecutive-loss circuit breaker. All are enforced server-side and all are
  clamped into documented bounds on write.
- **Fractional Kelly** — position size is Kelly `(p − ask)/(1 − ask)` scaled by a
  configurable fraction, then hard-capped. Full Kelly assumes the probability is
  exactly right; this one is an estimate.
- **Probability haircuts** — the simulation's own standard error is always
  subtracted *against* the trade, and the final probability is shrunk toward 0.50
  before sizing. Monte Carlo noise can never manufacture an edge.
- **Access token** — optional shared secret on every route, compared in constant
  time.

---

## Architecture

```
Browser (the trading loop)              Vercel functions (secrets + validation)
├── Binance/Coinbase/Kraken WS   ─┐     ├── /api/price/history   1h of 10s bars
├── Polymarket CLOB market WS    ─┤     ├── /api/price/tick      polling fallback
├── 10s bar aggregation          ─┤     ├── /api/price/chainlink oracle reference
├── volatility estimation        ─┼───▶ ├── /api/market          Gamma discovery
├── conditional Monte Carlo      ─┤     ├── /api/book            CLOB books
├── decision + risk gates        ─┤     ├── /api/llm/forecast    OpenRouter
└── React dashboard              ─┘     ├── /api/trade           paper + live exec
                                        ├── /api/killswitch      emergency stop
                                        └── /api/state           durable record
```

**Why the loop lives in the browser.** The window is 300 seconds, the LLM round
trip is a meaningful fraction of it, and every hop through a serverless function
is latency spent on a clock that does not stop. A direct exchange WebSocket
delivers a trade in tens of milliseconds; a polled serverless proxy adds a cold
start, a region hop and a poll interval. So the browser keeps the tape and the
clock, and the server keeps the secrets, re-validates every order, and stores the
record. Both feeds fall back to authenticated server polling when a socket cannot
be established, and the dashboard says which path it is on.

### Data sources

| Purpose | Source | Notes |
|---|---|---|
| 10-second BTC history | Binance 1s klines | The only public REST source that can reconstruct true 10s resolution an hour deep. Six hostnames are tried in turn. |
| Live BTC ticks | Binance / Coinbase / Kraken trade WS | Direct from the browser; falls back to server polling. |
| Degraded history | Coinbase / Kraken 60s candles | Upsampled to the 10s grid and **flagged as interpolated** in the UI, because it understates realised volatility. |
| Settlement reference | Chainlink BTC/USD aggregator | Read over JSON-RPC. These markets settle on an oracle, so the basis against the exchange feed is tracked and displayed, never hidden. |
| Markets | Polymarket Gamma API | Discovered by filtering open markets for the asset, the up/down framing, and a genuine 5-minute span — not a hard-coded slug, which has changed before. |
| Order books | Polymarket CLOB REST + market WS | Deltas applied locally, reconciled against REST on a slow timer regardless. |

### Layout

```
src/lib/math/          normal distribution, xoshiro128** PRNG, statistics
src/lib/quant/         volatility, Monte Carlo, calibration & metrics
src/lib/price/         exchange sources, Chainlink, 10s aggregation
src/lib/polymarket/    Gamma discovery, book maths, REST, live execution
src/lib/llm/           prompt construction, OpenRouter, tolerant parsing
src/lib/engine/        the cycle state machine, feeds, risk gates
src/components/        dashboard, panels, hand-rolled SVG charts
src/app/api/           server routes (all secrets, all validation)
```

---

## The dashboard

- **Live cycle** — BTC against the barrier with the LLM dispatch, forecast and
  entry marked on the path; the three probabilities (Monte Carlo, LLM prior,
  market mid) over the window; both order books with depth; the simulated
  terminal distribution split at the barrier; and every decision gate with its
  live value against its threshold.
- **Performance** — cumulative P&L, win rate with a Wilson interval, Brier score
  and skill, log loss, calibration error, drawdown, Sharpe, and a reliability
  diagram.
- **Window history** — every observed 5-minute market, traded or not, with what
  the model thought, what the market offered, and which gate stopped the trade.

**Read Brier before P&L.** Over a few dozen 5-minute binaries, P&L is almost pure
noise; Brier score and the calibration curve converge fast enough to tell you
whether the model knows anything. Below 20 resolved trades the dashboard says so
rather than leaving you to infer it. Calibration is scored over *every* observed
window, not only the traded ones — restricting to trades would sample only the
windows where the model disagreed with the market, which is precisely the biased
subset.

Chart colours were validated for colour-vision deficiency against the dark chart
surface. UP/DOWN never rely on colour alone: every such readout also carries the
literal word or a signed number.

---

## Testing

62 tests, no network required:

- **Monte Carlo against closed form.** The simulated probability is checked
  against the analytic Gaussian answer across five market states, including
  cases with a non-neutral prior — agreement within ~1pp.
- **Conditional behaviour.** A 75% bullish prior with BTC $150 down and 30
  seconds left must produce < 5%. A prior-aligned move must produce > 90%. With
  the full window remaining and full prior weight, the simulation must reproduce
  the prior itself, which is the definition of the drift solve.
- **Volatility.** Unbiased recovery of a known sigma across twelve draws, and a
  spliced calm→violent series to confirm the estimator tracks a regime shift
  rather than averaging the hour.
- **Every risk gate**, blocked in isolation, plus sizing caps, Kelly scaling and
  config sanitisation against hostile input.
- **Fill simulation** — walking the book, honest partials, and never paying
  through the configured maximum price.
- **LLM parsing** — fenced JSON, prose, nested objects, percentages, and
  malformed probabilities, which are *rejected* rather than coerced.

---

## Known limits

- **Settlement.** In PAPER mode, outcomes are computed from the observed feed
  price at the window close. In LIVE mode the on-chain oracle resolution is
  authoritative and can differ at the boundary — which is why the Chainlink basis
  is tracked and shown throughout the window.
- **Barrier accuracy.** If the engine starts mid-window it infers the barrier
  from the nearest bar and labels it `estimated`. That can be a dollar or two out,
  which is a real edge error; the UI flags it rather than hiding it.
- **In-memory storage.** Without Upstash configured, history does not survive a
  serverless cold start.
- **Interpolated feeds.** If Binance is unreachable, 60-second candles are
  upsampled. Volatility is then understated and the UI marks the feed
  `interpolated`.
- **The edge may not exist.** A 5-minute Bitcoin binary is close to a coin flip
  by construction, and Polymarket's book is not naive. Run PAPER for long enough
  that the calibration curve is meaningful before risking anything.

## Disclaimer

This is software for trading real money on real markets. It is not financial
advice. Run it in PAPER mode until you understand exactly what it does, and never
give the LIVE wallet more than you can afford to lose.
