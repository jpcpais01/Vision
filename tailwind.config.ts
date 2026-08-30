import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: {
          950: '#070a10',
          900: '#0b0f17',
          850: '#0f141e',
          800: '#141b27',
          700: '#1c2536',
          600: '#2a3547',
          500: '#3c4a60',
        },
        // Palette validated with the dataviz skill's checker against the
        // dark chart surface (#0f141e), all pairs. UP/DOWN are a polarity
        // pair chosen for colour-vision separation (deltaE 27.5 normal, and
        // they clear the CVD gate) — and they are never the only cue: every
        // UP/DOWN readout also carries the literal word or a signed number.
        up: { DEFAULT: '#199e70', dim: '#0d2e24' },
        down: { DEFAULT: '#e66767', dim: '#3a1f21' },
        accent: { DEFAULT: '#3987e5', dim: '#122438' },
        warn: { DEFAULT: '#fab219', dim: '#3a2c0f' },
        // Categorical series slots: blue / magenta / yellow.
        series: {
          mc: '#3987e5',
          llm: '#d55181',
          mkt: '#c98500',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};

export default config;
