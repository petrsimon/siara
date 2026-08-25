/**
 * Sync: fetch GitHub/Jira signals into the store. Cold-start on first run
 * (full sync window), incremental afterwards (since last sync timestamp).
 *
 * TODO(composer): implement.
 */
import type { SiaraDeps, SyncResult } from "./index.js";

export async function sync(
  _deps: SiaraDeps,
  _nowIso: string,
): Promise<SyncResult[]> {
  throw new Error("not implemented");
}
