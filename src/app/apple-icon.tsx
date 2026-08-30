import { ImageResponse } from 'next/og';

// iOS applies its own rounding to home-screen icons, so this stays a plain
// filled square — no radius, no transparency.
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
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
        <span style={{ color: '#5b9bf0', fontSize: 108, fontWeight: 700, fontFamily: 'system-ui, sans-serif' }}>
          V
        </span>
      </div>
    ),
    { ...size }
  );
}
