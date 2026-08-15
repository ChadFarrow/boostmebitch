import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'public/sw.js',
      'next-env.d.ts',
      // Git worktrees live under `.claude/worktrees/` by convention and are
      // full checkouts of this repo. Git ignores them via .git/info/exclude,
      // but ESLint's flat config has no notion of git excludes — so without
      // this, creating one makes `npm run lint` walk a second copy of the
      // entire source tree and report thousands of duplicate problems, which
      // is indistinguishable from having broken the build.
      '.claude/**',
    ],
  },
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
