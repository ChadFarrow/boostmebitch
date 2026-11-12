// NIP-98 check for community-playlist writes, and the admin npub list.
// Bare nostr-tools imports only: scripts/check-community.mjs loads this file directly.
import { unpackEventFromToken, validateEventKind, validateEventMethodTag, hashPayload } from 'nostr-tools/nip98';
import { verifyEvent } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';

export type AuthFailure = 'missing' | 'malformed' | 'clock' | 'url' | 'method' | 'payload' | 'signature';

const WINDOW_SECONDS = 60;

export async function verifyNip98(
  header: string | null,
  url: string,
  method: string,
  bodyText: string | null,
): Promise<{ ok: true; pubkey: string } | { ok: false; reason: AuthFailure }> {
  const fail = (reason: AuthFailure) => ({ ok: false as const, reason });
  if (!header) return fail('missing');
  let event;
  try {
    event = await unpackEventFromToken(header);
  } catch {
    return fail('malformed');
  }
  let sigOk: boolean;
  try {
    sigOk = verifyEvent(event);
  } catch {
    return fail('malformed'); // not an event at all
  }
  if (!sigOk) return fail('signature');
  if (!validateEventKind(event)) return fail('malformed');
  // The library only rejects old tokens; a token dated in the future would stay valid.
  if (Math.abs(Math.round(Date.now() / 1000) - event.created_at) >= WINDOW_SECONDS) return fail('clock');
  const want = url.replace(/\?$/, '');
  const urlTag = event.tags.find((t) => t[0] === 'u');
  if (!urlTag || (urlTag[1] ?? '').replace(/\?$/, '') !== want) return fail('url');
  if (!validateEventMethodTag(event, method)) return fail('method');
  if (bodyText) {
    const tag = event.tags.find((t) => t[0] === 'payload');
    let hash: string;
    try {
      hash = hashPayload(JSON.parse(bodyText));
    } catch {
      return fail('payload');
    }
    if (!tag || tag[1] !== hash) return fail('payload');
  }
  return { ok: true, pubkey: event.pubkey };
}

export function adminPubkeys(env: string | undefined = process.env.ADMIN_NPUBS): Set<string> {
  const out = new Set<string>();
  for (const part of (env ?? '').split(/[\s,]+/)) {
    if (!part) continue;
    try {
      const d = decode(part);
      if (d.type === 'npub') out.add(d.data);
    } catch { /* drop invalid */ }
  }
  return out;
}

export function authMessage(reason: AuthFailure): string {
  return reason === 'clock'
    ? 'Your device clock is off. Set it to automatic time and try again.'
    : 'Sign-in check failed. Sign in again and retry.';
}
