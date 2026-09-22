#!/usr/bin/env node
/**
 * NIP-66 relay announcement (kind 30166) — make this relay discoverable by
 * SIP-01 engines.
 *
 * Engines (sip-01-core `relayDiscovery`, 0xSearchstr, 0xPresearchstr) find
 * search/index relays in two phases: (1) query big bootstrap relays for
 * kind 30166 announcements with a `#N: ['50']` tag filter, (2) verify each
 * candidate's NIP-11 document (`supported_nips` + the `uncaged_index`
 * block). This script publishes the announcement that gets you into
 * phase 1 — your relay's NIP-11 document (already emitted by the relay)
 * passes phase 2 as-is.
 *
 * Usage:
 *
 *   # private key as hex or nsec, relay URL as argument:
 *   RELAY_NSEC=nsec1... node scripts/announce-relay.mjs wss://your-relay.workers.dev
 *
 *   # extra announce targets beyond the engine bootstrap relays:
 *   node scripts/announce-relay.mjs wss://your-relay.workers.dev wss://nos.lol
 *
 * Kind 30166 is addressable (d = relay URL): re-running replaces your
 * previous announcement. Many relays prune 30166 aggressively — re-announce
 * periodically (e.g. daily cron on your laptop/CI). Requires Node >= 22
 * (global WebSocket).
 *
 * No dependencies beyond the repo's @noble/curves.
 */

import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';
import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */

const BOOTSTRAP_RELAYS = [
  'wss://relay.nostr.band/',
  'wss://relay.primal.net/',
  'wss://relay.damus.io/',
];

function fail(msg) {
  console.error(`announce-relay: ${msg}`);
  process.exit(1);
}

/** Decode RELAY_NSEC/RELAY_KEY (nsec bech32 or 64-char hex) to raw bytes. */
function loadSecretKey() {
  const raw = process.env.RELAY_NSEC || process.env.RELAY_KEY || '';
  if (/^[0-9a-f]{64}$/i.test(raw)) return hexToBytes(raw);
  if (raw.startsWith('nsec1')) {
    // Minimal bech32 decode — Nostr nsec is plain BIP-173 bech32 over the
    // raw 32-byte key (NO segwit version byte; verified against NIP-19).
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const lower = raw.toLowerCase();
    const pos = lower.lastIndexOf('1');
    const data = [...lower.slice(pos + 1, -6)].map((c) => CHARSET.indexOf(c));
    if (data.some((v) => v < 0)) fail('invalid nsec encoding');
    // convert 5-bit groups to 8-bit bytes
    let acc = 0, bits = 0;
    const bytes = [];
    for (const v of data) {
      acc = (acc << 5) | v; bits += 5;
      if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
    }
    const key = Uint8Array.from(bytes);
    if (key.length !== 32) fail(`nsec decoded to ${key.length} bytes, expected 32`);
    return key;
  }
  fail('set RELAY_NSEC=nsec1… (or RELAY_KEY=<64 hex chars>)');
}

function signEvent(sk, unsigned) {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const event = { ...unsigned, pubkey };
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const id = createHash('sha256').update(serialized).digest('hex');
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk));
  return { ...event, id, sig };
}

/** Publish one event to one relay; resolves with the relay's OK message. */
function publish(relayUrl, event, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      try { ws?.close(); } catch { /* noop */ }
      resolve({ relay: relayUrl, ok, detail });
    };
    let ws;
    try {
      ws = new WebSocket(relayUrl);
    } catch (error) {
      return done(false, `connect: ${error.message}`);
    }
    const timer = setTimeout(() => done(false, 'timeout'), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(String(msg.data));
        if (data[0] === 'OK' && data[1] === event.id) {
          clearTimeout(timer);
          done(data[2] === true, String(data[3] ?? ''));
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => { clearTimeout(timer); done(false, 'socket error'); };
    ws.onclose = () => { clearTimeout(timer); done(false, 'closed before OK'); };
  });
}

/* ------------------------------------------------------------------ */

if (typeof WebSocket === 'undefined') {
  fail('global WebSocket not available — run with Node >= 22');
}

const relayUrl = process.argv[2];
if (!relayUrl || !/^wss?:\/\//.test(relayUrl)) {
  fail('usage: RELAY_NSEC=nsec1… node scripts/announce-relay.mjs wss://your-relay [extra relays…]');
}
const normalizedRelay = relayUrl.replace(/\/+$/, '');
const extraTargets = process.argv.slice(3);

// Build the N tag set from the relay's own NIP-11 document (truthful by
// construction — engines verify this document anyway).
const httpUrl = normalizedRelay.replace(/^ws/, 'http');
let nip11;
try {
  const res = await fetch(httpUrl, { headers: { Accept: 'application/nostr+json' } });
  if (!res.ok) fail(`NIP-11 fetch failed: HTTP ${res.status}`);
  nip11 = await res.json();
} catch (error) {
  fail(`could not fetch ${httpUrl} NIP-11 document: ${error.message}`);
}
if (!Array.isArray(nip11.supported_nips)) fail('NIP-11 document has no supported_nips');

const sk = loadSecretKey();
const created_at = Math.floor(Date.now() / 1000);

// NIP-66 kind 30166: d = relay URL, N = each supported NIP, content = the
// NIP-11 document. `l` language tags optional — engines filter on #N only.
const announcement = signEvent(sk, {
  kind: 30166,
  created_at,
  content: JSON.stringify(nip11),
  tags: [
    ['d', `${normalizedRelay}/`],
    ...nip11.supported_nips.map((n) => ['N', String(n)]),
    ...(nip11.uncaged_index?.sip01 ? [['T', 'sip01-index']] : []),
    ['alt', `Relay announcement: ${nip11.name ?? normalizedRelay}`],
  ],
});

console.log(`announcing ${normalizedRelay} as kind 30166 (id ${announcement.id.slice(0, 16)}…)`);
console.log(`  N tags: ${nip11.supported_nips.join(', ')}${nip11.uncaged_index?.sip01 ? ' (+ sip01-index)' : ''}`);

const targets = [...new Set([...BOOTSTRAP_RELAYS, ...extraTargets])];
for (const target of targets) {
  const result = await publish(target, announcement);
  console.log(`  ${result.ok ? '✓' : '✗'} ${result.relay} ${result.detail}`);
}

console.log('\nDone. Engines refresh discovery at most every 24h; re-run daily (many relays prune kind 30166 aggressively).');
