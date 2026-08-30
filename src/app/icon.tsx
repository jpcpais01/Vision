import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
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
          borderRadius: 7,
        }}
      >
        <span style={{ color: '#5b9bf0', fontSize: 20, fontWeight: 700, fontFamily: 'system-ui, sans-serif' }}>
          V
        </span>
      </div>
    ),
    { ...size }
  );
}
