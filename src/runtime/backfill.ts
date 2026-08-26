/**
 * Backfill: score all current open PRs to populate difficulty bands.
 *
 * This one-time operation ensures Siara has complete difficulty data for existing
 * PRs, allowing accurate load balancing even for PRs assigned before Siara or
 * manually assigned outside its control.
 */
import type { SiaraDeps } from "./index.js";
import type { Assignment } from "../types.js";
import { resolveConfig } from "../config.js";
import { scoreDifficulty } from "../scoring/difficulty.js";

function findRepoConfig(
  deps: SiaraDeps,
  repo: string,
): ReturnType<typeof resolveConfig> {
  const repoConfig = deps.repoConfigs.find((config) => config.repo === repo);
  return resolveConfig(deps.teamConfig, repoConfig);
}

export interface BackfillResult {
  totalPrs: number;
  scored: number;
  alreadyScored: number;
}

export async function backfill(
  deps: SiaraDeps,
  nowIso: string,
): Promise<BackfillResult> {
  let totalPrs = 0;
  let scored = 0;
  let alreadyScored = 0;

  // Read existing bands from assignment log
  const priorAssignments = await deps.store.readAssignments();
  const existingBands = new Map<string, string>();
  for (const a of priorAssignments) {
    if (a.band) {
      existingBands.set(`${a.repo}#${a.pr}`, a.band);
    }
  }

  const newAssignments: Assignment[] = [];

  for (const repo of deps.repos) {
    const resolved = findRepoConfig(deps, repo);
    const openPrs = await deps.github.listOpenPullRequests(repo);

    for (const pr of openPrs) {
      totalPrs++;
      const key = `${repo}#${pr.number}`;

      // Skip if already scored
      if (existingBands.has(key)) {
        alreadyScored++;
        continue;
      }

      // Fetch diff and score
      const files = await deps.github.getPullRequestFiles(repo, pr.number);
      const diffResult = scoreDifficulty(files, resolved);

      // Create a backfill assignment record
      const assignment: Assignment = {
        date: nowIso.slice(0, 10), // ISO date only
        repo,
        pr: pr.number,
        assignees: pr.requestedReviewers.length > 0
          ? pr.requestedReviewers
          : [], // Empty if no reviewers yet
        band: diffResult.band,
        difficulty: diffResult.score,
        rationale: `[BACKFILL] Scored existing PR: difficulty ${diffResult.score.toFixed(2)} → ${diffResult.band}`,
        candidates: [], // No candidate scoring for backfill
      };

      newAssignments.push(assignment);
      scored++;
    }
  }

  // Append all new assignments to the log
  for (const assignment of newAssignments) {
    await deps.store.appendAssignment(assignment);
  }

  return { totalPrs, scored, alreadyScored };
}
