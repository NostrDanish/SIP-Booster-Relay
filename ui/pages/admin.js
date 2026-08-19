/**
 * Admin — the deploy-service owner's dashboard: prices, receiving wallets
 * (Lightning npub + PRE on Base), payment ledger, deployment history.
 *
 * Authentication is NIP-98: every request is individually signed with the
 * owner's key (kind 27235). The worker verifies owner + signature + URL +
 * method + payload + freshness on every call. No sessions.
 *
 * @module ui/pages/admin
 */

import { pageHeader, relayBannerHtml, bindRelayBanner } from '../app.js';
import { apiGet, escapeHtml, getRelayHttpBase, fmtTime, shortHex, toast } from '../api.js';
import { hasNostrSigner, nostrGetPubkey, serviceFetch } from '../nip98.js';

const SETTING_FIELDS = [
  ['deploy_price_sats', 'Deploy price (sats, Lightning)', 'integer'],
  ['deploy_price_pre', 'Deploy price (PRE on Base)', 'integer'],
  ['zap_npub', 'Lightning recipient npub (zap target)', 'npub'],
  ['pre_address', 'PRE receiving wallet (Base, 0x…)', 'evm'],
];

export async function renderAdmin(root, ctx) {
  root.innerHTML = pageHeader('Service admin', 'Owner-only deploy-service settings. Every change is signed with your Nostr key (NIP-98).') +
    relayBannerHtml() + `<div id="admin-body"></div>`;
  bindRelayBanner(root);

  const body = root.querySelector('#admin-body');
  const base = getRelayHttpBase();

  let config;
  try {
    config = await apiGet('/api/service/config');
  } catch (error) {
    body.innerHTML = `<div class="notice"><strong>Deploy service not reachable.</strong> ${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!config.enabled) {
    body.innerHTML = `<div class="notice info"><strong>Deploy service is disabled</strong> on this relay (DEPLOY_SERVICE_ENABLED = false).</div>`;
    return;
  }

  if (!hasNostrSigner()) {
    body.innerHTML = `<div class="notice"><strong>Nostr signer required.</strong> Install a NIP-07 extension (Alby, nos2x, …) to manage this service. Nothing is ever signed without your explicit approval.</div>`;
    return;
  }

  body.innerHTML = `
    <section class="panel">
      <h2>// owner sign-in</h2>
      <p class="small muted mb">The service owner is <code class="mono">${escapeHtml(shortHex(config.owner_pubkey || '', 12, 8))}</code>.
         Sign in with that key to manage prices and wallets.</p>
      <button class="btn" id="login">Sign in with Nostr</button>
      <span class="small faint" id="login-status" style="margin-left:.8rem"></span>
    </section>
    <div id="admin-area"></div>
  `;

  body.querySelector('#login').addEventListener('click', async () => {
    const status = body.querySelector('#login-status');
    try {
      const pubkey = await nostrGetPubkey();
      if (pubkey !== config.owner_pubkey) {
        status.textContent = `signed in as ${shortHex(pubkey)} — not the service owner`;
        status.style.color = 'var(--red)';
        return;
      }
      status.textContent = `owner ${shortHex(pubkey)} ✓`;
      status.style.color = 'var(--green)';
      await loadAdminArea(root.querySelector('#admin-area'), base);
    } catch (error) {
      status.textContent = error.message;
      status.style.color = 'var(--red)';
    }
  });
}

async function loadAdminArea(area, base) {
  const settingsRes = await serviceFetch(base, '/api/service/admin/settings');
  if (!settingsRes.ok) {
    area.innerHTML = `<div class="notice"><strong>Auth failed.</strong> ${escapeHtml(settingsRes.data?.error || 'HTTP ' + settingsRes.status)}</div>`;
    return;
  }
  const settings = settingsRes.data.settings;

  area.innerHTML = `
    <section class="panel">
      <h2>// prices & receiving wallets</h2>
      <p class="small faint mb">Saved to D1 instantly; no redeploy needed. Changes are signed with your key.</p>
      ${SETTING_FIELDS.map(([key, label]) => `
        <label>${escapeHtml(label)}</label>
        <div class="flex">
          <input type="text" id="set-${key}" value="${escapeHtml(settings[key] ?? '')}">
          <button class="btn small" data-save="${key}">Save</button>
        </div>
      `).join('')}
      <p class="faint small mt">Lightning payments arrive as zaps to the npub's profile address (set a lud16 on
        that profile). PRE payments arrive on Base (chain 8453) to the wallet above.</p>
    </section>

    <section class="panel">
      <h2>// payments</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>when</th><th>customer</th><th>method</th><th style="text-align:right">amount</th><th>proof</th><th>used</th></tr></thead>
        <tbody id="payments-body"><tr><td colspan="6" class="faint">loading…</td></tr></tbody>
      </table></div>
    </section>

    <section class="panel">
      <h2>// deployments</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>when</th><th>customer</th><th>worker</th><th>relay</th></tr></thead>
        <tbody id="jobs-body"><tr><td colspan="4" class="faint">loading…</td></tr></tbody>
      </table></div>
    </section>
  `;

  // Save handlers
  for (const btn of area.querySelectorAll('[data-save]')) {
    btn.addEventListener('click', async () => {
      const key = btn.getAttribute('data-save');
      const value = /** @type {HTMLInputElement} */ (area.querySelector(`#set-${key}`)).value.trim();
      btn.disabled = true;
      const res = await serviceFetch(base, '/api/service/admin/settings', { method: 'POST', body: { key, value } });
      btn.disabled = false;
      if (res.ok && res.data?.ok) {
        toast(`${key} saved`);
      } else {
        toast(`save failed: ${res.data?.error || 'HTTP ' + res.status}`);
      }
    });
  }

  // Tables
  const paymentsRes = await serviceFetch(base, '/api/service/admin/payments');
  const payments = paymentsRes.data?.payments || [];
  area.querySelector('#payments-body').innerHTML = payments.length
    ? payments.map((p) => `
        <tr>
          <td class="mono-cell">${escapeHtml(fmtTime(p.created_at))}</td>
          <td class="mono-cell" title="${escapeHtml(p.pubkey)}">${escapeHtml(shortHex(p.pubkey))}</td>
          <td class="mono-cell">${escapeHtml(p.method)}</td>
          <td class="mono-cell" style="text-align:right">${escapeHtml(p.amount)} ${p.method === 'lightning' ? 'sats' : 'PRE'}</td>
          <td class="mono-cell" title="${escapeHtml(p.proof)}">${escapeHtml(shortHex(p.proof, 8, 6))}</td>
          <td class="mono-cell">${p.used_at ? '✓ ' + escapeHtml(fmtTime(p.used_at)) : '—'}</td>
        </tr>`).join('')
    : '<tr><td colspan="6" class="faint">No payments yet.</td></tr>';

  const jobsRes = await serviceFetch(base, '/api/service/admin/jobs');
  const jobs = jobsRes.data?.jobs || [];
  area.querySelector('#jobs-body').innerHTML = jobs.length
    ? jobs.map((j) => `
        <tr>
          <td class="mono-cell">${escapeHtml(fmtTime(j.created_at))}</td>
          <td class="mono-cell" title="${escapeHtml(j.pubkey)}">${escapeHtml(shortHex(j.pubkey))}</td>
          <td class="mono-cell">${escapeHtml(j.worker_name)}</td>
          <td class="mono-cell">${j.relay_url ? `<a href="${escapeHtml(j.relay_url.replace('wss://', 'https://'))}" target="_blank" rel="noopener">${escapeHtml(j.relay_url)}</a>` : '—'}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="faint">No deployments yet.</td></tr>';
}
