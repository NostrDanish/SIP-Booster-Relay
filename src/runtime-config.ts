/**
 * Runtime configuration overrides via Worker plain-text bindings.
 *
 * The stock bundle is built once (CI), but each deployment may need its own
 * identity — especially relays provisioned by the hosted deploy service,
 * where the customer is the relay's owner. These env bindings (set at deploy
 * time, no rebuild) override the compile-time defaults in src/config.ts:
 *
 *   RELAY_NAME              NIP-11 name
 *   RELAY_NPUB              operator npub (payment recipient + zap target default)
 *   RELAY_CONTACT           NIP-11 contact
 *   RELAY_PUBKEY            NIP-11 admin pubkey (hex)
 *   SERVICE_OWNER_PUBKEY    /admin owner (hex)
 *   DEPLOY_SERVICE_ENABLED  "false" disables /api/service/* on this instance
 *
 * @module src/runtime-config
 */

import * as config from './config';
import type { Env } from './types';

export function runtimeRelayName(env: Env): string {
  return env.RELAY_NAME?.trim() || config.relayInfo.name;
}

export function runtimeRelayNpub(env: Env): string {
  return env.RELAY_NPUB?.trim() || config.relayNpub;
}

export function runtimeRelayPubkey(env: Env): string {
  return env.RELAY_PUBKEY?.trim() || config.relayInfo.pubkey;
}

export function runtimeRelayContact(env: Env): string {
  return env.RELAY_CONTACT?.trim() || config.relayInfo.contact;
}

export function runtimeOwnerPubkey(env: Env): string {
  return env.SERVICE_OWNER_PUBKEY?.trim() || config.SERVICE_OWNER_PUBKEY;
}

export function runtimeDeployServiceEnabled(env: Env): boolean {
  const v = env.DEPLOY_SERVICE_ENABLED?.trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'off') return false;
  if (v === 'true' || v === '1' || v === 'on') return true; // standalone service worker
  return config.DEPLOY_SERVICE_ENABLED;
}

/** Payment mode override: PAYMENT_MODE = free | donation | pay-to-relay. */
export function runtimePaymentMode(env: Env): 'free' | 'donation' | 'pay-to-relay' {
  const v = env.PAYMENT_MODE?.trim().toLowerCase();
  if (v === 'free' || v === 'donation' || v === 'pay-to-relay') return v;
  return config.PAYMENT_MODE;
}

export function runtimePaymentPriceSats(env: Env): number {
  const v = Number.parseInt(env.RELAY_ACCESS_PRICE_SATS?.trim() ?? '', 10);
  if (Number.isFinite(v) && v > 0) return v;
  return config.RELAY_ACCESS_PRICE_SATS;
}

/** NIP-42 auth requirement override: AUTH_REQUIRED = true | false. */
export function runtimeAuthRequired(env: Env): boolean {
  const v = env.AUTH_REQUIRED?.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'off') return false;
  return config.AUTH_REQUIRED;
}
