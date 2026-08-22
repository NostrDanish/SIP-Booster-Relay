/**
 * Hosted deploy service — HTTP API.
 *
 *   GET  /api/service/config             public service configuration
 *   POST /api/service/pay/lightning      { event: <9735 receipt> } (Nostr-authed payer)
 *   POST /api/service/pay/pre            { txHash }                  (Nostr-authed payer)
 *   GET  /api/service/payment-status     ?pubkey=hex
 *   POST /api/service/deploy             { cfToken, cfAccountId, workerName } (paid credit required)
 *   GET  /api/service/admin/settings     (owner, NIP-98)
 *   POST /api/service/admin/settings     (owner, NIP-98) { key, value }
 *   GET  /api/service/admin/payments     (owner, NIP-98)
 *   GET  /api/service/admin/jobs         (owner, NIP-98)
 *
 * Payment/deploy calls identify the customer with a NIP-98-style signed
 * event too — the paying pubkey is the credit account, so the signature is
 * what binds payment → customer. Admin calls are additionally owner-gated.
 *
 * @module src/service/routes
 */

import * as config from '../config';
import type { Env } from '../types';
import { getServiceSettings, setServiceSetting, SERVICE_SETTING_KEYS } from './settings';
import { payWithLightning, payWithPre, hasDeployCredit, consumeDeployCredit } from './pay';
import { orchestrateDeploy } from './deploy';
import { verifyAdminAuth } from './auth';
import { validateServiceConfig } from './config-check';
import { runtimeOwnerPubkey, runtimeDeployServiceEnabled } from '../runtime-config';
import { verifyEventSignature } from '../relay-worker';

type Session = D1DatabaseSession;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store',
    },
  });
}

function dayKey(ip: string): string {
  return `${ip}:${new Date().toISOString().slice(0, 10)}`;
}

async function checkIpRate(session: Session, ip: string): Promise<boolean> {
  if (!ip) return true; // no IP visible (non-CF context) — allow
  const key = dayKey(ip);
  const row = await session
    .prepare(
      `INSERT INTO deploy_rate (ip_day, count) VALUES (?, 1)
       ON CONFLICT(ip_day) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key)
    .first();
  return ((row?.count as number) ?? 1) <= config.DEPLOY_MAX_PER_IP_PER_DAY;
}

/** Verify the caller's Nostr signature (NIP-98-bound) and return their pubkey. */
async function authedPubkey(request: Request, rawBody: string): Promise<string | null> {
  const header = request.headers.get('Authorization') || '';
  const match = /^Nostr\s+(.+)$/.exec(header);
  if (!match) return null;
  let event;
  try {
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    event = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!event || (event.kind !== 27242 && event.kind !== 27235)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > 300) return null;

  // Bind the proof to this exact request (NIP-98).
  const tag = (name: string) => event.tags.find((t: string[]) => t[0] === name)?.[1];
  if (tag('u') !== request.url) return null;
  if ((tag('method') || '').toUpperCase() !== request.method.toUpperCase()) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody || ''));
    const payloadHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (tag('payload') !== payloadHash) return null;
  }

  if (!(await verifyEventSignature(event))) return null;
  return event.pubkey;
}

export async function handleServiceApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (!runtimeDeployServiceEnabled(env)) {
    return json({ error: 'deploy service is disabled on this relay' }, 404);
  }

  const path = url.pathname.replace(/^\/api\/service\/?/, '');
  const session: Session = env.RELAY_DATABASE.withSession('first-primary');
  const rawBody = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();

  // Live settings (D1) → config validation (audit P0-2): a misconfigured
  // service never accepts money.
  const settings = await getServiceSettings(session, env);
  const check = validateServiceConfig(settings.pre_address);

  /* ---------------- public config ---------------- */
  if (path === 'config' && request.method === 'GET') {
    return json({
      enabled: true,
      owner_npub: settings.zap_npub,
      owner_pubkey: runtimeOwnerPubkey(env),
      deploy_price_sats: Number(settings.deploy_price_sats),
      deploy_price_pre: Number(settings.deploy_price_pre),
      zap_npub: settings.zap_npub,
      pre: {
        address: settings.pre_address,
        token_contract: config.PRE_TOKEN_CONTRACT,
        chain_id: config.BASE_CHAIN_ID,
        network: 'Base',
        decimals: config.PRE_TOKEN_DECIMALS,
      },
      methods: { lightning: check.lightningEnabled, pre: check.preEnabled },
      config_errors: check.errors,
      relay_repo: 'https://github.com/NostrDanish/SIP-Booster-Relay',
    });
  }

  /* ---------------- payments ---------------- */
  if (path === 'pay/lightning' && request.method === 'POST') {
    if (!check.lightningEnabled) return json({ error: `Lightning payments not available: ${check.errors.join('; ')}` }, 503);
    const pubkey = await authedPubkey(request, rawBody);
    if (!pubkey) return json({ error: 'sign in with Nostr first (signed auth required)' }, 401);
    let body: any;
    try { body = JSON.parse(rawBody); } catch { return json({ error: 'invalid JSON' }, 400); }
    if (!body?.event) return json({ error: 'missing zap receipt event' }, 400);
    const result = await payWithLightning(session, body.event, pubkey, verifyEventSignature, env);
    return result.ok ? json({ ok: true }) : json({ error: result.error }, 400);
  }

  if (path === 'pay/pre' && request.method === 'POST') {
    if (!check.preEnabled) return json({ error: `PRE payments not available: ${check.errors.join('; ')}` }, 503);
    const pubkey = await authedPubkey(request, rawBody);
    if (!pubkey) return json({ error: 'sign in with Nostr first (signed auth required)' }, 401);
    let body: any;
    try { body = JSON.parse(rawBody); } catch { return json({ error: 'invalid JSON' }, 400); }
    if (!body?.txHash) return json({ error: 'missing txHash' }, 400);
    const result = await payWithPre(session, String(body.txHash), pubkey, env);
    return result.ok ? json({ ok: true }) : json({ error: result.error }, 400);
  }

  if (path === 'payment-status' && request.method === 'GET') {
    const pubkey = url.searchParams.get('pubkey') || '';
    if (!/^[0-9a-f]{64}$/.test(pubkey)) return json({ error: 'invalid pubkey' }, 400);
    return json({ paid: await hasDeployCredit(session, pubkey) });
  }

  /* ---------------- deploy ---------------- */
  if (path === 'deploy' && request.method === 'POST') {
    if (!check.ok) {
      return json({ error: `deploy service is misconfigured: ${check.errors.join('; ')}` }, 503);
    }
    const pubkey = await authedPubkey(request, rawBody);
    if (!pubkey) return json({ error: 'sign in with Nostr first (signed auth required)' }, 401);

    let body: any;
    try { body = JSON.parse(rawBody); } catch { return json({ error: 'invalid JSON' }, 400); }

    if (!(await hasDeployCredit(session, pubkey))) {
      return json({ error: 'payment required — pay first (Lightning or PRE)', paid: false }, 402);
    }

    const ip = request.headers.get('CF-Connecting-IP') || '';
    if (!(await checkIpRate(session, ip))) {
      return json({ error: 'too many deployments from this IP today' }, 429);
    }

    const creditId = await consumeDeployCredit(session, pubkey);
    const workerName = String(body.workerName || '');

    // Idempotency (audit P1): the job row exists before provisioning starts,
    // so a Cloudflare timeout after partial provisioning never becomes an
    // accidental double deployment — the job is the record.
    let jobId: number | null = null;
    if (creditId !== null) {
      const job = await session
        .prepare("INSERT INTO deploy_jobs (pubkey, worker_name, relay_url, payment_id, status) VALUES (?, ?, '', ?, 'provisioning') RETURNING id")
        .bind(pubkey, workerName, creditId)
        .first()
        .catch((e) => { console.error('deploy_jobs insert failed:', e); return null; });
      jobId = (job?.id as number) ?? null;
    }

    let result;
    try {
      result = await orchestrateDeploy({
        pubkey,
        cfToken: String(body.cfToken || ''),
        cfAccountId: String(body.cfAccountId || ''),
        workerName,
        // The customer is the owner of their deployed relay by default.
        relayName: body.relayName ? String(body.relayName) : undefined,
        relayNpub: body.relayNpub ? String(body.relayNpub) : undefined,
        ownerPubkey: body.ownerPubkey ? String(body.ownerPubkey) : pubkey,
      });
    } catch (error: any) {
      result = { ok: false, error: error?.message ?? 'deploy failed', steps: [] };
    }

    if (jobId !== null) {
      await session
        .prepare("UPDATE deploy_jobs SET status = ?, relay_url = ?, steps = ? WHERE id = ?")
        .bind(result.ok ? 'deployed' : 'failed', result.relay_wss_url ?? '', JSON.stringify(result.steps ?? []), jobId)
        .run()
        .catch((e) => console.error('deploy_jobs update failed:', e));
    }

    if (!result.ok && creditId !== null) {
      // Refund the credit on failure.
      await session.prepare('UPDATE deploy_payments SET used_at = NULL WHERE id = ?').bind(creditId).run()
        .catch(() => undefined);
    }

    // Never echo back any part of the customer's token.
    return json(result, result.ok ? 200 : 502);
  }

  /* ---------------- admin (owner, NIP-98) ---------------- */
  if (path.startsWith('admin/')) {
    const auth = await verifyAdminAuth(request, rawBody, env);
    if (!auth.ok) return json({ error: `unauthorized: ${auth.error}` }, 401);

    if (path === 'admin/settings' && request.method === 'GET') {
      return json({ settings: await getServiceSettings(session, env), keys: SERVICE_SETTING_KEYS });
    }

    if (path === 'admin/settings' && request.method === 'POST') {
      let body: any;
      try { body = JSON.parse(rawBody); } catch { return json({ error: 'invalid JSON' }, 400); }
      const key = String(body?.key ?? '');
      const value = String(body?.value ?? '').trim();
      if (!SERVICE_SETTING_KEYS.includes(key as any)) return json({ error: 'unknown setting' }, 400);
      // Value validation per key
      if ((key === 'deploy_price_sats' || key === 'deploy_price_pre') && !/^\d{1,12}$/.test(value)) {
        return json({ error: 'price must be a positive integer' }, 400);
      }
      if (key === 'zap_npub' && !/^npub1[02-9ac-hj-np-z]{20,}$/.test(value)) {
        return json({ error: 'zap_npub must be a valid npub' }, 400);
      }
      if (key === 'pre_address' && !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        return json({ error: 'pre_address must be a 0x EVM address' }, 400);
      }
      await setServiceSetting(session, key, value);
      return json({ ok: true, settings: await getServiceSettings(session, env) });
    }

    if (path === 'admin/payments' && request.method === 'GET') {
      const rows = await session
        .prepare('SELECT id, pubkey, method, amount, proof, payer_detail, created_at, used_at FROM deploy_payments ORDER BY id DESC LIMIT 200')
        .all();
      return json({ payments: rows.results ?? [] });
    }

    if (path === 'admin/jobs' && request.method === 'GET') {
      const rows = await session
        .prepare('SELECT id, pubkey, worker_name, relay_url, payment_id, status, steps, created_at FROM deploy_jobs ORDER BY id DESC LIMIT 200')
        .all();
      return json({ jobs: rows.results ?? [] });
    }

    return json({ error: 'unknown admin endpoint' }, 404);
  }

  return json({ error: 'unknown service endpoint' }, 404);
}
