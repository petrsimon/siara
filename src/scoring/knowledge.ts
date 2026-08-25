/**
 * Knowledge scorer (hard + moderate paths). Commit + review counts on changed
 * paths with simple recency weighting, normalized within the eligible pool.
 */
import type { ResolvedConfig } from "../config.js";
import type { CandidateHistory, FileChange } from "../types.js";
import { dirOf } from "../util/paths.js";

/** Expertise-oriented weights: commits weigh more than reviews (Phase 1). */
const COMMIT_EXPERTISE_WEIGHT = 0.7;
const REVIEW_EXPERTISE_WEIGHT = 0.3;

function commitPaths(files: FileChange[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(file.path);
    paths.add(dirOf(file.path));
  }
  return [...paths];
}

function rawKnowledge(
  candidate: CandidateHistory,
  files: FileChange[],
): number {
  const paths = commitPaths(files);

  let commitScore = 0;
  for (const path of paths) {
    commitScore += candidate.commitsByPath[path] ?? 0;
  }

  let reviewScore = candidate.repoReviewCount;
  if (candidate.reviewsByPath) {
    for (const file of files) {
      reviewScore += candidate.reviewsByPath[file.path] ?? 0;
    }
  }

  return (
    COMMIT_EXPERTISE_WEIGHT * commitScore +
    REVIEW_EXPERTISE_WEIGHT * reviewScore
  );
}

/** Returns knowledge per login, normalized to 0–1 across the pool. */
export function scoreKnowledge(
  candidates: CandidateHistory[],
  files: FileChange[],
  _config: ResolvedConfig,
): Record<string, number> {
  const rawByLogin: Record<string, number> = {};

  for (const candidate of candidates) {
    rawByLogin[candidate.login] = rawKnowledge(candidate, files);
  }

  const maxRaw = Math.max(0, ...Object.values(rawByLogin));
  const result: Record<string, number> = {};

  for (const candidate of candidates) {
    const raw = rawByLogin[candidate.login] ?? 0;
    result[candidate.login] = maxRaw === 0 ? 0 : raw / maxRaw;
  }

  return result;
}
