/**
 * Dry-run: full scoring pipeline for every pending PR, returns ranked
 * candidates + rationale prefixed with "[DRY RUN]". No side effects.
 * Thin wrapper over daily(deps, now, { dryRun: true }) plus formatted output.
 */
import { daily } from "./daily.js";
import type { DailyOptions, DailyPrResult, DailyResult, SiaraDeps } from "./index.js";

export async function dryRun(
  deps: SiaraDeps,
  nowIso: string,
  opts: Pick<DailyOptions, "noSync" | "strategy"> = {},
): Promise<DailyResult> {
  return daily(deps, nowIso, { dryRun: true, noSync: opts.noSync, strategy: opts.strategy });
}

function formatPrBlock(pr: DailyPrResult): string {
  const assignees =
    pr.assignees.length > 0 ? pr.assignees.join(", ") : "(none)";
  return [
    `[DRY RUN] ${pr.repo}#${pr.pr}`,
    `Assignees: ${assignees}`,
    pr.rationale,
  ].join("\n");
}

/** Format a dry-run result for CLI display. */
export function formatDryRun(result: DailyResult): string {
  return result.assigned.map(formatPrBlock).join("\n\n");
}
