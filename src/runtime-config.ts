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
  return config.DEPLOY_SERVICE_ENABLED;
}
