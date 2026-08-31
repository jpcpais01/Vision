'use client';

import { useState } from 'react';

export function TokenGate({ onSubmit }: { onSubmit: (v: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <main className="grid min-h-screen place-items-center px-6">
      <form
        className="card w-full max-w-sm space-y-3 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value.trim());
        }}
      >
        <h1 className="text-base font-semibold">Enter access token</h1>
        <p className="text-xs text-[var(--muted)]">
          This deployment is protected. The token stays in this tab and is sent as a header.
        </p>
        <input type="password" className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="btn btn-primary w-full justify-center py-2">
          Unlock
        </button>
      </form>
    </main>
  );
}
