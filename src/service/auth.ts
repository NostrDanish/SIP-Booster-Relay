/**
 * Admin authentication for the deploy service — NIP-98 (HTTP auth with
 * signed Nostr events, kind 27235).
 *
 * Every admin request carries a freshly signed event in the Authorization
 * header: `Nostr <base64url(event)>`. The worker verifies, statelessly:
 *   - kind 27235, valid Schnorr signature;
 *   - pubkey === SERVICE_OWNER_PUBKEY (the /admin dashboard is owner-only);
 *   - created_at within ±5 minutes (replay window);
 *   - `u` tag === the exact request URL;
 *   - `method` tag === the request method;
 *   - `payload` tag === sha256 hex of the raw request body (POST/PUT).
 *
 * No sessions, no cookies, no stored secrets — the owner's key is the
 * credential and never leaves their signer.
 *
 * @module src/service/auth
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { runtimeOwnerPubkey } from '../runtime-config';
import type { Env, NostrEvent } from '../types';

const KIND_HTTP_AUTH = 27235;
const FRESHNESS_SECONDS = 300;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

async function verifySignedEvent(event: NostrEvent): Promise<boolean> {
  try {
    const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)));
    if (bytesToHex(hash) !== event.id) return false;
    return schnorr.verify(hexToBytes(event.sig), hash, hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

export interface AdminAuthResult {
  ok: boolean;
  error?: string;
}

/**
 * Verify the admin credentials of a request. `rawBody` must be the exact
 * request body text (empty string for GET).
 */
export async function verifyAdminAuth(request: Request, rawBody: string, env: Env): Promise<AdminAuthResult> {
  const header = request.headers.get('Authorization') || '';
  const match = /^Nostr\s+(.+)$/.exec(header);
  if (!match) return { ok: false, error: 'missing Nostr auth event' };

  let event: NostrEvent;
  try {
    event = JSON.parse(base64UrlDecode(match[1]));
  } catch {
    return { ok: false, error: 'malformed auth event' };
  }

  if (!event || event.kind !== KIND_HTTP_AUTH) {
    return { ok: false, error: `auth event must be kind ${KIND_HTTP_AUTH}` };
  }
  if (event.pubkey !== runtimeOwnerPubkey(env)) {
    return { ok: false, error: 'not the service owner' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > FRESHNESS_SECONDS) {
    return { ok: false, error: 'auth event expired' };
  }

  const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];

  if (tag('u') !== request.url) {
    return { ok: false, error: 'u tag mismatch' };
  }
  if ((tag('method') || '').toUpperCase() !== request.method.toUpperCase()) {
    return { ok: false, error: 'method tag mismatch' };
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const payloadHash = await sha256Hex(rawBody || '');
    if (tag('payload') !== payloadHash) {
      return { ok: false, error: 'payload hash mismatch' };
    }
  }

  if (!(await verifySignedEvent(event))) {
    return { ok: false, error: 'invalid signature' };
  }

  return { ok: true };
}
