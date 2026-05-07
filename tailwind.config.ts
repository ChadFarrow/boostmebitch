import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Role tokens — values come from CSS variables defined in
        // app/globals.css (:root for dark, :root[data-theme="light"] for light).
        // `ink` = page bg, `bone` = primary fg; their values swap between
        // themes, so existing classes (bg-ink, text-bone, bg-ink/75 etc.)
        // keep working unchanged.
        ink: 'rgb(var(--ink) / <alpha-value>)',
        bone: 'rgb(var(--bone) / <alpha-value>)',
        bolt: 'rgb(var(--bolt) / <alpha-value>)',
        nostr: 'rgb(var(--nostr) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
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
