/**
 * Standalone service database init — the isolated deploy-service Worker gets
 * ONLY the service tables (no event store, no relay schema). Idempotent.
 *
 * @module src/service/init
 */

import { SERVICE_SCHEMA_STATEMENTS } from '../sip01/schema';

let initPromise: Promise<void> | null = null;

export function ensureServiceDatabase(db: D1Database): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const session = db.withSession('first-primary');
      await session.prepare(
        `CREATE TABLE IF NOT EXISTS system_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )`,
      ).run();
      for (const statement of SERVICE_SCHEMA_STATEMENTS) {
        await session.prepare(statement).run();
      }
      await session.prepare(
        "INSERT OR REPLACE INTO system_config (key, value) VALUES ('service_db_initialized', '1')",
      ).run();
    })().catch((error) => {
      console.error('service DB init error:', error);
      initPromise = null; // retry next request
    });
  }
  return initPromise;
}
