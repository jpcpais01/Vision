import { ImageResponse } from 'next/og';

export const runtime = 'nodejs';

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
          borderRadius: 112,
        }}
      >
        <span style={{ color: '#5b9bf0', fontSize: 320, fontWeight: 700, fontFamily: 'system-ui, sans-serif' }}>
          V
        </span>
      </div>
    ),
    { width: 512, height: 512 }
  );
}
