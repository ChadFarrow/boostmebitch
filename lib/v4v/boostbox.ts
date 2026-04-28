'use client';

// BoostBox metadata sidechannel — https://github.com/ChadFarrow/boostbox
//
// Carries the structured boostagram metadata that can't ride on an LNURL-pay
// `comment` field (too short / unstructured) or a Spark BOLT11 description.
// Sender POSTs the boostagram, gets back a short URL + a canonical "desc"
// string in the form:
//
//   rss::payment::boost https://boostbox.cloud/boost/<id> [message]
//
// That `desc` string is what aggregators (Helipad-style) look for in invoice
// descriptions and LNURL `comment` fields. Resolvers fetch the URL and pull
// the original metadata back out of the `x-rss-payment` HTTP header.
//
// This is rail-agnostic: NWC, WebLN, AND Spark lnaddress legs all benefit,
// not just Spark. Node-pubkey keysend legs still ship the boostagram
// in-band via TLV 7629169 in lib/v4v/boost.ts and don't need this.

import type { Boostagram } from '@/lib/types';

const DEFAULT_BASE_URL = 'https://boostbox.cloud';
const DEFAULT_API_KEY = 'v4v4me'; // public demo key per BoostBox README

const BASE_URL = process.env.NEXT_PUBLIC_BOOSTBOX_URL || DEFAULT_BASE_URL;
const API_KEY = process.env.NEXT_PUBLIC_BOOSTBOX_API_KEY || DEFAULT_API_KEY;

interface BoostBoxResponse {
  id: string;
  url: string;
  desc: string;
}

/**
 * POST a boostagram to BoostBox. Returns the canonical `desc` string
 * (`rss::payment::boost <url> [message]`) which can be used as the
 * LNURL-pay comment or BOLT11 description. Returns null on failure so
 * callers can fall back to the raw message without aborting the boost.
 */
export async function registerBoostMetadata(
  boostagram: Boostagram,
): Promise<BoostBoxResponse | null> {
  try {
    const res = await fetch(`${BASE_URL}/boost`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_KEY,
      },
      body: JSON.stringify(toBoostBoxBody(boostagram)),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BoostBoxResponse;
    if (!data?.url) return null;
    return data;
  } catch {
    return null;
  }
}

// BoostBox's required fields: action, split, value_msat, value_msat_total,
// timestamp (ISO-8601). Map the in-flight Boostagram onto that shape; pass
// optional fields through verbatim where names match.
function toBoostBoxBody(b: Boostagram): Record<string, unknown> {
  return {
    action: b.action,
    split: 100, // weight-aware splits live in the value block, not here
    value_msat: b.value_msat ?? b.value_msat_total ?? 0,
    value_msat_total: b.value_msat_total ?? b.value_msat ?? 0,
    timestamp: new Date().toISOString(),
    message: b.message,
    app_name: b.app_name,
    sender_name: b.sender_name,
    sender_id: b.sender_id,
    podcast: b.podcast,
    episode: b.episode,
    feedID: b.feedID,
    itemID: b.itemID,
    url: b.url,
    ts: b.ts,
    uuid: b.uuid,
    remote_feed_guid: b.remote_feed_guid,
    episode_guid: b.episode_guid,
    remote_item_guid: b.remote_item_guid,
  };
}
