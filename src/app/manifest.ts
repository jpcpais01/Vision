import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Vision — BTC mean reversion',
    short_name: 'Vision',
    description: 'Paper-trades Bitcoin mean reversion against a live Monte Carlo simulation, on Binance.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b0e14',
    theme_color: '#0b0e14',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
