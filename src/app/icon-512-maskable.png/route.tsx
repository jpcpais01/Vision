import { ImageResponse } from 'next/og';

export const runtime = 'nodejs';

// Maskable icons get cropped into arbitrary shapes (circle, squircle, ...) by
// the OS, so the background must be full-bleed (no radius baked in here) and
// the glyph kept well inside the ~80%-diameter safe zone.
export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b0e14',
        }}
      >
        <span style={{ color: '#5b9bf0', fontSize: 200, fontWeight: 700, fontFamily: 'system-ui, sans-serif' }}>
          V
        </span>
      </div>
    ),
    { width: 512, height: 512 }
  );
}
