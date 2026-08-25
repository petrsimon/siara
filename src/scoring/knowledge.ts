/**
 * Knowledge scorer (hard + moderate paths). Commit + review counts on changed
 * paths with simple recency weighting, normalized within the eligible pool.
 *
 * TODO(composer): implement.
 */
import type { ResolvedConfig } from "../config.js";
import type { CandidateHistory, FileChange } from "../types.js";

/** Returns knowledge per login, normalized to 0–1 across the pool. */
export function scoreKnowledge(
  _candidates: CandidateHistory[],
  _files: FileChange[],
  _config: ResolvedConfig,
): Record<string, number> {
  throw new Error("not implemented");
}
