import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0a0a08',
        bone: '#f5f1e8',
        bolt: '#fae500',
        nostr: '#ff2d92',
        muted: '#8a857a',
        line: '#1f1d18',
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        pulse_bolt: {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
      },
      animation: {
        bolt: 'pulse_bolt 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
export default config;
