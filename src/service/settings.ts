/**
 * Runtime settings for the hosted deploy service. Live values live in D1
 * (`service_settings`) so the owner can change prices and receiving wallets
 * from /admin without redeploying; `src/config.ts` provides the defaults.
 *
 * @module src/service/settings
 */

import * as config from '../config';

type Session = D1DatabaseSession;

export interface ServiceSettings {
  deploy_price_sats: string;
  deploy_price_pre: string;
  zap_npub: string;
  pre_address: string;
}

const DEFAULTS: ServiceSettings = {
  deploy_price_sats: String(config.DEPLOY_PRICE_SATS),
  deploy_price_pre: String(config.DEPLOY_PRICE_PRE),
  zap_npub: config.DEPLOY_ZAP_NPUB,
  pre_address: config.DEPLOY_PRE_ADDRESS,
};

export const SERVICE_SETTING_KEYS = Object.keys(DEFAULTS) as Array<keyof ServiceSettings>;

/** All settings: D1 overrides merged over config defaults. */
export async function getServiceSettings(session: Session): Promise<ServiceSettings> {
  const out: ServiceSettings = { ...DEFAULTS };
  try {
    const rows = await session
      .prepare(`SELECT key, value FROM service_settings WHERE key IN (${SERVICE_SETTING_KEYS.map(() => '?').join(',')})`)
      .bind(...SERVICE_SETTING_KEYS)
      .all();
    for (const row of rows.results ?? []) {
      const key = row.key as keyof ServiceSettings;
      if (key in out) out[key] = row.value as string;
    }
  } catch (error) {
    console.error('service_settings read failed (using defaults):', error);
  }
  return out;
}

export async function setServiceSetting(session: Session, key: string, value: string): Promise<void> {
  if (!SERVICE_SETTING_KEYS.includes(key as keyof ServiceSettings)) {
    throw new Error(`unknown setting: ${key}`);
  }
  await session
    .prepare(
      `INSERT INTO service_settings (key, value, updated_at) VALUES (?, ?, strftime('%s', 'now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value)
    .run();
}
