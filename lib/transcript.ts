'use client';
import { useEffect, useState } from 'react';
import { readsTranscript } from './util';
import { transcriptRequestUrl } from './downloads/download-rules';
import { fetchDoc } from './downloads/downloads-cache';
import type { Episode, Podcast } from './types';

// One line of a parsed transcript. `endTime`/`speaker` are optional — SRT/VTT
// carry an end time; the PC2.0 JSON format also carries a speaker.
export interface TranscriptCue {
  startTime: number;
  endTime?: number;
  text: string;
  speaker?: string;
}

// --- timestamp parsing -----------------------------------------------------
// Handles both SRT (`HH:MM:SS,mmm`) and VTT (`HH:MM:SS.mmm` / `MM:SS.mmm`).
function parseTs(str: string): number {
  const m = str.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return NaN;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(m[4].padEnd(3, '0'));
  return h * 3600 + min * 60 + sec + ms / 1000;
}

// SRT and VTT share a block structure: blank-line-separated cues, each with a
// `start --> end` line (optionally preceded by a cue id / followed by cue
// settings) then one or more text lines. Header (`WEBVTT`) and `NOTE` blocks
// have no `-->` and are skipped.
function parseCueBlocks(text: string): TranscriptCue[] {
  const body = text.replace(/\r\n?/g, '\n');
  const cues: TranscriptCue[] = [];
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const tlIdx = lines.findIndex((l) => l.includes('-->'));
    if (tlIdx === -1) continue;
    const [startRaw, endRaw = ''] = lines[tlIdx].split('-->');
    const startTime = parseTs(startRaw);
    if (Number.isNaN(startTime)) continue;
    const endTime = parseTs(endRaw.trim().split(/\s+/)[0] ?? '');
    // Join wrapped text lines; strip VTT inline tags (<v Name>, <c>, <00:00:01>).
    const cueText = lines
      .slice(tlIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cueText) continue;
    cues.push({ startTime, endTime: Number.isNaN(endTime) ? undefined : endTime, text: cueText });
  }
  return cues;
}

// Merge consecutive JSON segments into readable lines: many PC2.0 JSON
// transcripts are word- or phrase-level, which would render as hundreds of tiny
// rows. Combine within the same speaker until a sentence ends or the line gets
// long.
function groupSegments(segs: TranscriptCue[]): TranscriptCue[] {
  const out: TranscriptCue[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    const sameSpeaker = last && (last.speaker ?? '') === (s.speaker ?? '');
    const lastEndsSentence = last && /[.!?]["')\]]?$/.test(last.text);
    if (last && sameSpeaker && !lastEndsSentence && last.text.length < 140) {
      last.text = `${last.text} ${s.text}`.replace(/\s+/g, ' ').trim();
      if (s.endTime != null) last.endTime = s.endTime;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

// Podcasting 2.0 transcript JSON: `{ version, segments: [{ startTime, endTime,
// speaker, body }] }`. Some files are a bare array; some use `text` for `body`.
function parseTranscriptJson(raw: string): TranscriptCue[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const segsRaw = Array.isArray(data)
    ? data
    : Array.isArray((data as { segments?: unknown })?.segments)
      ? (data as { segments: unknown[] }).segments
      : [];
  const segs: TranscriptCue[] = [];
  for (const s of segsRaw as Array<Record<string, unknown>>) {
    const startTime = Number(s?.startTime);
    if (!Number.isFinite(startTime)) continue;
    const body = typeof s.body === 'string' ? s.body : typeof s.text === 'string' ? s.text : '';
    const cueText = body.replace(/\s+/g, ' ').trim();
    if (!cueText) continue;
    const endTime = Number(s.endTime);
    segs.push({
      startTime,
      endTime: Number.isFinite(endTime) ? endTime : undefined,
      text: cueText,
      speaker: typeof s.speaker === 'string' && s.speaker ? s.speaker : undefined,
    });
  }
  return groupSegments(segs);
}

/** Parse a transcript body into cues, dispatching on its MIME type (falling
 *  back to content sniffing). Untimed formats (html/plain) that yield no timed
 *  cues collapse to a single readable line so the panel still shows the text. */
export function parseTranscript(text: string, type: string | undefined): TranscriptCue[] {
  const t = (type ?? '').toLowerCase();
  const trimmed = text.trimStart();
  if (t.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = parseTranscriptJson(text);
    if (json.length) return json;
  }
  const cues = parseCueBlocks(text);
  if (cues.length) return cues;
  // Untimed fallback (html/plain, or an unparseable timed file): one readable
  // cue with markup stripped. No meaningful sync, but the text is visible.
  //
  // LINE BREAKS ARE KEPT, and a `<br>` or a closing block tag becomes one. Song
  // lyrics are written a line at a time with a blank line between verses (the
  // music feeds that publish `text/html` or `text/plain` lyrics write .txt
  // files), and collapsing every newline to a space printed a whole song as one
  // run-on paragraph. Only runs of spaces and tabs collapse. The panel renders
  // this block `whitespace-pre-wrap`.
  const plain = text
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain ? [{ startTime: 0, text: plain }] : [];
}

/** Fetch and parse an episode's transcript. Re-fetches when `url`/`type` change.
 *  Proxied through /api/transcript because many hosts serve without CORS. */
export function useTranscript(url: string, type?: string): { cues: TranscriptCue[] | null; loading: boolean } {
  const [cues, setCues] = useState<TranscriptCue[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!url) {
      setCues(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setCues(null);
    // Network first, cache on a rejection — see the note on the same line in
    // lib/chapters.ts.
    const q = transcriptRequestUrl(url, type) ?? '';
    fetchDoc(q)
      .then((r) => (r.ok ? r.text() : null))
      .then((text) => {
        if (cancelled) return;
        setCues(text != null ? parseTranscript(text, type) : []);
      })
      .catch(() => { if (!cancelled) setCues([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url, type]);

  return { cues, loading };
}

/** The transcript source for a now-playing item, or an empty url to skip.
 *  Gated off for live streams only (`readsTranscript`): a TRACK reads its own
 *  transcript too, because that is its lyrics. This is NOT the chapters gate
 *  (`readsEpisodeDocs`) — see `readsTranscript` for why the two split. */
export function transcriptSourceFor(
  current: { episode: Episode; podcast: Podcast } | null,
): { url: string; type?: string } {
  if (!current || !readsTranscript(current)) {
    return { url: '' };
  }
  return { url: current.episode.transcriptUrl ?? '', type: current.episode.transcriptType };
}

/**
 * The lyrics of the song a `<podcast:valueTimeSplit>` window plays, moved onto
 * the SHOW's clock: `split.startTime + cue.startTime - remoteStartTime`. A cue
 * the window does not reach (before `remoteStartTime`, or past the window's
 * end) is dropped, so every row seeks to a moment inside the song. Pure.
 *
 * The cue times in the track's own file count from the start of the TRACK, and
 * the show plays it from `remoteStartTime` at `startTime` — so without the move
 * the highlight would follow the show's clock through the song's lyrics and
 * land on the wrong line for every song not at 0:00.
 */
export function cuesOnShowClock(
  cues: TranscriptCue[] | null,
  split: { startTime: number; duration: number; remoteStartTime?: number } | null,
): TranscriptCue[] | null {
  if (!cues || !split) return null;
  // An untimed file (html/plain) parses to ONE cue at 0 and renders as a plain
  // block: it has no clock to move, and a moved start would read as one timed row.
  if (cues.length === 1 && cues[0].startTime === 0 && cues[0].endTime == null) return cues;
  const offset = split.remoteStartTime && Number.isFinite(split.remoteStartTime) ? split.remoteStartTime : 0;
  const end = split.startTime + split.duration;
  const out: TranscriptCue[] = [];
  for (const c of cues) {
    const start = split.startTime + c.startTime - offset;
    if (start < split.startTime || start >= end) continue;
    out.push({
      ...c,
      startTime: start,
      endTime: c.endTime != null ? split.startTime + c.endTime - offset : undefined,
    });
  }
  return out;
}

/** Index of the cue currently playing — the one with the greatest startTime not
 *  past `positionSec`. -1 before the first cue (or when there are none). Unlike
 *  the "last index whose start passed" shortcut used for chapters (always
 *  authored in order), this picks by max startTime, so a single out-of-order cue
 *  — auto-captioners do produce them; a real PC2.0 SRT had one — can't hijack
 *  the highlight for the whole window it precedes. */
export function transcriptIndexAt(cues: TranscriptCue[] | null | undefined, positionSec: number): number {
  if (!cues?.length) return -1;
  let best = -1;
  let bestStart = -Infinity;
  for (let i = 0; i < cues.length; i++) {
    const st = cues[i].startTime;
    if (st <= positionSec && st >= bestStart) {
      bestStart = st;
      best = i;
    }
  }
  return best;
}
