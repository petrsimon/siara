/**
 * Familiarity scorer (graduated 0–1, normalized within the eligible pool).
 *
 *   familiarity = α * commitScore + β * reviewScore
 *
 * Simple path prefers LOWEST familiarity (education). Hard path feeds it into
 * knowledge. Zero familiarity (true stranger) → highest on the simple path.
 */
import type { ResolvedConfig } from "../config.js";
import type { CandidateHistory, FileChange } from "../types.js";
import { dirOf } from "../util/paths.js";

/** File paths and parent dirs touched by the PR diff. */
function commitPaths(files: FileChange[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(file.path);
    paths.add(dirOf(file.path));
  }
  return [...paths];
}

function rawFamiliarity(
  candidate: CandidateHistory,
  files: FileChange[],
  config: ResolvedConfig,
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

  const { commitWeight, reviewWeight } = config.familiarity;
  return commitWeight * commitScore + reviewWeight * reviewScore;
}

/** Returns familiarity per login, normalized to 0–1 across the pool. */
export function scoreFamiliarity(
  candidates: CandidateHistory[],
  files: FileChange[],
  config: ResolvedConfig,
): Record<string, number> {
  const rawByLogin: Record<string, number> = {};

  for (const candidate of candidates) {
    rawByLogin[candidate.login] = rawFamiliarity(candidate, files, config);
  }

  const maxRaw = Math.max(0, ...Object.values(rawByLogin));
  const result: Record<string, number> = {};

  for (const candidate of candidates) {
    const raw = rawByLogin[candidate.login] ?? 0;
    // Pool max 0 → everyone is a stranger (all 0).
    result[candidate.login] = maxRaw === 0 ? 0 : raw / maxRaw;
  }

  return result;
}
