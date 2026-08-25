/**
 * Dry-run: full scoring pipeline for every pending PR, returns ranked
 * candidates + rationale prefixed with "[DRY RUN]". No side effects.
 * Thin wrapper over daily(deps, now, { dryRun: true }) plus formatted output.
 *
 * TODO(composer): implement.
 */
import type { DailyResult, SiaraDeps } from "./index.js";

export async function dryRun(
  _deps: SiaraDeps,
  _nowIso: string,
): Promise<DailyResult> {
  throw new Error("not implemented");
}
