'use client';

import { useEffect, useState } from 'react';
import { useEngine } from '@/hooks/useEngine';
import { WINDOW_SECONDS } from '@/lib/config';
import { Badge, Panel, Stat } from '@/components/ui/Primitives';
import { StatusBar } from '@/components/panels/StatusBar';
import { ControlsPanel } from '@/components/panels/ControlsPanel';
import { LlmPanel } from '@/components/panels/LlmPanel';
import { MonteCarloPanel } from '@/components/panels/MonteCarloPanel';
import { DecisionPanel } from '@/components/panels/DecisionPanel';
import { OrderBookPanel } from '@/components/panels/OrderBookPanel';
import { TradesTable } from '@/components/panels/TradesTable';
import { MetricsPanel } from '@/components/panels/MetricsPanel';
import { HistoryPanel } from '@/components/panels/HistoryPanel';
import { LogsPanel } from '@/components/panels/LogsPanel';
import { PriceChart } from '@/components/charts/PriceChart';
import { ProbabilityChart } from '@/components/charts/ProbabilityChart';
import { clock, cx, pct, usd } from '@/lib/format';

const PHASE_LABEL: Record<string, string> = {
  idle: 'Idle',
  'awaiting-market': 'Awaiting market',
  'capturing-open': 'Capturing barrier',
  'llm-pending': 'Forecast in flight',
  monitoring: 'Monitoring',
  positioned: 'Positioned',
  settling: 'Settling',
  settled: 'Settled',
};

export default function Dashboard() {
  const {
    engine,
    snapshot,
    config,
    health,
    liveBlockers,
    booting,
    fatal,
    authRequired,
    token,
    setToken,
    updateConfig,
    start,
    stop,
    engageKillSwitch,
    resetRecords,
  } = useEngine();

  const [tab, setTab] = useState<'live' | 'performance' | 'history'>('live');

  // Re-render on a 1s cadence so clocks and "age" readouts stay honest even
  // when no market data has arrived.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (authRequired) {
    return <TokenGate token={token} onSubmit={setToken} />;
  }

  const { cycle, market, secondsLeft, elapsedSec, btc } = snapshot;
  const upBook = snapshot.upTokenId ? (snapshot.books[snapshot.upTokenId] ?? null) : null;
  const downBook = snapshot.downTokenId ? (snapshot.books[snapshot.downTokenId] ?? null) : null;
  const upQuote = snapshot.upTokenId ? (snapshot.quotes[snapshot.upTokenId] ?? null) : null;
  const downQuote = snapshot.downTokenId ? (snapshot.quotes[snapshot.downTokenId] ?? null) : null;

  const openTrade = snapshot.trades.find(
    (t) => t.marketId === market?.id && (t.status === 'OPEN' || t.status === 'PENDING')
  );

  const modelP = cycle.finalPUp;
  const marketP = upQuote?.mid ?? null;
  const disagreement = modelP !== null && marketP !== null ? modelP - marketP : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-[1680px] flex-col gap-3 p-3 lg:p-4">
      <StatusBar
        snapshot={snapshot}
        config={config}
        llmAvailable={health?.capabilities.llm ?? false}
        onToggleAuto={(v) => void updateConfig({ autoTrade: v })}
        onStart={() => void start()}
        onStop={stop}
        onKill={(v) => void engageKillSwitch(v)}
      />

      {fatal ? (
        <div className="panel border-down/40 px-4 py-2.5 text-xs text-down">
          Backend unreachable: {fatal}
        </div>
      ) : null}

      {snapshot.errors.length > 0 ? (
        <div className="panel border-warn/30 px-4 py-2 text-2xs text-warn">
          {snapshot.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      ) : null}

      {!snapshot.running && !booting ? (
        <IntroBanner
          hasLlm={health?.capabilities.llm ?? false}
          storage={health?.storage ?? 'memory'}
          model={health?.capabilities.model ?? ''}
          onStart={() => void start()}
        />
      ) : null}

      {/* Tabs */}
      <nav className="flex gap-1">
        {(['live', 'performance', 'history'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cx(
              'rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors',
              tab === t
                ? 'border-accent/50 bg-accent/15 text-accent'
                : 'border-base-700 text-slate-500 hover:text-slate-300'
            )}
          >
            {t === 'live' ? 'Live cycle' : t === 'performance' ? 'Performance' : 'Window history'}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-2xs text-slate-600">
          <span>{PHASE_LABEL[cycle.phase] ?? cycle.phase}</span>
          {cycle.startPriceSource === 'estimated' ? (
            <Badge tone="warn" title="Joined mid-window: the barrier is inferred from the nearest bar, not observed at the open">
              barrier estimated
            </Badge>
          ) : null}
          {health && health.storage === 'upstash' && !health.storageOk ? (
            <Badge
              tone="down"
              title={`Upstash is configured but unreachable: ${health.storageError ?? 'unknown error'}`}
            >
              storage unreachable
            </Badge>
          ) : health?.storage === 'memory' ? (
            <Badge tone="muted" title="Set UPSTASH_REDIS_REST_URL and _TOKEN for durable history across cold starts">
              in-memory storage
            </Badge>
          ) : health?.storage === 'upstash' ? (
            <Badge tone="up" title={`Upstash reachable in ${health.storageLatencyMs}ms`}>
              durable storage
            </Badge>
          ) : null}
        </div>
      </nav>

      {tab === 'live' ? (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-3">
            {/* Headline numbers */}
            <section className="panel grid grid-cols-2 gap-4 px-4 py-3 sm:grid-cols-4 lg:grid-cols-6">
              <Stat
                label="Model P(UP)"
                value={modelP !== null ? pct(modelP, 1) : '—'}
                tone={modelP === null ? 'muted' : modelP >= 0.5 ? 'up' : 'down'}
                size="lg"
                sub={cycle.mc ? `±${(cycle.mc.standardError * 100).toFixed(2)}pp` : 'no simulation'}
              />
              <Stat
                label="Market P(UP)"
                value={marketP !== null ? pct(marketP, 1) : '—'}
                size="lg"
                sub={
                  upQuote?.bid != null && upQuote?.ask != null
                    ? `${upQuote.bid.toFixed(3)} / ${upQuote.ask.toFixed(3)}`
                    : 'no book'
                }
              />
              <Stat
                label="Disagreement"
                value={
                  disagreement !== null
                    ? `${disagreement >= 0 ? '+' : ''}${(disagreement * 100).toFixed(1)}pp`
                    : '—'
                }
                tone={
                  disagreement === null
                    ? 'muted'
                    : Math.abs(disagreement) >= config.minEdge
                      ? 'accent'
                      : 'neutral'
                }
                size="lg"
                sub={`min edge ${(config.minEdge * 100).toFixed(1)}¢`}
              />
              <Stat
                label="Barrier"
                value={cycle.startPrice !== null ? usd(cycle.startPrice) : '—'}
                size="lg"
                sub={
                  btc !== null && cycle.startPrice !== null
                    ? `${btc - cycle.startPrice >= 0 ? '+' : ''}${(btc - cycle.startPrice).toFixed(2)} now`
                    : 'not captured'
                }
                tone={
                  btc !== null && cycle.startPrice !== null
                    ? btc > cycle.startPrice
                      ? 'up'
                      : 'down'
                    : 'muted'
                }
              />
              <Stat
                label="Realised vol"
                value={snapshot.vol ? `${snapshot.vol.annualisedPct.toFixed(0)}%` : '—'}
                size="lg"
                sub={
                  snapshot.vol
                    ? `${(snapshot.vol.sigma10s * 10_000).toFixed(1)} bps / 10s`
                    : 'building'
                }
              />
              <Stat
                label="Session P&L"
                value={`${snapshot.metrics.pnl >= 0 ? '+' : '-'}$${Math.abs(snapshot.metrics.pnl).toFixed(2)}`}
                tone={
                  snapshot.metrics.pnl > 0 ? 'up' : snapshot.metrics.pnl < 0 ? 'down' : 'neutral'
                }
                size="lg"
                sub={`${snapshot.metrics.resolved} resolved · ${pct(snapshot.metrics.winRate, 0)} win`}
              />
            </section>

            <Panel
              title="Bitcoin — current window"
              subtitle={
                market
                  ? `T+${clock(elapsedSec)} of ${clock(WINDOW_SECONDS)} · ${clock(secondsLeft)} left`
                  : 'no market'
              }
              actions={
                openTrade ? (
                  <Badge tone={openTrade.side === 'UP' ? 'up' : 'down'}>
                    holding {openTrade.size} {openTrade.side} @ {openTrade.entryPrice.toFixed(3)}
                  </Badge>
                ) : null
              }
              bodyClassName="p-3"
            >
              <PriceChart
                bars={snapshot.bars}
                ticksLive={snapshot.recentTicks}
                barrier={cycle.startPrice}
                windowStartMs={market?.startMs ?? null}
                windowEndMs={market?.endMs ?? null}
                llmDispatchedAt={cycle.llmDispatchedAt}
                llmRespondedAt={
                  cycle.llm && cycle.llmDispatchedAt
                    ? cycle.llmDispatchedAt + cycle.llm.latencyMs
                    : null
                }
                tradeAt={openTrade?.t ?? null}
              />
            </Panel>

            <Panel
              title="Probability evolution"
              subtitle="Monte Carlo re-conditions on every tick; the LLM answered once"
              bodyClassName="p-3"
            >
              <ProbabilityChart history={cycle.history} />
            </Panel>

            <div className="grid gap-3 lg:grid-cols-2">
              <Panel title="Order book" subtitle="live Polymarket CLOB">
                <OrderBookPanel
                  upBook={upBook}
                  downBook={downBook}
                  upQuote={upQuote}
                  downQuote={downQuote}
                  modelPUp={modelP}
                />
              </Panel>
              <Panel title="Decision" subtitle="every gate, live">
                <DecisionPanel cycle={cycle} config={config} secondsLeft={secondsLeft} />
              </Panel>
            </div>

            <Panel title="Trades" subtitle={`${snapshot.trades.length} this session`}>
              <TradesTable trades={snapshot.trades} />
            </Panel>
          </div>

          {/* Right rail */}
          <div className="flex flex-col gap-3">
            <Panel
              title="LLM forecast"
              subtitle={health?.capabilities.model}
              actions={
                <button
                  type="button"
                  className="btn btn-default px-2 py-1"
                  onClick={() => engine?.forceForecast()}
                  disabled={!snapshot.running || cycle.startPrice === null}
                  title="Request a fresh forecast for this window"
                >
                  refetch
                </button>
              }
            >
              <LlmPanel cycle={cycle} btc={btc} />
            </Panel>

            <Panel title="Monte Carlo update" subtitle="conditional on the realised path">
              <MonteCarloPanel cycle={cycle} btc={btc} shrink={config.probabilityShrink} />
            </Panel>

            <Panel title="Configuration">
              <ControlsPanel
                config={config}
                onChange={(patch) => void updateConfig(patch)}
                liveBlockers={liveBlockers}
              />
            </Panel>

            <Panel
              title="Event log"
              actions={
                <button
                  type="button"
                  className="btn btn-default px-2 py-1"
                  onClick={() => void resetRecords('logs')}
                >
                  clear
                </button>
              }
              className="min-h-[240px]"
            >
              <LogsPanel logs={snapshot.logs} />
            </Panel>
          </div>
        </div>
      ) : null}

      {tab === 'performance' ? (
        <Panel
          title="Performance & calibration"
          subtitle={`${snapshot.metrics.resolved} resolved trades · ${snapshot.cycles.length} observed windows`}
          actions={
            <button
              type="button"
              className="btn btn-danger px-2 py-1"
              onClick={() => {
                if (confirm('Delete all trades, cycles and logs? This cannot be undone.')) {
                  void resetRecords('all');
                }
              }}
            >
              reset records
            </button>
          }
        >
          <MetricsPanel
            metrics={snapshot.metrics}
            trades={snapshot.trades}
            cycles={snapshot.cycles}
          />
        </Panel>
      ) : null}

      {tab === 'history' ? (
        <Panel
          title="Window history"
          subtitle="every 5-minute market observed, traded or not"
        >
          <HistoryPanel cycles={snapshot.cycles} />
        </Panel>
      ) : null}

      <footer className="pb-2 text-center text-2xs leading-relaxed text-slate-600">
        Live market data from Polymarket&apos;s CLOB and public exchange feeds. PAPER mode
        simulates fills against the real book; LIVE mode submits real orders with real funds.
        Nothing here is financial advice, and short-horizon crypto binaries are close to a
        coin flip by construction — treat any measured edge as provisional until the
        calibration curve says otherwise.
      </footer>
    </main>
  );
}

function IntroBanner({
  hasLlm,
  storage,
  model,
  onStart,
}: {
  hasLlm: boolean;
  storage: string;
  model: string;
  onStart: () => void;
}) {
  return (
    <div className="panel flex flex-wrap items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-sm font-semibold text-slate-100">Engine stopped</h1>
        <p className="mt-0.5 text-2xs leading-relaxed text-slate-400">
          Starting connects the BTC tape and the Polymarket order book, then runs one
          cycle per 5-minute window: capture the barrier at the open, send an hour of
          10-second history to <span className="text-slate-300">{model || 'the model'}</span>,
          keep recording BTC while it answers, re-condition with a Monte Carlo simulation
          from the price now, and compare the result against the executable ask.
          {' '}Auto-trade stays off until you switch it on.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {!hasLlm ? (
          <Badge tone="warn">OPENROUTER_API_KEY missing — forecasts will fail</Badge>
        ) : null}
        {storage === 'memory' ? (
          <Badge tone="muted">memory storage — history is lost on cold start</Badge>
        ) : null}
        <button type="button" className="btn btn-primary px-4 py-2" onClick={onStart}>
          Start engine
        </button>
      </div>
    </div>
  );
}

function TokenGate({
  token,
  onSubmit,
}: {
  token: string;
  onSubmit: (v: string) => void;
}) {
  const [value, setValue] = useState(token);
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form
        className="panel w-full max-w-sm space-y-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value.trim());
        }}
      >
        <h1 className="text-sm font-semibold text-slate-100">Access token required</h1>
        <p className="text-2xs leading-relaxed text-slate-400">
          This deployment sets <code className="text-slate-300">VISION_ACCESS_TOKEN</code>,
          so every API call needs it. The token is kept in this tab&apos;s session storage
          and sent as a request header — it is never written to the URL.
        </p>
        <input
          type="password"
          className="field"
          value={value}
          autoFocus
          placeholder="access token"
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="btn btn-primary w-full py-2">
          Unlock
        </button>
      </form>
    </main>
  );
}
