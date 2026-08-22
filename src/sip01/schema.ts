/**
 * SIP-01 storage schema — D1 tables optimized for web-index observations.
 *
 * Design principle (from the project brief): D1 is NOT the whole web. These
 * tables hold compact searchable metadata about kind 39697 events; the
 * canonical Nostr `events` table remains the source of truth for the events
 * themselves. Larger artifacts (full page content, screenshots, …) belong in
 * R2 or external storage in future revisions without touching this schema.
 *
 *   sip01_documents    one row per `d` (URL identity), aggregated across
 *                      independent indexers — the searchable document index
 *   sip01_observations one row per live (pubkey, d) observation — provenance
 *   sip01_indexers     one row per indexer pubkey — operator statistics
 *   relay_metrics      monotonic counters for the dashboard/API
 *
 * @module src/sip01/schema
 */

/** Single-letter tags cached for generic NIP-01 `#x` tag filtering.
 *  Upstream set (p,e,a,t,d,r,L,s,u) plus SIP-01's filterable `l` and `x`. */
export const CACHED_TAG_NAMES = ['p', 'e', 'a', 't', 'd', 'r', 'L', 's', 'u', 'l', 'x'] as const;

/** SQL for the SIP-01 tables (idempotent). */
export const SIP01_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS sip01_documents (
    d TEXT PRIMARY KEY,
    canonical_url TEXT NOT NULL,
    url_host TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    image TEXT,
    content_hash TEXT,
    language TEXT,
    content_type TEXT,
    doc_type TEXT,
    platform TEXT,
    category TEXT,
    network TEXT,
    country TEXT,
    file_ext TEXT,
    topics TEXT NOT NULL DEFAULT '[]',
    published_at INTEGER,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    observation_count INTEGER NOT NULL DEFAULT 1,
    indexer_count INTEGER NOT NULL DEFAULT 1,
    first_indexed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    last_event_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sip01_documents_host ON sip01_documents(url_host, last_seen DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sip01_documents_last_seen ON sip01_documents(last_seen DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sip01_documents_language ON sip01_documents(language, last_seen DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sip01_documents_content_type ON sip01_documents(content_type, last_seen DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sip01_documents_content_hash ON sip01_documents(content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_sip01_documents_published ON sip01_documents(published_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sip01_observations (
    event_id TEXT PRIMARY KEY,
    d TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    content_hash TEXT,
    source TEXT,
    relay_seen_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE (pubkey, d)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sip01_observations_d ON sip01_observations(d, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sip01_observations_pubkey ON sip01_observations(pubkey, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sip01_observations_source ON sip01_observations(source, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sip01_indexers (
    pubkey TEXT PRIMARY KEY,
    software TEXT,
    software_version TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    observation_count INTEGER NOT NULL DEFAULT 0,
    document_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sip01_indexers_last_seen ON sip01_indexers(last_seen DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sip01_indexers_software ON sip01_indexers(software)`,

  `CREATE TABLE IF NOT EXISTS relay_metrics (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  )`,
];

/**
 * Schema version. v7: SIP-01 tag-cache rebuild (incl. `l`/`x`). v8:
 * idempotent deployment tracking (deploy job status/steps; audit P1).
 */
export const SCHEMA_VERSION = 8;

export function migrationV7Statements(): string[] {
  return [
    // Rebuild event_tags_cache_multi without the restrictive CHECK list.
    `CREATE TABLE IF NOT EXISTS event_tags_cache_multi_v7 (
      event_id TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      kind INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      tag_type TEXT NOT NULL,
      tag_value TEXT NOT NULL,
      PRIMARY KEY (event_id, tag_type, tag_value)
    )`,
    `INSERT OR IGNORE INTO event_tags_cache_multi_v7 (event_id, pubkey, kind, created_at, tag_type, tag_value)
      SELECT event_id, pubkey, kind, created_at, tag_type, tag_value FROM event_tags_cache_multi`,
    // Backfill l/x from the generic tags table for pre-v7 databases.
    `INSERT OR IGNORE INTO event_tags_cache_multi_v7 (event_id, pubkey, kind, created_at, tag_type, tag_value)
      SELECT e.id, e.pubkey, e.kind, e.created_at, t.tag_name, t.tag_value
      FROM events e INNER JOIN tags t ON e.id = t.event_id
      WHERE t.tag_name IN ('l', 'x')`,
    `DROP TABLE IF EXISTS event_tags_cache_multi`,
    `ALTER TABLE event_tags_cache_multi_v7 RENAME TO event_tags_cache_multi`,
    `CREATE INDEX IF NOT EXISTS idx_cache_multi_type_value_time ON event_tags_cache_multi(tag_type, tag_value, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_cache_multi_type_value_event ON event_tags_cache_multi(tag_type, tag_value, event_id)`,
    `CREATE INDEX IF NOT EXISTS idx_cache_multi_kind_type_value ON event_tags_cache_multi(kind, tag_type, tag_value, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_cache_multi_event_id ON event_tags_cache_multi(event_id)`,
    // NOTE: no tag_l column — SQLite identifiers are case-insensitive, so
    // `tag_l` collides with the existing `tag_L` (the 'L' tag). The 'l' tag
    // is fully indexed via event_tags_cache_multi (values are case-sensitive)
    // and needs no first-value column.
    `ALTER TABLE events ADD COLUMN tag_x TEXT`,
    `UPDATE events SET
      tag_x = (SELECT tag_value FROM tags WHERE event_id = events.id AND tag_name = 'x' LIMIT 1)
      WHERE EXISTS (SELECT 1 FROM tags t WHERE t.event_id = events.id AND t.tag_name = 'x')`,
  ];
}

/** v8: idempotent deployment tracking (audit P1) — status + step log. */
export function migrationV8Statements(): string[] {
  return [
    `ALTER TABLE deploy_jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'deployed'`,
    `ALTER TABLE deploy_jobs ADD COLUMN steps TEXT`,
  ];
}

/** Column list for the main events table insert (kept in one place). */
export const EVENT_INSERT_COLUMNS =
  'id, pubkey, created_at, kind, tags, content, sig, tag_p, tag_e, tag_a, tag_t, tag_d, tag_r, tag_L, tag_s, tag_u, tag_x, reply_to_event_id, root_event_id, content_preview';

/**
 * Hosted deploy service tables (see docs/DEPLOYMENT.md "Hosted deploy
 * service"). Runtime-editable settings live in D1 so the owner can change
 * prices/wallets from /admin without redeploying.
 */
export const SERVICE_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS service_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,

  // One row per verified payment. `proof` is unique (zap receipt id or PRE
  // tx hash) — replay protection. `used_at` marks the credit consumed by a
  // deployment.
  `CREATE TABLE IF NOT EXISTS deploy_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pubkey TEXT NOT NULL,
    method TEXT NOT NULL CHECK(method IN ('lightning', 'pre')),
    amount TEXT NOT NULL,
    proof TEXT NOT NULL UNIQUE,
    payer_detail TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    used_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_deploy_payments_pubkey ON deploy_payments(pubkey, used_at)`,

  `CREATE TABLE IF NOT EXISTS deploy_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pubkey TEXT NOT NULL,
    worker_name TEXT NOT NULL,
    relay_url TEXT NOT NULL,
    payment_id INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (payment_id) REFERENCES deploy_payments(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_deploy_jobs_pubkey ON deploy_jobs(pubkey, created_at DESC)`,

  // Per-IP daily deploy counter (abuse guard)
  `CREATE TABLE IF NOT EXISTS deploy_rate (
    ip_day TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  )`,
];
