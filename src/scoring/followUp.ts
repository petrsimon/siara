/**
 * Follow-up affinity boost: reward reviewer continuity on related work.
 * Signals: shared branch family, shared Jira epic, within windowDays.
 * Stacks with diminishing returns. Additive boost, never a gate.
 */
import type { ResolvedConfig } from "../config.js";
import type { CandidateHistory, JiraData, PullRequest } from "../types.js";
import { sameBranchFamily } from "../util/paths.js";

/** Geometric diminishing: hit n contributes boost × 0.5^n (first hit full weight). */
function diminishingBoost(boost: number, hitIndex: number): number {
  return boost * Math.pow(0.5, hitIndex);
}

function daysBetween(earlierIso: string, laterIso: string): number {
  const earlier = new Date(earlierIso).getTime();
  const later = new Date(laterIso).getTime();
  return (later - earlier) / (1000 * 60 * 60 * 24);
}

function isWithinWindow(
  reviewedAt: string,
  nowIso: string,
  windowDays: number,
): boolean {
  const ageDays = daysBetween(reviewedAt, nowIso);
  return ageDays >= 0 && ageDays <= windowDays;
}

/** Returns additive follow-up boost per login (0 when no related work). */
export function scoreFollowUp(
  candidates: CandidateHistory[],
  pr: PullRequest,
  jira: JiraData | undefined,
  config: ResolvedConfig,
  nowIso: string,
): Record<string, number> {
  const { branchFamilyBoost, epicBoost, windowDays } =
    config.followUpAffinity;
  const result: Record<string, number> = {};

  for (const candidate of candidates) {
    let branchHits = 0;
    let epicHits = 0;
    let totalBoost = 0;

    for (const review of candidate.recentReviews) {
      if (!isWithinWindow(review.reviewedAt, nowIso, windowDays)) {
        continue;
      }

      if (sameBranchFamily(review.branch, pr.branch)) {
        totalBoost += diminishingBoost(branchFamilyBoost, branchHits);
        branchHits++;
      }

      if (jira?.epic && review.jiraEpic === jira.epic) {
        totalBoost += diminishingBoost(epicBoost, epicHits);
        epicHits++;
      }
    }

    result[candidate.login] = totalBoost;
  }

  return result;
}
