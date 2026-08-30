import type { Config } from 'tailwindcss';

/** Colours live in CSS custom properties (globals.css) so both themes swap in
 *  one place; Tailwind here only handles layout and spacing. */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};

export default config;
