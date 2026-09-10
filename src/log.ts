/**
 * Debug logging gate. `dbg()` is a no-op unless DEBUG_LOGS is enabled in
 * config — verbose per-event/per-query logging at relay scale is an
 * observability cost center. Errors and warnings always go through.
 *
 * @module src/log
 */

import { DEBUG_LOGS } from './config';

export function dbg(...args: unknown[]): void {
  if (DEBUG_LOGS) console.log(...args);
}
