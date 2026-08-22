/**
 * SIP Relay Deploy — the standalone hosted deploy service Worker.
 *
 * ISOLATION (audit P0-1): this is a separate Worker from the relay. It has
 * no Nostr relay protocol surface and no access to any relay event store —
 * it only serves /api/service/* (payments + deployments) against its own D1
 * database. Customer Cloudflare tokens transit in memory and are never
 * stored (docs/SECURITY.md).
 *
 * Deploy with: wrangler deploy --config wrangler.service.toml
 *
 * @module src/service-worker
 */

import type { Env } from './types';
import { handleServiceApi } from './service/routes';
import { ensureServiceDatabase } from './service/init';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'no-store' },
  });
}

/** Map the standalone service's own D1 onto the shape the service routes use. */
function serviceEnv(env: Env): Env {
  return { ...env, RELAY_DATABASE: env.SERVICE_DATABASE ?? env.RELAY_DATABASE };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/health') {
      return json({ status: 'ok', service: 'sip-relay-deploy', time: Math.floor(Date.now() / 1000) });
    }

    if (url.pathname === '/' && request.method === 'GET') {
      return json({
        service: 'SIP Relay Deploy',
        docs: 'https://github.com/NostrDanish/SIP-Booster-Relay',
        config: '/api/service/config',
        note: 'Hosted paid deployment of SIP-01 relays into your own Cloudflare account.',
      });
    }

    if (url.pathname.startsWith('/api/service/')) {
      const mapped = serviceEnv(env);
      if (!mapped.RELAY_DATABASE) {
        return json({ error: 'SERVICE_DATABASE binding missing (see wrangler.service.toml)' }, 500);
      }
      await ensureServiceDatabase(mapped.RELAY_DATABASE);
      return handleServiceApi(request, mapped, url);
    }

    return json({ error: 'not found' }, 404);
  },
};
