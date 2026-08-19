/**
 * Nostr request signing for the deploy service (NIP-98-style, kind 27235).
 * The paying/admin pubkey is proven by a fresh signed event per request —
 * no accounts, no sessions, keys never leave the signer.
 *
 * @module ui/nip98
 */

function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hasNostrSigner() {
  return typeof window !== 'undefined' && !!window.nostr && typeof window.nostr.signEvent === 'function';
}

export async function nostrGetPubkey() {
  if (!hasNostrSigner()) throw new Error('No Nostr signer (install a NIP-07 extension like Alby or nos2x)');
  return window.nostr.getPublicKey();
}

/**
 * Sign a request and return the Authorization header value.
 * @param {string} url    Exact request URL (signed in the `u` tag).
 * @param {string} method HTTP method.
 * @param {string} [rawBody] Exact body text for POST/PUT (payload-bound).
 */
export async function signServiceAuth(url, method, rawBody = '') {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];
  if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
    tags.push(['payload', await sha256Hex(rawBody)]);
  }
  const event = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
  const signed = await window.nostr.signEvent(event);
  return 'Nostr ' + bytesToBase64Url(new TextEncoder().encode(JSON.stringify(signed)));
}

/** Signed fetch against the service API. */
export async function serviceFetch(base, path, { method = 'GET', body } = {}) {
  const url = base.replace(/\/+$/, '') + path;
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const auth = await signServiceAuth(url, method, rawBody);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      ...(rawBody ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json',
    },
    body: rawBody || undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
