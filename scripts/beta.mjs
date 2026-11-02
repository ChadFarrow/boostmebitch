#!/usr/bin/env node
// Rebuilds the `beta` branch: `origin/main` plus a list of PR branches.
// `beta.boostmebitch.com` serves that branch. See docs/ops.md, "The beta site".
//
//   npm run beta -- list
//   npm run beta -- add <pr-or-branch>...
//   npm run beta -- drop <pr-or-branch>...
//   npm run beta -- rebuild
//
// WHY THE BRANCH IS REBUILT AND NEVER MERGED INTO: dropping a PR from a
// long-lived branch needs a revert, and docs/ops.md records how a later re-merge
// of a reverted feature loses code on a green build. A rebuild leaves no trace.
//
// WHY THIS NEVER PUSHES: every push in this workspace asks Chad first, through
// a hook that reads the command line. A script that pushes from inside itself is
// invisible to that hook, so this one prints the command and stops.
//
// WHY THE LIST LIVES ON `beta` AND IS READ FROM `origin/beta`: a change to the
// list needs no PR into `main`, and the two machines read one list. The cost is
// that a second `add` before a push starts from the old list, so it warns.
//
// WHY A TEMPORARY WORKTREE: this runs from wherever the work is, usually a
// feature branch with uncommitted files. Nothing here touches that checkout.
//
// WHY A MERGED PR LEAVES THE LIST BEFORE ANYTHING MERGES: a squash merge changes
// the patch id, so merging that branch again conflicts with its own change on
// `main`. A `gh` failure stops the run for the same reason: a guess here reads
// as a real conflict between two PRs.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIST_FILE = '.beta-branches';
const PUSH_LINE = 'git push --force-with-lease origin beta';
const USAGE = 'usage: npm run beta -- list | add <pr-or-branch>... | drop <pr-or-branch>... | rebuild';
const RESERVED = new Set(['main', 'beta']);

/** A refusal. Printed without a stack, and the run exits 1 with nothing moved. */
class Stop extends Error {}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: r.status === 0,
    out: (r.stdout ?? '').trim(),
    err: (r.stderr ?? '').trim() || (r.error ? String(r.error.message) : ''),
  };
}

const rootProbe = run('git', ['rev-parse', '--show-toplevel'], process.cwd());
const root = rootProbe.out;

function git(args, cwd = root) {
  const r = run('git', args, cwd);
  if (!r.ok) throw new Stop(`git ${args.join(' ')} failed: ${r.err}`);
  return r.out;
}
const shaOf = (ref) => {
  const r = run('git', ['rev-parse', '--verify', '--quiet', ref], root);
  return r.ok ? r.out : null;
};

function ghJson(args) {
  const r = run('gh', args, root);
  if (!r.ok) throw new Stop(`gh ${args.join(' ')} failed: ${r.err}`);
  try {
    return JSON.parse(r.out);
  } catch {
    throw new Stop(`gh ${args.join(' ')} did not answer with JSON: ${r.out}`);
  }
}

function readList() {
  if (!shaOf('refs/remotes/origin/beta')) return [];
  const r = run('git', ['show', `origin/beta:${LIST_FILE}`], root);
  if (!r.ok) return [];
  return r.out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function refuseIfCheckedOut() {
  const held = git(['worktree', 'list', '--porcelain']).split('\n').includes('branch refs/heads/beta');
  if (held) throw new Stop('beta is checked out in a worktree. Switch to another branch, and run this again.');
}

/** A PR number names its head branch; anything else is already a branch name. */
function prHead(arg) {
  return ghJson(['pr', 'view', arg, '--json', 'headRefName,isCrossRepository,state']);
}

function resolveForAdd(arg) {
  let name = arg;
  if (/^\d+$/.test(arg)) {
    const pr = prHead(arg);
    if (pr.isCrossRepository) throw new Stop(`PR ${arg} comes from a fork, so its branch is not on origin.`);
    if (pr.state !== 'OPEN') throw new Stop(`PR ${arg} is ${pr.state}, not OPEN.`);
    name = pr.headRefName;
  }
  if (RESERVED.has(name)) throw new Stop(`${name} cannot go on the list.`);
  if (!shaOf(`refs/remotes/origin/${name}`)) throw new Stop(`${name} is not a branch on origin.`);
  return name;
}

function applyChange(cmd, names, list) {
  const next = [...list];
  for (const arg of names) {
    if (cmd === 'add') {
      const name = resolveForAdd(arg);
      if (next.includes(name)) console.log(`${name} is already on the list.`);
      else next.push(name);
    } else {
      const name = /^\d+$/.test(arg) ? prHead(arg).headRefName : arg;
      const at = next.indexOf(name);
      if (at < 0) throw new Stop(`${arg} is not on the list.`);
      next.splice(at, 1);
    }
  }
  return next;
}

/** OPEN beats MERGED, because a branch name can be used again for a new PR. */
function pruneMerged(list) {
  return list.filter((name) => {
    const prs = ghJson(['pr', 'list', '--head', name, '--state', 'all', '--json', 'state,number']);
    if (prs.some((pr) => pr.state === 'OPEN')) return true;
    const merged = prs.find((pr) => pr.state === 'MERGED');
    if (!merged) return true;
    console.log(`Removed ${name}: PR ${merged.number} is merged.`);
    return false;
  });
}

function buildBeta(list) {
  for (const name of list) {
    if (!shaOf(`refs/remotes/origin/${name}`)) {
      throw new Stop(`${name} is on the list, but it is not a branch on origin. Drop it, or push it again.`);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'bmb-beta-'));
  try {
    git(['worktree', 'add', '--quiet', '--detach', dir, 'origin/main']);
    for (const name of list) {
      const r = run('git', ['merge', '--quiet', '--no-ff', '--no-edit', '-m', `beta: merge ${name}`, `origin/${name}`], dir);
      if (!r.ok) {
        const files = run('git', ['diff', '--name-only', '--diff-filter=U'], dir).out;
        run('git', ['merge', '--abort'], dir);
        throw new Stop(`${name} does not merge. Fix this on the PR branch, and run this again.\n${files || r.err}`);
      }
      console.log(`Merged ${name}.`);
    }
    const header = '# Written by scripts/beta.mjs. One branch per line, merged in this order.\n';
    writeFileSync(join(dir, LIST_FILE), header + list.map((n) => `${n}\n`).join(''));
    git(['add', LIST_FILE], dir);
    git(['commit', '--quiet', '-m', `beta: ${list.length} branches`, '-m', list.join('\n') || '(none)'], dir);
    return git(['rev-parse', 'HEAD'], dir);
  } finally {
    run('git', ['worktree', 'remove', '--force', dir], root);
    run('git', ['worktree', 'prune'], root);
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  if (!rootProbe.ok) throw new Stop('run this inside the repository.');
  const [cmd, ...names] = process.argv.slice(2);
  if (!['list', 'add', 'drop', 'rebuild'].includes(cmd)) {
    throw new Stop(cmd ? `unknown command ${cmd}. ${USAGE}` : USAGE);
  }
  if ((cmd === 'add' || cmd === 'drop') && names.length === 0) throw new Stop(USAGE);

  git(['fetch', '--quiet', '--prune', 'origin']);
  if (run('git', ['cat-file', '-e', `origin/main:${LIST_FILE}`], root).ok) {
    throw new Stop(`${LIST_FILE} is on origin/main, so beta reached main. Remove it from main first.`);
  }

  const list = readList();
  if (cmd === 'list') {
    console.log(list.length ? list.join('\n') : '(the list is empty)');
    return;
  }

  refuseIfCheckedOut();
  const localBeta = shaOf('refs/heads/beta');
  if (localBeta && localBeta !== shaOf('refs/remotes/origin/beta')) {
    console.log('Warning: local beta differs from origin/beta. The list comes from origin/beta, so an unpushed rebuild is replaced.');
  }

  const changed = cmd === 'rebuild' ? list : applyChange(cmd, names, list);
  const next = pruneMerged(changed);
  const sha = buildBeta(next);
  git(['branch', '--force', 'beta', sha]);

  console.log(`\nLocal beta is ${sha.slice(0, 7)}, with ${next.length} branches:`);
  for (const name of next) console.log(`  ${name}`);
  console.log(`\nPush it with:\n${PUSH_LINE}`);
}

try {
  main();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.error(`beta: ${e.message}`);
  process.exitCode = 1;
}
