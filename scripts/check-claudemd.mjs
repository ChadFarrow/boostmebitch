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
const BUDGET = 15300

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
