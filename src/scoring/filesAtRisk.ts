/**
 * Files-at-risk / bus-factor spread (SofiaWL). Detect changed files known by
 * only one developer; when some file is bus-factor-1, apply an additive spread
 * boost toward a NON-OWNER eligible candidate so knowledge propagates — even on
 * hard PRs. Cross-cutting boost, orthogonal to the difficulty band.
 *
 * TODO(composer): implement.
 */
import type { ResolvedConfig } from "../config.js";
import type { CandidateHistory, FileChange } from "../types.js";

export interface FilesAtRiskResult {
  /** Count of changed files known by only one developer. */
  atRiskCount: number;
  /** Additive spread boost per login (positive for non-owners). */
  boosts: Record<string, number>;
}

export function scoreFilesAtRisk(
  _candidates: CandidateHistory[],
  _files: FileChange[],
  _config: ResolvedConfig,
): FilesAtRiskResult {
  throw new Error("not implemented");
}
