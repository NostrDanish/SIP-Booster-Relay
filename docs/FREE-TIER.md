# Running on the Cloudflare free tier

This relay is designed to live comfortably inside Cloudflare's free plan.
This page is the operator's budget sheet: what the limits are, what this
relay does to stay under them, and which knobs to turn as you grow.

> The free-tier numbers below were checked against Cloudflare's docs in
> September 2026 — including the **D1 hard enforcement** change effective
> 2026-09-01: past the daily row limits, D1 queries *fail* until 00:00 UTC.
> Treat the budgets as walls, not guidelines.

## The budgets

| Resource | Free plan | What it means for this relay |
|---|---|---|
| Workers requests | 100,000 / day | HTTP hits (NIP-11, API, dashboard) + Worker invocations. Static assets are unmetered. |
| Workers CPU | 10 ms / request | Schnorr verify + JSON parse ≈ 1–3 ms — comfortable. Waiting on D1 does not count. |
| Subrequests | 50 / request | Query fan-out stays small by design. |
| Durable Object requests | 100,000 / day | **Every WebSocket message is a DO request.** This is the real relay-traffic cap. |
| Durable Object duration | 13,000 GB-s / day | Hibernating DOs are not billed while idle — this relay uses `acceptWebSocket` hibernation everywhere. |
| Durable Object storage | 5 GB, SQLite-backed classes only | This relay's DO migration uses `new_sqlite_classes` (required for free). |
| D1 rows read | 5,000,000 / day (hard) | Search queries are index-driven (FTS5 / covering indexes), not table scans. |
| D1 rows written | 100,000 / day (hard) | See the write math below — the binding constraint for crawlers. |
| D1 storage | 5 GB (hard) | Pruning defaults (4 GB / 3.5 GB) keep you under it; see docs/OPERATIONS.md. |
| Cron triggers | 5 / account | This relay uses 1 (daily maintenance). |

## Write math (the constraint that bites first)

One accepted kind 39697 observation costs roughly **20–25 D1 rows written**
(event row, per-tag cache rows, observation/document/indexer rows, FTS
delete+insert, metrics). On the free tier that is on the order of
**4,000–5,000 new observations per day** before D1 writes fail until
midnight UTC.

What this relay does to stretch that:

- **Metric coalescing** — observational counters accumulate in memory and
  flush in one batch (≤ 15 s window), turning N per-event metric writes into
  one. On a busy relay this alone saves ~10–20 % of the write budget.
- **Batched ingestion** — all per-event writes go through `session.batch()`
  (D1's 100-statement batch cap is respected).
- **Addressable replacement** — a recrawl *replaces* the old row set rather
  than accumulating history, so steady-state crawler traffic costs deletes
  + inserts but storage stays flat.
- **FTS index is best-effort** — if FTS5 maintenance fails, ingestion never
  fails and search degrades to LIKE.

If you outgrow it: raise relay fees (payment mode), enable the indexer
allowlist, or move to Workers Paid ($5/mo raises D1 to 25B reads / 50M
writes per month included).

## Read math

Reads are index-driven: `site:`/`domain:` hit `url_host` indexes, text terms
hit the FTS5 index, `#tag` filters hit the multi-value tag cache, and COUNT
uses the same paths. The COUNT-based query precheck refuses pathological
filters before they scan. Dashboard/API queries aggregate over the small
derived tables, never the raw event store.

## Durable Objects on free

- **SQLite backend is mandatory** on the free plan — the repo's
  `new_sqlite_classes` migration satisfies this. Do not recreate the DO
  class with the legacy key-value backend.
- **Hibernation is the cost model**: idle sockets sleep and stop billing
  duration. Do not add long-running `setInterval` loops to the DO — they
  pin it in memory and burn the 13,000 GB-s/day duration budget. Use cron
  or alarms instead.
- Every WebSocket message counts as one DO request: 100k/day ≈ 1.15
  messages/second sustained. Federation (NIP-77) sessions amortize bulk
  sync into few messages — prefer sync over REQ polling for bulk reads.

## Deployment checklist (free tier)

1. `wrangler.toml`: no `[limits] cpu_ms` block (the API rejects it on free,
   error 100328 — the repo ships without one).
2. Create your own D1 (`npx wrangler d1 create sip01-relay`) and paste the
   id — the placeholder in `wrangler.toml` is not deployable.
3. Keep `observability.logs.enabled = false` — log volume is a cost center.
4. Keep `DEBUG_LOGS = false` in `src/config.ts` (default).
5. Pruning defaults are already free-tier-safe (`DB_SIZE_THRESHOLD_GB = 4`,
   `DB_PRUNE_TARGET_GB = 3.5`). If you move to a paid plan you can raise
   them to 9 / 8.
6. Rebuilds: `worker.js` / `service-worker.js` are committed — `npm run
   build` after changing `src/`.

## When you outgrow free

Symptoms in order: D1 write failures late in the day (crawler-heavy),
DO request cap (many simultaneous clients), then the 100k Worker request
cap. Workers Paid ($5/mo) lifts all of them by orders of magnitude; the
code needs no changes — optionally raise the pruning thresholds and add
`[limits] cpu_ms` back.
