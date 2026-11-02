// `npm run beta:test` — drives scripts/beta.mjs against real git, in temporary
// repositories, with a fake `gh` first on PATH. No network, no real GitHub.
//
// WHY THIS IS NOT A `check:*`. Those pin a pure function whose silent breakage
// costs a user something irreversible, and `npm run check` gates a ship on them.
// This pins a developer tool whose worst failure is a beta site with the wrong
// PRs on it. What it does share with them is the rule that it runs the REAL
// thing: every assertion below reads what git holds afterwards, never what the
// script printed about it, except where the printed line IS the contract.
//
// Each block names the break it catches:
// - the checkout moves or loses work: the script is run from a dirty feature
//   branch, because that is where Chad is when he runs it;
// - a push happens: the bare origin is read directly;
// - a squash-merged PR stays listed: a merge then conflicts for no real reason;
// - a refusal half-applies: the local `beta` sha is compared before and after.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checker, exit } from './cdp.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'beta.mjs');
const PUSH_LINE = 'git push --force-with-lease origin beta';
const t = checker();
const root = mkdtempSync(join(tmpdir(), 'bmb-beta-test-'));

const FAKE_GH = `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const fx = JSON.parse(readFileSync(process.env.GH_FIXTURE, 'utf8'));
if (fx.fail) { console.error('gh: could not reach GitHub'); process.exit(1); }
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'view') {
  const pr = fx.view[a[2]];
  if (!pr) { console.error('no pull requests found'); process.exit(1); }
  console.log(JSON.stringify(pr));
} else if (a[0] === 'pr' && a[1] === 'list') {
  console.log(JSON.stringify(fx.list[a[a.indexOf('--head') + 1]] ?? []));
} else {
  console.error('fake gh: unexpected call: ' + a.join(' ')); process.exit(2);
}
`;

const BASE_FIXTURE = {
  fail: false,
  view: {
    7: { headRefName: 'feat-c', isCrossRepository: false, state: 'OPEN' },
    8: { headRefName: 'feat-fork', isCrossRepository: true, state: 'OPEN' },
    9: { headRefName: 'squashed', isCrossRepository: false, state: 'MERGED' },
  },
  list: {
    'feat-c': [{ state: 'OPEN', number: 7 }],
    squashed: [{ state: 'MERGED', number: 9 }],
    reused: [{ state: 'MERGED', number: 3 }, { state: 'OPEN', number: 4 }],
  },
};

const binDir = join(root, 'fake-bin');
mkdirSync(binDir);
writeFileSync(join(binDir, 'gh'), FAKE_GH);
chmodSync(join(binDir, 'gh'), 0o755);
const fixturePath = join(root, 'gh-fixture.json');
const setFixture = (patch = {}) =>
  writeFileSync(fixturePath, JSON.stringify({ ...BASE_FIXTURE, ...patch }));

const emptyConfig = join(root, 'gitconfig');
writeFileSync(emptyConfig, '');
const ENV = {
  ...process.env,
  PATH: `${binDir}:${process.env.PATH}`,
  GH_FIXTURE: fixturePath,
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in the harness: ${r.stderr}`);
  return r.stdout.trim();
}
const gitTry = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
function beta(cwd, ...args) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, out: `${r.stdout}\n${r.stderr}` };
}

// Spaced apart, because git treats a change on an ADJACENT line as a conflict too,
// and `feat-x` must conflict with `feat-y` and not with the later edit on `main`.
const LIST = (first, second) => `${first}\n.\n.\n.\n.\n.\n${second}\nthree\n`;

let serial = 0;
/** A bare origin and a clone. Every branch forks from the first commit. */
function fresh() {
  const dir = join(root, `case-${++serial}`);
  mkdirSync(dir);
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  const seed = join(dir, 'seed');
  git(dir, 'clone', '--quiet', origin, seed);
  git(seed, 'switch', '--quiet', '-c', 'main');
  writeFileSync(join(seed, 'list.txt'), LIST('one', 'two'));
  writeFileSync(join(seed, 'tracked.txt'), 'clean\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'first');

  const branch = (name, file, body) => {
    git(seed, 'switch', '--quiet', '-c', name, 'main');
    writeFileSync(join(seed, file), body);
    git(seed, 'add', '.');
    git(seed, 'commit', '--quiet', '-m', name);
  };
  branch('feat-a', 'a.txt', 'a\n');
  branch('feat-b', 'b.txt', 'b\n');
  branch('feat-c', 'c.txt', 'c\n');
  branch('feat-fork', 'fork.txt', 'fork\n');
  branch('reused', 'reused.txt', 'reused\n');
  branch('feat-x', 'list.txt', LIST('one', 'two-x'));
  branch('feat-y', 'list.txt', LIST('one', 'two-y'));
  branch('squashed', 'list.txt', LIST('one-squashed', 'two'));

  // The squash merge: `main` gets the same change as a different commit, and
  // then moves on over the same line, which is what makes a re-merge conflict.
  git(seed, 'switch', '--quiet', 'main');
  writeFileSync(join(seed, 'list.txt'), LIST('one-squashed', 'two'));
  git(seed, 'commit', '--quiet', '-am', 'squash merge');
  writeFileSync(join(seed, 'list.txt'), LIST('one-edited', 'two'));
  git(seed, 'commit', '--quiet', '-am', 'later edit');

  git(seed, 'push', '--quiet', 'origin', '--all');
  const clone = join(dir, 'clone');
  git(dir, 'clone', '--quiet', '--branch', 'main', origin, clone);
  setFixture();
  return { dir, origin, clone, seed };
}

/** Put a list on `origin/beta` as if an earlier run had pushed it. */
function seedList(c, entries) {
  const before = git(c.clone, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(c.clone, 'fetch', '--quiet', 'origin');
  git(c.clone, 'switch', '--quiet', '-c', 'seed-beta', 'origin/main');
  writeFileSync(join(c.clone, '.beta-branches'), `${entries.join('\n')}\n`);
  git(c.clone, 'add', '.beta-branches');
  git(c.clone, 'commit', '--quiet', '-m', 'seed list');
  git(c.clone, 'push', '--quiet', '--force', 'origin', 'seed-beta:beta');
  git(c.clone, 'switch', '--quiet', before);
  git(c.clone, 'branch', '--quiet', '-D', 'seed-beta');
  git(c.clone, 'fetch', '--quiet', 'origin');
}

const listOn = (cwd, ref = 'beta') =>
  (gitTry(cwd, 'show', `${ref}:.beta-branches`) ?? '')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const filesOn = (cwd, ref = 'beta') => git(cwd, 'ls-tree', '--name-only', ref).split('\n');
const worktrees = (cwd) => git(cwd, 'worktree', 'list').split('\n').length;
const lastLine = (s) => s.trim().split('\n').at(-1);

/** One refused command: exit 1, and neither `beta` nor the origin moved. */
function refuses(c, label, args, mustName) {
  const local = gitTry(c.clone, 'rev-parse', '--verify', '--quiet', 'refs/heads/beta');
  const remote = gitTry(c.origin, 'rev-parse', '--verify', '--quiet', 'refs/heads/beta');
  const r = beta(c.clone, ...args);
  t.equal(`${label}: exit 1`, r.status, 1);
  t.equal(`${label}: local beta did not move`,
    gitTry(c.clone, 'rev-parse', '--verify', '--quiet', 'refs/heads/beta'), local);
  t.equal(`${label}: origin beta did not move`,
    gitTry(c.origin, 'rev-parse', '--verify', '--quiet', 'refs/heads/beta'), remote);
  t.equal(`${label}: no worktree left behind`, worktrees(c.clone), 1);
  if (mustName) t.ok(`${label}: output names ${mustName}`, r.out.includes(mustName), r.out);
}

try {
  console.log('1. first build, from a dirty feature branch');
  {
    const c = fresh();
    git(c.clone, 'switch', '--quiet', '-c', 'work');
    writeFileSync(join(c.clone, 'tracked.txt'), 'uncommitted\n');
    const r = beta(c.clone, 'add', 'feat-a', 'feat-b');
    t.equal('exit 0', r.status, 0);
    t.equal('the list is on beta, in order', listOn(c.clone), ['feat-a', 'feat-b']);
    t.ok('feat-a is merged', filesOn(c.clone).includes('a.txt'));
    t.ok('feat-b is merged', filesOn(c.clone).includes('b.txt'));
    t.ok('beta is built on origin/main',
      gitTry(c.clone, 'merge-base', '--is-ancestor', 'origin/main', 'beta') !== null);
    t.equal('the last line is the push command', lastLine(r.stdout), PUSH_LINE);
    t.equal('nothing was pushed', git(c.origin, 'branch', '--list', 'beta'), '');
    t.equal('the checkout stayed on its branch', git(c.clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'work');
    t.equal('the uncommitted file was not touched',
      readFileSync(join(c.clone, 'tracked.txt'), 'utf8'), 'uncommitted\n');
    t.equal('no other file changed in the checkout',
      git(c.clone, 'status', '--porcelain'), 'M tracked.txt');
    t.equal('no worktree left behind', worktrees(c.clone), 1);

    console.log('2. the second machine reads the same list');
    git(c.clone, 'push', '--quiet', 'origin', 'beta');
    const second = join(c.dir, 'clone-2');
    git(c.dir, 'clone', '--quiet', '--branch', 'main', c.origin, second);
    const l = beta(second, 'list');
    t.equal('list: exit 0', l.status, 0);
    t.ok('list names feat-a', l.stdout.includes('feat-a'), l.stdout);
    t.ok('list names feat-b', l.stdout.includes('feat-b'), l.stdout);
    t.equal('list changes no branch', gitTry(second, 'rev-parse', '--verify', '--quiet', 'refs/heads/beta'), null);

    console.log('3. add by PR number, add a listed name, drop');
    const add7 = beta(c.clone, 'add', '7');
    t.equal('add 7: exit 0', add7.status, 0);
    t.equal('add 7 resolves to feat-c', listOn(c.clone), ['feat-a', 'feat-b', 'feat-c']);
    git(c.clone, 'push', '--quiet', '--force', 'origin', 'beta');

    const again = beta(c.clone, 'add', 'feat-c');
    t.equal('add a listed name: exit 0', again.status, 0);
    t.equal('add a listed name: no duplicate', listOn(c.clone), ['feat-a', 'feat-b', 'feat-c']);

    const drop = beta(c.clone, 'drop', 'feat-b');
    t.equal('drop: exit 0', drop.status, 0);
    t.equal('drop: the entry left the list', listOn(c.clone), ['feat-a', 'feat-c']);
    t.ok('drop: the file left the branch', !filesOn(c.clone).includes('b.txt'));
    t.ok('drop: the other file stayed', filesOn(c.clone).includes('a.txt'));
    git(c.clone, 'push', '--quiet', '--force', 'origin', 'beta');

    const dropPr = beta(c.clone, 'drop', '7');
    t.equal('drop by PR number: exit 0', dropPr.status, 0);
    t.equal('drop by PR number: the entry left the list', listOn(c.clone), ['feat-a']);

    git(c.clone, 'switch', '--quiet', '--discard-changes', 'main');
    git(c.clone, 'push', '--quiet', '--force', 'origin', 'beta');
    git(c.clone, 'switch', '--quiet', 'beta');
    const whileOn = beta(c.clone, 'list');
    t.equal('list still works with beta checked out', whileOn.status, 0);
    refuses(c, 'rebuild with beta checked out', ['rebuild'], 'checked out');
  }

  console.log('4. a merged PR leaves the list, and a reused branch name stays');
  {
    const c = fresh();
    seedList(c, ['squashed', 'reused']);
    const r = beta(c.clone, 'rebuild');
    t.equal('exit 0, with no false conflict', r.status, 0);
    t.ok('the note names the merged branch', r.stdout.includes('squashed'), r.stdout);
    t.equal('only the reused branch stays', listOn(c.clone), ['reused']);
    t.ok('the reused branch is merged', filesOn(c.clone).includes('reused.txt'));
  }

  console.log('5. a conflict stops the run');
  {
    const c = fresh();
    seedList(c, ['feat-x']);
    refuses(c, 'conflict', ['add', 'feat-y'], 'feat-y');
    const r = beta(c.clone, 'add', 'feat-y');
    t.ok('conflict: output names the file', r.out.includes('list.txt'), r.out);
    t.equal('conflict: the list on origin is unchanged', listOn(c.clone, 'origin/beta'), ['feat-x']);
  }

  console.log('6. refusals');
  {
    const c = fresh();
    seedList(c, ['feat-a']);
    refuses(c, 'add main', ['add', 'main'], 'main');
    refuses(c, 'add beta', ['add', 'beta'], 'beta');
    refuses(c, 'add a branch that does not exist', ['add', 'no-such-branch'], 'no-such-branch');
    refuses(c, 'drop a name not on the list', ['drop', 'not-listed'], 'not-listed');
    refuses(c, 'add a PR from a fork', ['add', '8'], '8');
    refuses(c, 'add a merged PR', ['add', '9'], '9');
    refuses(c, 'no command', []);
    refuses(c, 'an unknown command', ['frobnicate'], 'frobnicate');
    setFixture({ fail: true });
    refuses(c, 'gh fails', ['rebuild'], 'gh');
    setFixture();
  }
  {
    const c = fresh();
    seedList(c, ['feat-c']);
    git(c.seed, 'push', '--quiet', 'origin', '--delete', 'feat-c');
    refuses(c, 'a listed branch is gone from origin, PR still open', ['rebuild'], 'feat-c');
  }
  {
    const c = fresh();
    git(c.seed, 'switch', '--quiet', 'main');
    writeFileSync(join(c.seed, '.beta-branches'), 'feat-a\n');
    git(c.seed, 'add', '.beta-branches');
    git(c.seed, 'commit', '--quiet', '-m', 'beta merged into main by mistake');
    git(c.seed, 'push', '--quiet', 'origin', 'main');
    refuses(c, 'the list file reached main', ['rebuild'], 'main');
  }

  console.log('7. a second add before the first rebuild is pushed');
  {
    const c = fresh();
    t.equal('first add: exit 0', beta(c.clone, 'add', 'feat-a').status, 0);
    const r = beta(c.clone, 'add', 'feat-b');
    t.equal('second add: exit 0', r.status, 0);
    t.ok('it warns that local beta differs from origin/beta', /local beta/i.test(r.stdout) && r.stdout.includes('origin/beta'), r.stdout);
    t.equal('the list came from origin, as the warning says', listOn(c.clone), ['feat-b']);
  }
} catch (e) {
  t.fail('the harness threw', e instanceof Error ? e.message : String(e));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(t.fails ? `\nFAILED (${t.fails} of ${t.count})` : `\nOK (${t.count})`);
await exit(t.fails ? 1 : 0);
