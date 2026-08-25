/**
 * Familiarity scorer (graduated 0–1, normalized within the eligible pool).
 *
 *   familiarity = α * commitScore + β * reviewScore
 *
 * Simple path prefers LOWEST familiarity (education). Hard path feeds it into
 * knowledge. Zero familiarity (true stranger) → highest on the simple path.
 *
 * TODO(composer): implement.
 */
import type { ResolvedConfig } from "../config.js";
import type { CandidateHistory, FileChange } from "../types.js";

/** Returns familiarity per login, normalized to 0–1 across the pool. */
export function scoreFamiliarity(
  _candidates: CandidateHistory[],
  _files: FileChange[],
  _config: ResolvedConfig,
): Record<string, number> {
  throw new Error("not implemented");
}
