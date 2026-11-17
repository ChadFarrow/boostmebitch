// A stand-in for the LNbits wallet the site's note stamps are minted on, for
// `e2e:sitestamp`. It speaks the two calls `lib/lnbits.ts` makes, in the shape
// LNbits `main` answers them (lnbits/core/views/payment_api.py, read 2026-11-17):
//
//   POST /api/v1/payments   X-Api-Key, { out: false, amount, unit: 'sat', memo, expiry }
//        → 201 Payment { payment_hash, amount (msat), bolt11, payment_request, status, memo }
//   GET  /api/v1/payments/{payment_hash}   X-Api-Key
//        → 200 { paid, status, preimage, details: Payment }   (details only for the key's own wallet)
//        → 404 { detail: 'Payment does not exist.' }
//
// Nothing here moves money. An invoice is "paid" when the test says so
// (`markPaid`), which is what a wallet stand-in calls when the page pays.
//
// `mode` turns on the failures the e2e drives:
//   mint: 'ok' | 'fail' (520, as LNbits answers a node error) | 'hang' (never answers)
//         | 'overcharge' (an invoice for twice the asked amount)
//   lookup: 'ok' | 'hang'

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const bech32ish = (n) => Array.from(randomBytes(n), (b) => BECH32[b % 32]).join('');

export function createFakeLnbits({ port = 0, key }) {
  const byHash = new Map();
  const byBolt11 = new Map();
  const minted = [];
  const lookups = [];
  const mode = { mint: 'ok', lookup: 'ok' };
  const hung = new Set();
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://lnbits.invalid');
    if (req.headers['x-api-key'] !== key) return send(401, { detail: 'Invalid key' });

    if (req.method === 'POST' && url.pathname === '/api/v1/payments') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body;
      try { body = JSON.parse(raw); } catch { return send(400, { detail: 'bad json' }); }
      if (mode.mint === 'hang') { hung.add(res); return undefined; }
      if (mode.mint === 'fail') return send(520, { detail: 'Payment or Invoice error.' });
      if (body.out !== false || body.unit !== 'sat' || !Number.isInteger(body.amount) || body.amount <= 0) {
        return send(400, { detail: 'Invalid BOLT11/BOLT12 string or missing fields.' });
      }
      const sats = mode.mint === 'overcharge' ? body.amount * 2 : body.amount;
      const preimage = randomBytes(32);
      const hash = createHash('sha256').update(preimage).digest('hex');
      const bolt11 = `lnbc${sats * 10}n1p${bech32ish(180)}`;
      const invoice = { hash, bolt11, amount: sats * 1000, memo: body.memo, expiry: body.expiry, paid: false, preimage: preimage.toString('hex') };
      byHash.set(hash, invoice);
      byBolt11.set(bolt11, invoice);
      minted.push({ hash, bolt11, amount: invoice.amount, memo: body.memo, expiry: body.expiry });
      return send(201, {
        checking_id: hash, payment_hash: hash, wallet_id: 'e2e', amount: invoice.amount, fee: 0,
        bolt11, payment_request: bolt11, status: 'pending', memo: body.memo,
      });
    }

    const m = /^\/api\/v1\/payments\/([0-9a-f]{64})$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      lookups.push(m[1]);
      if (mode.lookup === 'hang') { hung.add(res); return undefined; }
      const inv = byHash.get(m[1]);
      if (!inv) return send(404, { detail: 'Payment does not exist.' });
      const details = { payment_hash: inv.hash, amount: inv.amount, bolt11: inv.bolt11, status: inv.paid ? 'success' : 'pending', memo: inv.memo };
      return send(200, inv.paid
        ? { paid: true, status: 'success', preimage: inv.preimage, details }
        : { paid: false, status: 'pending', preimage: null, details });
    }
    return send(404, { detail: 'Not Found' });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });

  return {
    ready,
    minted,
    lookups,
    mode,
    /** The page "paid" this invoice. False when the fake never minted it. */
    markPaid(bolt11) {
      const inv = byBolt11.get(bolt11);
      if (!inv) return false;
      inv.paid = true;
      return true;
    },
    reset() {
      mode.mint = 'ok';
      mode.lookup = 'ok';
      for (const r of hung) r.destroy();
      hung.clear();
    },
    close() {
      for (const r of hung) r.destroy();
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
