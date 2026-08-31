'use client';

import { useEngineContext } from './EngineProvider';
import { TokenGate } from './TokenGate';
import { Header } from './Header';

export function AppShell({ children }: { children: React.ReactNode }) {
  const v = useEngineContext();
  if (v.needsToken) return <TokenGate onSubmit={v.setToken} />;
  return (
    <>
      <Header />
      <main className="mx-auto flex min-h-screen max-w-[880px] flex-col gap-4 px-4 pb-16 pt-4">{children}</main>
    </>
  );
}
