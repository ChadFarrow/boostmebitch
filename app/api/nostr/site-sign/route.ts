import { NextResponse } from 'next/server';
import { finalizeEvent, type EventTemplate } from 'nostr-tools/pure';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { siteSecretKey } from '@/lib/nostr/site-key';

// Server-side signer for the SITE's own Nostr identity. Lets a signed-OUT user
// still post their boost note to Nostr — signed by the app's key, not theirs.
//
// The private key (SITE_NOSTR_SK, nsec or hex) is server-only and NEVER shipped
// to the browser (a signing key in the bundle is extractable by anyone). The
// client POSTs an unsigned boost-note template here; we sign it and return the
// signed event, which the client then publishes to relays itself.
//
// Absent SITE_NOSTR_SK => 503, so the feature is simply off when unconfigured
// (the checkbox still shows; the note just isn't posted). Mirrors the graceful
// degradation used elsewhere (e.g. the non-fatal Libre postinstall).

const MAX_CONTENT = 2000;
const MAX_TAGS = 40;
const CREATED_AT_SKEW_SECS = 300; // reject notes back/post-dated beyond ±5 min
// Every genuine boost note — single and boost-all summary alike — is framed by
// formatContent()/the summary override with this exact prefix. Requiring it
// stops the oracle being repurposed to sign arbitrary free-text (spam,
// harassment, defamation) as the site's NIP-05-verified identity: whatever is
// signed must at least be shaped like a boost announcement.
const BOOST_CONTENT_PREFIX = '⚡ Boost ⚡';

// Bound the signing oracle: this endpoint must only ever sign boost-shaped
// kind:1 notes as the site, never arbitrary events (DMs, kind:0 hijack, etc.).
function validateBoostTemplate(body: unknown): EventTemplate {
  if (!body || typeof body !== 'object') throw new Error('bad template');
  const t = body as Record<string, unknown>;
  if (t.kind !== 1) throw new Error('only kind:1 boost notes may be signed');
  if (typeof t.content !== 'string' || t.content.length > MAX_CONTENT) {
    throw new Error('invalid content');
  }
  if (!t.content.startsWith(BOOST_CONTENT_PREFIX)) {
    throw new Error('not a boost note');
  }
  if (!Array.isArray(t.tags) || t.tags.length > MAX_TAGS) throw new Error('invalid tags');
  const tags = t.tags as unknown[];
  const flat = tags.every(
    (tag) => Array.isArray(tag) && tag.every((x) => typeof x === 'string'),
  );
  if (!flat) throw new Error('invalid tags');
  const strTags = tags as string[][];
  const hasT = (v: string) => strTags.some((tag) => tag[0] === 't' && tag[1] === v);
  // The two markers publishBoostNote always emits — proves this is a boost note.
  if (!hasT('boostagram') || !hasT('value4value')) {
    throw new Error('not a boost note');
  }
  const now = Math.floor(Date.now() / 1000);
  const createdAt =
    typeof t.created_at === 'number' && Number.isFinite(t.created_at)
      ? t.created_at
      : now;
  if (Math.abs(createdAt - now) > CREATED_AT_SKEW_SECS) {
    throw new Error('created_at out of range');
  }
  return { kind: 1, created_at: createdAt, tags: strTags, content: t.content };
}

export async function POST(req: Request) {
  const limited = rateLimit(req, 'site-sign', 30);
  if (limited) return limited;

  const sk = siteSecretKey();
  if (!sk) {
    return NextResponse.json(
      { error: 'site Nostr identity not configured' },
      { status: 503 },
    );
  }

  return withErrorHandling(async () => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }
    let template: EventTemplate;
    try {
      template = validateBoostTemplate(body);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'invalid template' },
        { status: 400 },
      );
    }
    const signed = finalizeEvent(template, sk);
    return NextResponse.json(
      { event: signed },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }, 'site-sign failed');
}
