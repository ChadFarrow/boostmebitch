import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  { ignores: ['node_modules/**', '.next/**', 'public/sw.js', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // Existing inline `eslint-disable-next-line no-console` comments (amber.ts)
    // target a rule we don't enable; ESLint 9 would otherwise report them all
    // as unused directives.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // lib/pi.ts deliberately types PI's untyped JSON as `any` throughout.
      '@typescript-eslint/no-explicit-any': 'off',
      // `catch (e) { /* use fallback */ }` is idiomatic here.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
];

export default config;
