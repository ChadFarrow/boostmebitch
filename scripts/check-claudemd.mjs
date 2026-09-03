#!/usr/bin/env node
// Pins the size of CLAUDE.md, the file loaded into every session in this repo.
//
// Usage:
//   npm run check:claudemd
//   CHECK_CLAUDEMD_VERBOSE=1 npm run check:claudemd   # per-section table always
//
// Run it after ANY edit to CLAUDE.md.
//
// Why this earns a check script — and why it is NOT one of the twenty-one.
// Those pin a pure function whose silent breakage costs a user something
// irreversible. This one guards a document, and the thing it guards against is
// not a bug but a ratchet: of the 60 commits before this script existed, 59 grew
// CLAUDE.md and exactly 1 shrank it, by one word. It went 14,306 -> 26,250 words
// in five days. Nothing was wrong with any single commit; each added a real rule
// with its real reasoning, and the file still doubled.
//
// The admission test was already written at the top of CLAUDE.md and was already
// correct. It was not binding, because nothing measured the file — so the cost of
// adding 300 words was invisible at the moment somebody added them, and the
// reasoning went into `docs/` AND into CLAUDE.md ("in the two places it belongs",
// as one commit message put it). This script makes that cost visible exactly
// once: at the moment of the edit, to the person who can still choose the other
// file.
//
// It deliberately does NOT check content, headings, or where a rule "should" go.
// A budget that argues about placement is a budget nobody runs. It answers one
// question — is the always-loaded file still small enough to be worth loading —
// and leaves the judgement to the person reading the failure.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Words, counted the way `wc -w` counts them, so the number in a failure message
// matches what anyone gets by running `wc -w CLAUDE.md` to check it.
const words = (s) => s.split(/\s+/).filter(Boolean).length

// Headroom, not a target. The file sits a little under this on purpose: enough
// for a handful of genuinely new rules, few enough that the next one after those
// has to displace something. Raising the budget to fit a new rule is the one move
// this script exists to make someone stop and think about first.
//
// It has been raised once, and the reason is the shape to copy. The trim landed at
// 12,545 against the CLAUDE.md of 990db86; rebasing onto a main 13 commits further
// on brought 13 genuinely new rules (playlists and `payableValue`, the mute cipher,
// `unattendedDecryptOk`, three new check scripts) that had to be folded in. The
// budget moved because the repo grew, not because the prose did — the ratio held at
// roughly half of what CLAUDE.md would otherwise have been, which is the number to
// keep an eye on. Raising it because an entry is hard to shorten is the other thing,
// and that is what this comment exists to make you say out loud.
//
// Raised a second time, 15,200 -> 15,300, for one row: `check:fanout`, the
// twenty-ninth check script. The table is an INDEX — it names the count in its
// own first line — so a script that exists and is not listed makes the file
// wrong rather than merely incomplete, and no other entry could pay for it
// without losing a measured fact. Trimming had already cost "twelve surfaces"
// off `check:art` and "for somebody else's song" off `check:musicl` before
// that was obvious; both are restored. So: the repo grew by a check script and
// the budget grew by a row, which is the ratio the note above says to watch.
// It is NOT licence for the next rule — that one displaces something.
//
// Raised a third time, 15,300 -> 15,400, and the reason is as much about the
// LAST raise as this change. 15,300 left the file at 15,299 — one word of
// headroom, which is not headroom. The note above says the file should sit "a
// little under this on purpose: enough for a handful of genuinely new rules";
// at one word it sits AT the ceiling, so the budget had stopped asking "is this
// rule worth displacing something?" and started asking "did you touch this file
// at all?". Two open PRs hit it within a day, neither adding a rule: this one
// adds three words to a table cell, and #292 hit it adding a check script.
// A limit that fires on every edit regardless of size is not a limit anyone can
// act on — it just gets raised in a hurry by whoever is unlucky, which is the
// opposite of the deliberate pause this script exists to create.
//
// What grew in the repo: `docs/ops.md` gained a whole subject it did not cover,
// the second Vercel project and the fact that it shares NONE of the first one's
// environment — measured against five BoostBox 401s on boostmebuddy, where every
// LNURL leg paid with no `rss::payment` descriptor. The table is an INDEX, so a
// doc that now answers "which Vercel project holds which variable" has to say so
// in its row or nobody reaches it from here. Nothing else in the row could pay:
// the file has no filler left to cut (checked), and each remaining clause names
// a measured fact.
//
// The +100 is deliberately more than the 3 words needed. Buying exactly enough
// is what produced the one-word ceiling, and the next contributor should not
// have to hold a budget argument to fix a typo. It is still NOT licence for the
// next rule — that one displaces something. If #292 lands after this, drop its
// own raise to 15,340 rather than lowering this number.
// Raised a fourth time, 15,400 -> 15,500, and the accounting matters more than
// the number. The last raise bought +100 as deliberate slack so nobody would
// have to argue a budget to fix a typo. That slack was gone in ONE DAY, and I
// consumed all of it: #311, #312 and #310 each landed a rule here, and the file
// came to rest at exactly 15,400 — back at the one-word ceiling the last raise
// existed to remove. So this raise is not "the rules grew", it is "the previous
// raise was consumed by the same session that wrote it", which is worth saying
// plainly rather than quietly ratcheting.
//
// What it buys, and both pay the (a)/(b)/(c) test the file states: a warning
// that the browser must NOT get `node-yield.ts`'s fix (removing MessageChannel
// there makes the yield a no-op, and the person who would try it is reading app
// code, not the service module), and one clause saying a `BadRecordMac` upload
// still leaves a deployment record — which the sentence beside it needs, since
// it tells you to read a build log that a phantom deployment does not have.
// Both were compressed twice before this raise was considered.
//
// THE NEXT RAISE SHOULD NOT HAPPEN. If this file needs one again, the answer is
// structural, not numeric: `services/nostr-index` now has enough rules here
// (deploy path, package name, yield fix, relay lists) to deserve its own
// `docs/` file, and moving them out is worth more than another +100. Raising a
// fifth time without doing that is the ratchet this script exists to prevent.
const BUDGET = 15500

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const path = join(root, 'CLAUDE.md')

const text = await readFile(path, 'utf8')
const total = words(text)

// Split on `## ` only. `### ` subsections roll up into their parent, because the
// parent is the unit anyone actually decides about.
const sections = []
let current = { name: '(preamble)', lines: [] }
for (const line of text.split('\n')) {
  if (line.startsWith('## ')) {
    sections.push(current)
    current = { name: line.slice(3).trim(), lines: [] }
  } else {
    current.lines.push(line)
  }
}
sections.push(current)

const sized = sections
  .map((s) => ({ name: s.name, words: words(s.lines.join('\n')) }))
  .filter((s) => s.words > 0)
  .sort((a, b) => b.words - a.words)

const table = (rows) =>
  rows.map((s) => `  ${String(s.words).padStart(5)}  ${s.name}`).join('\n')

if (total <= BUDGET) {
  const left = BUDGET - total
  console.log(`CLAUDE.md: ${total} words, budget ${BUDGET} (${left} to spare).`)
  if (process.env.CHECK_CLAUDEMD_VERBOSE) console.log(`\n${table(sized)}`)
  else console.log(`Largest section: ${sized[0].name} (${sized[0].words}).`)
  process.exit(0)
}

console.error(`CLAUDE.md is ${total} words; the budget is ${BUDGET}.

Largest sections:
${table(sized.slice(0, 5))}

A new rule goes in docs/ unless it:
  (a) can lose funds or leak a credential
  (b) governs where code may go
  (c) applies to files you haven't opened yet

If it is one of those, keep the rule here as one imperative sentence, one clause
naming the consequence, and a -> docs/ pointer, then trim an existing entry to pay
for it. If it is not, move it to the docs/ file that already covers the area — the
"Read before you edit" table already routes anyone to that file before they touch
the code, so the rule still gets read, just not by every session about every task.

Raising BUDGET in scripts/check-claudemd.mjs is a real option and it is not free:
this file is loaded before any work begins, on every task, whether or not it is
relevant. Raise it deliberately, not to get past this message.`)
process.exit(1)
