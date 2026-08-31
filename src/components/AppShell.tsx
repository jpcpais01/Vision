'use client';

import { useEngineContext } from './EngineProvider';
import { TokenGate } from './TokenGate';
import { Header } from './Header';

/**
 * The whole app fits in one viewport — no page scroll. `100dvh` (not `vh`)
 * so mobile browser chrome collapsing/expanding doesn't leave a sliver of
 * dead space or clip the bottom. Header is fixed height; everything below
 * it is one flex column that divides up whatever's left, with the chart
 * itself getting the lion's share — see StrategyDashboard.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const v = useEngineContext();
  if (v.needsToken) return <TokenGate onSubmit={v.setToken} />;
  return (
    <div className="relative flex h-[100dvh] flex-col overflow-hidden">
      <div className="scanlines" />
      <Header />
      <main className="relative z-10 mx-auto flex w-full max-w-[900px] flex-1 flex-col gap-2 overflow-hidden px-3 pb-2">
        {children}
      </main>
    </div>
  );
}
