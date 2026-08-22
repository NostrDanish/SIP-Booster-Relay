/**
 * Service configuration validation (audit P0-2).
 *
 * A misconfigured deploy service must never accept money: a zero-address PRE
 * wallet or an undecodable zap npub would route payments into the void.
 * Serverless equivalent of "fail startup": misconfigured methods are
 * disabled; if NO payment method is usable, the service refuses payment and
 * deployment calls with 503 + the exact problem until fixed.
 *
 * @module src/service/config-check
 */

import * as config from '../config';
import { npubToHex } from '../../shared/bech32.js';

export interface ServiceConfigCheck {
  /** True when at least one payment method is fully configured. */
  ok: boolean;
  errors: string[];
  lightningEnabled: boolean;
  preEnabled: boolean;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function validateServiceConfig(preAddressOverride?: string): ServiceConfigCheck {
  const errors: string[] = [];

  // Lightning path: recipient npub must decode.
  const lightningEnabled = npubToHex(config.DEPLOY_ZAP_NPUB) !== null;
  if (!lightningEnabled) {
    errors.push('DEPLOY_ZAP_NPUB is not a valid npub — Lightning payments disabled');
  }

  // PRE path: the wallet must be a real, non-zero address; all RPCs https.
  const preAddress = (preAddressOverride ?? config.DEPLOY_PRE_ADDRESS).toLowerCase();
  const rpcOk = config.BASE_RPC_URLS.length > 0 && config.BASE_RPC_URLS.every((u) => u.startsWith('https://'));
  const preEnabled = /^0x[0-9a-f]{40}$/.test(preAddress) && preAddress !== ZERO_ADDRESS && rpcOk;
  if (preAddress === ZERO_ADDRESS) {
    errors.push('DEPLOY_PRE_ADDRESS is the zero address — PRE payments disabled until the owner sets a real Base wallet (/admin)');
  } else if (!/^0x[0-9a-f]{40}$/.test(preAddress)) {
    errors.push('DEPLOY_PRE_ADDRESS is not a valid 0x EVM address — PRE payments disabled');
  }
  if (!rpcOk) {
    errors.push('BASE_RPC_URLS must all be https:// endpoints');
  }

  // Bundle provenance: must be an https URL pinned to an immutable commit
  // (never a moving branch like /main/).
  try {
    const u = new URL(config.DEPLOY_BUNDLE_URL);
    if (u.protocol !== 'https:' || u.pathname.includes('/main/')) {
      errors.push('DEPLOY_BUNDLE_URL must be https and pinned to an immutable commit (DEPLOY_BUNDLE_REF)');
    }
  } catch {
    errors.push('DEPLOY_BUNDLE_URL is not a valid URL');
  }

  return {
    ok: errors.length === 0 && (lightningEnabled || preEnabled),
    errors,
    lightningEnabled,
    preEnabled,
  };
}
