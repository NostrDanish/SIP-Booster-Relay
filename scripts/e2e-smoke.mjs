#!/usr/bin/env node
/**
 * End-to-end smoke test against a live SIP relay (read-only + negative
 * write test). Runs daily in CI (e2e-smoke.yml) and locally:
 *
 *   RELAY_URL=https://your-relay.workers.dev node scripts/e2e-smoke.mjs
 *
 * Checks: NIP-11 advertises SIP-01, health/schema OK, search API shape,
 * WebSocket REQ roundtrip, invalid event rejected with `OK false invalid:`,
 * NIP-45 COUNT shape. Exits non-zero on any failure.
 */

const RELAY_URL = (process.env.RELAY_URL || '').replace(/\/+$/, '');
if (!RELAY_URL) {
  console.error('RELAY_URL env var required (e.g. https://your-relay.workers.dev)');
  process.exit(2);
}
const WS_URL = RELAY_URL.replace(/^http/, 'ws');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`);
  else {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// 1. NIP-11 advertises SIP-01
const nip11 = await fetch(RELAY_URL, { headers: { Accept: 'application/nostr+json' } }).then((r) => r.json()).catch(() => null);
check('nip11: document served', !!nip11 && Array.isArray(nip11.supported_nips));
check('nip11: uncaged_index.sip01', nip11?.uncaged_index?.sip01 === true, JSON.stringify(nip11?.uncaged_index ?? null)?.slice(0, 120));

// 2. Health + schema
const health = await fetch(`${RELAY_URL}/api/health`).then((r) => r.json()).catch(() => null);
check('health: ok', health?.status === 'ok', JSON.stringify(health));
check('health: schema_ok', health?.schema_ok === true);

// 3. Search API shape (empty index is fine — shape matters)
const search = await fetch(`${RELAY_URL}/api/search?q=lang%3Aen&limit=1`).then((r) => r.json()).catch(() => null);
check('search: responds with events array', Array.isArray(search?.events));

// 4. WebSocket: REQ roundtrip + invalid event rejection + COUNT
const wsResults = await new Promise((resolve) => {
  const out = { eose: false, okInvalid: false, count: null };
  let ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    resolve(out);
    return;
  }
  const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(out); }, 12000);

  ws.onopen = () => {
    ws.send(JSON.stringify(['REQ', 'smoke', { kinds: [39697], limit: 1 }]));
    ws.send(JSON.stringify(['COUNT', 'smoke-count', { kinds: [39697] }]));
    ws.send(JSON.stringify(['EVENT', {
      id: '00'.repeat(32), pubkey: '00'.repeat(32), created_at: 1786200000,
      kind: 39697, tags: [], content: '', sig: '00'.repeat(64),
    }]));
  };
  ws.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data[0] === 'EOSE' && data[1] === 'smoke') out.eose = true;
      if (data[0] === 'OK' && data[2] === false && /invalid/i.test(data[3] || '')) out.okInvalid = true;
      if (data[0] === 'COUNT' && data[1] === 'smoke-count' && typeof data[2]?.count === 'number') {
        out.count = data[2].count;
      }
      if (out.eose && out.okInvalid && out.count !== null) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(out);
      }
    } catch { /* ignore */ }
  };
  ws.onerror = () => { clearTimeout(timer); resolve(out); };
});

check('ws: REQ → EOSE', wsResults.eose);
check('ws: invalid event rejected with OK false invalid:', wsResults.okInvalid);
check('ws: COUNT shape', typeof wsResults.count === 'number', `got ${JSON.stringify(wsResults.count)}`);

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
