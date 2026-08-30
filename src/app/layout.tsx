import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vision — Polymarket BTC 5m',
  description:
    'Conditional Monte Carlo trading system for Polymarket Bitcoin 5-minute UP/DOWN markets.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#070a10',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
