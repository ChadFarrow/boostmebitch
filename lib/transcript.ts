'use client';
import { useEffect, useState } from 'react';
import { isMusicMedium } from './util';
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
  const plain = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
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
    const q = `/api/transcript?url=${encodeURIComponent(url)}${type ? `&type=${encodeURIComponent(type)}` : ''}`;
    fetch(q)
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
 *  Transcripts are a podcast feature: gated off for live streams and music
 *  feeds, mirroring `chapterUrlFor`. */
export function transcriptSourceFor(
  current: { episode: Episode; podcast: Podcast } | null,
): { url: string; type?: string } {
  if (!current || current.episode.liveStatus === 'live' || isMusicMedium(current.podcast)) {
    return { url: '' };
  }
  return { url: current.episode.transcriptUrl ?? '', type: current.episode.transcriptType };
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
