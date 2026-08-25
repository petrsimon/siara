/**
 * Files-at-risk / bus-factor spread (SofiaWL). Detect changed files known by
 * only one developer; when some file is bus-factor-1, apply an additive spread
 * boost toward a NON-OWNER eligible candidate so knowledge propagates — even on
 * hard PRs. Cross-cutting boost, orthogonal to the difficulty band.
 */
import type { ResolvedConfig } from "../config.js";
import type { CandidateHistory, FileChange } from "../types.js";

export interface FilesAtRiskResult {
  /** Count of changed files known by only one developer. */
  atRiskCount: number;
  /** Additive spread boost per login (positive for non-owners). */
  boosts: Record<string, number>;
}

function knowsFile(candidate: CandidateHistory, path: string): boolean {
  if ((candidate.commitsByPath[path] ?? 0) > 0) {
    return true;
  }
  return (candidate.reviewsByPath?.[path] ?? 0) > 0;
}

export function scoreFilesAtRisk(
  candidates: CandidateHistory[],
  files: FileChange[],
  config: ResolvedConfig,
): FilesAtRiskResult {
  const boosts: Record<string, number> = {};
  for (const candidate of candidates) {
    boosts[candidate.login] = 0;
  }

  if (files.length === 0 || candidates.length === 0) {
    return { atRiskCount: 0, boosts };
  }

  const atRiskFiles: string[] = [];

  for (const file of files) {
    const knowers = candidates.filter((c) => knowsFile(c, file.path));
    // Exactly one knower = bus-factor-1. Nobody-knows (can't spread what no one
    // has) and many-knowers are both excluded.
    if (knowers.length === 1) {
      atRiskFiles.push(file.path);
    }
  }

  const atRiskCount = atRiskFiles.length;

  if (atRiskCount === 0) {
    return { atRiskCount, boosts };
  }

  const { spreadBoost } = config.filesAtRisk;

  for (const candidate of candidates) {
    const knowsAnyAtRisk = atRiskFiles.some((path) =>
      knowsFile(candidate, path),
    );
    // Owners (sole knowers) get 0; everyone else gets the spread boost.
    boosts[candidate.login] = knowsAnyAtRisk ? 0 : spreadBoost;
  }

  return { atRiskCount, boosts };
}
