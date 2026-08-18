/**
 * Deploy — the deployment wizard. Target user: not a developer.
 *
 * Output: a concrete, copy-pasteable configuration (src/config.ts editable
 * block + wrangler.toml) and the exact steps to get a live relay running in
 * the user's OWN Cloudflare account — the operator owns the infrastructure.
 *
 * @module ui/pages/deploy
 */

import { pageHeader } from '../app.js';
import { escapeHtml, toast } from '../api.js';

const REPO = 'https://github.com/NostrDanish/SIP-Booster-Relay';
const CF_DEPLOY_BUTTON = `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(REPO)}`;

export async function renderDeploy(root, ctx) {
  root.innerHTML = pageHeader(
    'Deploy your own SIP-01 relay',
    '“WordPress installation simplicity” for running a piece of the decentralized search engine.'
  ) + `
    <div class="notice">
      <strong>You own the infrastructure.</strong> The relay deploys into <em>your</em> Cloudflare account —
      your Workers, your D1 database, your Durable Objects. Nobody else (including this project)
      can read your relay's data or turn it off.
    </div>

    <div class="grid cols-2">
      <section class="panel">
        <h2>// 1 · configure</h2>
        <label>Relay name</label>
        <input type="text" id="cfg-name" value="my-sip-relay">

        <label>Operator npub (receives zaps when payment is on)</label>
        <input type="text" id="cfg-npub" placeholder="npub1…">

        <label>Relay mode</label>
        <select id="cfg-mode">
          <option value="sip01" selected>SIP-01 only (dedicated search index)</option>
          <option value="hybrid">Hybrid (general Nostr relay + SIP-01 index)</option>
          <option value="general">General Nostr relay (no SIP-01)</option>
        </select>

        <div class="mt">
          <label class="inline"><input type="checkbox" id="cfg-validation" checked> SIP-01 schema validation</label>
          <label class="inline"><input type="checkbox" id="cfg-nip50" checked> NIP-50 search</label>
          <label class="inline"><input type="checkbox" id="cfg-nip45" checked> NIP-45 counts</label>
          <label class="inline"><input type="checkbox" id="cfg-nip77" checked> NIP-77 federation</label>
        </div>

        <label>Payment</label>
        <select id="cfg-payment">
          <option value="free" selected>Free (no payment)</option>
          <option value="donation">Donation (optional zap button)</option>
          <option value="pay-to-relay">Pay-to-publish (zap required)</option>
        </select>

        <label>Price (sats, when payment is not free)</label>
        <input type="number" id="cfg-sats" value="1000" min="1">

        <label>Indexer policy</label>
        <select id="cfg-indexer-policy">
          <option value="open" selected>Open (any valid signed observation)</option>
          <option value="blocklist">Blocklist (block specific indexers)</option>
          <option value="allowlist">Allowlist (only listed indexers)</option>
        </select>

        <div class="mt">
          <label class="inline"><input type="checkbox" id="cfg-auth"> Require NIP-42 auth</label>
          <label class="inline"><input type="checkbox" id="cfg-pruning" checked> Auto-pruning at 9 GB</label>
        </div>

        <button class="btn mt" id="generate">Generate configuration</button>
      </section>

      <section class="panel">
        <h2>// 2 · deploy</h2>
        <div class="deploy-step active">
          <div class="step-num">STEP 1</div>
          <h3>Get the code</h3>
          <p class="small muted">Fork
            <a href="${REPO}" target="_blank" rel="noopener">the repository</a> on GitHub
            (recommended: GitHub-connected deploys auto-update), or clone it locally, or open it in Shakespeare:</p>
          <p class="mt"><a href="https://shakespeare.diy/clone?url=https%3A%2F%2Fgithub.com%2FNostrDanish%2FSIP-Booster-Relay.git" target="_blank" rel="noopener"><img src="https://shakespeare.diy/badge.svg" alt="Edit with Shakespeare" class="h-auto"></a></p>
        </div>
        <div class="deploy-step">
          <div class="step-num">STEP 2</div>
          <h3>Paste your configuration</h3>
          <p class="small muted">Apply the generated <code>src/config.ts</code> values (below after step 1).</p>
        </div>
        <div class="deploy-step">
          <div class="step-num">STEP 3</div>
          <h3>Create the database</h3>
          <div class="codeblock">npx wrangler login
npx wrangler d1 create sip01-relay</div>
          <p class="small muted">Copy the printed <code>database_id</code> into <code>wrangler.toml</code>
            (the wizard's output below already has the right shape — paste the id in).</p>
        </div>
        <div class="deploy-step">
          <div class="step-num">STEP 4</div>
          <h3>Deploy</h3>
          <div class="codeblock">npx wrangler deploy</div>
          <p class="small muted">Or one-click from your fork:
            <a href="${CF_DEPLOY_BUTTON}" target="_blank" rel="noopener">Deploy to Cloudflare ↗</a>
            (you will still need to create + bind the D1 database it asks for).</p>
        </div>
        <div class="deploy-step">
          <div class="step-num">STEP 5</div>
          <h3>Verify</h3>
          <div class="codeblock">curl -H "Accept: application/nostr+json" https://your-relay.workers.dev
# → "uncaged_index": { "sip01": true, … }</div>
          <p class="small muted">Then point Crawlstr/Indexstr at <code>wss://your-relay.workers.dev</code>
            and watch the dashboard fill up.</p>
        </div>
      </section>
    </div>

    <div id="generated"></div>
  `;

  root.querySelector('#generate').addEventListener('click', () => {
    const val = (id) => /** @type {HTMLInputElement} */ (root.querySelector(id)).value;
    const checked = (id) => /** @type {HTMLInputElement} */ (root.querySelector(id)).checked;

    const name = val('#cfg-name').trim() || 'my-sip-relay';
    const npub = val('#cfg-npub').trim() || 'npub1…';
    const mode = val('#cfg-mode');
    const payment = val('#cfg-payment');
    const sats = Math.max(1, parseInt(val('#cfg-sats'), 10) || 1000);
    const policy = val('#cfg-indexer-policy');

    const configSnippet = `// src/config.ts — generated by the deploy wizard
export const RELAY_MODE = '${mode}';
export const SIP01_VALIDATION = ${checked('#cfg-validation')};
export const NIP50_ENABLED = ${checked('#cfg-nip50')};
export const NIP45_ENABLED = ${checked('#cfg-nip45')};
export const NIP77_ENABLED = ${checked('#cfg-nip77')};

export const PAYMENT_MODE = '${payment}';
export const relayNpub = "${npub}";
export const RELAY_ACCESS_PRICE_SATS = ${sats};

export const AUTH_REQUIRED = ${checked('#cfg-auth')};
export const SIP01_INDEXER_POLICY = '${policy}';

export const DB_PRUNING_ENABLED = ${checked('#cfg-pruning')};

export const relayInfo = {
  name: "${name.replace(/"/g, '\\"')}",
  description: "A SIP-01 decentralized search index relay",
  // …keep the rest of the shipped relayInfo defaults or adjust to taste
};`;

    const wranglerSnippet = `# wrangler.toml
name = "${name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}"
compatibility_date = "2025-06-01"
main = "src/index.ts"

[assets]
directory = "./"
binding = "ASSETS"

[[durable_objects.bindings]]
name = "RELAY_WEBSOCKET"
class_name = "RelayWebSocket"

[[d1_databases]]
binding = "RELAY_DATABASE"
database_name = "sip01-relay"
database_id = "PASTE_YOUR_D1_DATABASE_ID_HERE"

[triggers]
crons = ["0 0 * * *"]

[limits]
cpu_ms = 300000

[[migrations]]
tag = "v4"
new_sqlite_classes = ["RelayWebSocket"]`;

    root.querySelector('#generated').innerHTML = `
      <div class="grid cols-2">
        <section class="panel">
          <h2>// your src/config.ts block</h2>
          <pre class="codeblock" id="out-config">${escapeHtml(configSnippet)}</pre>
          <button class="btn small ghost" data-copy="out-config">Copy</button>
        </section>
        <section class="panel">
          <h2>// your wrangler.toml</h2>
          <pre class="codeblock" id="out-wrangler">${escapeHtml(wranglerSnippet)}</pre>
          <button class="btn small ghost" data-copy="out-wrangler">Copy</button>
        </section>
      </div>
      <section class="panel">
        <h2>// after deploy</h2>
        <p class="small muted">
          1. Open <code>https://${escapeHtml(name.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}.workers.dev</code> —
             the landing page should show your relay URL.<br>
          2. Check <code>curl -H "Accept: application/nostr+json" …</code> for the
             <code>uncaged_index</code> block.<br>
          3. Add your relay to Crawlstr/Indexstr publish pools (settings → relays).<br>
          4. Optional: add a custom domain in the Worker's <em>Settings → Domains &amp; Routes</em>.<br>
          5. Optional: list your relay in the SIP-01 relay registry so engines discover it (docs/FEDERATION.md).
        </p>
      </section>
    `;

    for (const btn of root.querySelectorAll('[data-copy]')) {
      btn.addEventListener('click', () => {
        const el = root.querySelector(`#${btn.getAttribute('data-copy')}`);
        navigator.clipboard.writeText(el.textContent || '').then(() => toast('Copied'));
      });
    }

    root.querySelector('#generated').scrollIntoView({ behavior: 'smooth' });
  });
}
