import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';

// The serving side of the lightning-address → keysend upgrade this app already
// consumes (lib/v4v/keysend-lookup.ts). A payer that finds `chadf@boostmebitch.com`
// in a value block looks here first; when we answer, the boost is paid as a real
// keysend and the boostagram rides inline in TLV 7629169 — `sender_id`, the
// remote_feed_guid/remote_item_guid correlation ids and the sender's message all
// intact — instead of degrading to a LUD-21 comment that only BoostBox-aware
// tooling reads.
//
// This is a *sidecar* to the lightning address, never a replacement: discovery
// starts from `.well-known/lnurlp/<name>`, and every BOLT11-only wallet (Spark,
// among others) can only pay that way. If lnurlp stops answering for a name,
// publishing keysend for it doesn't keep the address working.
//
// Deliberately a route handler rather than a file in `public/`: a static file
// with no extension is served as `application/octet-stream`, and this needs to
// be JSON, CORS-open and cacheable. Mirrors app/.well-known/nostr.json.

interface KeysendName {
  /** 33-byte compressed secp256k1 node id, hex. */
  pubkey: string;
  /**
   * TLV routing pair for a shared node. Both or neither — a key from one
   * source paired with a value from another misroutes to the wrong
   * sub-account, which is why the reader takes them only together.
   */
  customKey?: string;
  customValue?: string;
}

// Lowercase keys: lightning addresses are case-insensitive in practice and the
// lookup path lowercases before probing, so we match on the same normalization.
const NAMES: Record<string, KeysendName> = {
  chadf: {
    // Chad's own LND node (45.33.65.45:9735 — the gossip address is how peers
    // open channels, so it deliberately isn't published here; a keysend is
    // routed to the pubkey, not dialled direct). Self-hosted, so there's no
    // shared-node sub-account to route to and no customKey/customValue.
    //
    // Requires `accept-keysend` (LND) to stay enabled: without it the node
    // rejects the spontaneous payment and the leg simply fails, because the
    // sender never retries LNURL after attempting a keysend.
    pubkey: '02b32faddac6789150d61d656b7e24335131eacfde91949748acca43738aeeebc4',
  },
};

// Same strict shape the reader enforces (lib/v4v/keysend-lookup.ts). Validating
// on the way out too means a typo in NAMES fails closed here, where it's one
// 404, rather than in someone else's payment path.
const NODE_PUBKEY = /^0[23][0-9a-f]{64}$/;

// Fetched cross-origin by wallets and podcast apps. Providers generally set no
// CORS headers on this endpoint — which is why our own reader has to proxy it
// server-side — so sending them costs nothing and lets browser-based payers
// read ours directly.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
} as const;

function notFound() {
  // The reader treats `status: "ERROR"` and any non-2xx alike as "no keysend
  // endpoint" and falls back to LNURL, so this is the ordinary answer for an
  // unknown name, not a fault.
  return NextResponse.json(
    { status: 'ERROR', reason: 'No keysend endpoint for that name' },
    { status: 404, headers: CORS },
  );
}

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const limited = rateLimit(req, 'keysend-wellknown', 120);
  if (limited) return limited;

  const { name } = await ctx.params;
  const entry = NAMES[name?.trim().toLowerCase() ?? ''];
  if (!entry || !NODE_PUBKEY.test(entry.pubkey)) return notFound();

  const { pubkey, customKey, customValue } = entry;
  return NextResponse.json(
    {
      status: 'OK',
      tag: 'keysend',
      pubkey,
      // Only ever emitted as a complete pair. `customData` is the documented
      // shape; the top-level copy is what several readers in the wild look at
      // first, and ours accepts either.
      ...(customKey && customValue
        ? { customKey, customValue, customData: [{ customKey, customValue }] }
        : {}),
    },
    { headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' } },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
