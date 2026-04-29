// BoostBox client — stores Podcasting 2.0 boost metadata over HTTP and
// returns a short `desc` string ("rss::payment::boost <url>") suitable for
// the LUD-21 comment field on an LNURL invoice.
//
// Used only on the LNURL leg of the boost flow: keysend carries the same
// metadata inline as TLV 7629169, so BoostBox is unnecessary there. Failure
// is non-fatal — callers fall back to the user's plain-text message.
//
// @see https://github.com/ChadFarrow/boostbox

import type { Boostagram, ValueRecipient } from '@/lib/types';

interface BoostBoxResponse {
  id: string;
  url: string;
  desc: string;
}

interface BoostBoxPayload {
  action: 'boost' | 'stream';
  split: number;
  value_msat: number;
  value_msat_total: number;
  timestamp: string;
  message?: string;
  app_name?: string;
  app_version?: string;
  sender_name?: string;
  sender_id?: string;
  sender_npub?: string;
  recipient_name?: string;
  recipient_address?: string;
  feed_guid?: string;
  feed_title?: string;
  item_guid?: string;
  item_title?: string;
  remote_feed_guid?: string;
  remote_item_guid?: string;
  group?: string;
  boost_link?: string;
}

function buildPayload(
  boostagram: Boostagram,
  recipient: ValueRecipient,
  splitWeight: number,
  legMsat: number,
): BoostBoxPayload {
  const action: 'boost' | 'stream' =
    boostagram.action === 'boost' ? 'boost' : 'stream';
  return {
    action,
    split: splitWeight || 1,
    value_msat: legMsat,
    value_msat_total: boostagram.value_msat_total ?? legMsat,
    timestamp: new Date().toISOString(),
    message: boostagram.message,
    app_name: boostagram.app_name,
    app_version: boostagram.app_version,
    sender_name: boostagram.sender_name,
    sender_id: boostagram.sender_id,
    sender_npub: boostagram.sender_id,
    recipient_name: recipient.name,
    recipient_address: recipient.address,
    feed_guid: boostagram.remote_feed_guid,
    feed_title: boostagram.podcast,
    item_guid: boostagram.episode_guid ?? boostagram.remote_item_guid,
    item_title: boostagram.episode,
    remote_feed_guid: boostagram.remote_feed_guid,
    remote_item_guid: boostagram.remote_item_guid,
    group: boostagram.uuid,
    boost_link: boostagram.url,
  };
}

/**
 * POST the boost metadata to the local BoostBox proxy and return the
 * `desc` + `url` pair on success. Returns null on any failure so callers
 * can degrade gracefully.
 */
export async function storeBoostMetadata(args: {
  boostagram: Boostagram;
  recipient: ValueRecipient;
  splitWeight: number;
  legMsat: number;
}): Promise<{ desc: string; url: string } | null> {
  try {
    const res = await fetch('/api/lightning/boostbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildPayload(args.boostagram, args.recipient, args.splitWeight, args.legMsat),
      ),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<BoostBoxResponse>;
    if (!data?.desc || !data?.url) return null;
    return { desc: data.desc, url: data.url };
  } catch {
    return null;
  }
}
