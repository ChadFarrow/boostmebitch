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
      // services/nostr-index is a separate deployable with its own package.json,
      // tsconfig and dependencies. Linting it under the Next config reports
      // rules that do not apply to a Node service and, like the worktree case
      // above, drowns real problems in noise.
      'services/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // A disable comment that no longer suppresses anything is reported, so a
    // `react-hooks/exhaustive-deps` disable whose dep array later became
    // correct does not sit there forever, unaudited. This was `'off'` to hide
    // 39 `no-console` disables that targeted a rule the config never enabled;
    // those comments are gone. `'warn'` rather than `'error'` so a plugin
    // upgrade that changes what a rule reports cannot break `npm run lint`
    // — a warning here is a comment to delete, not a build to fix.
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
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
