/**
 * Soft helpers: Jira estimate + priority. Additive biases on the ranked list.
 * High estimate → slight expert boost. High priority → expert boost and/or
 * load protection. Never reclassifies the difficulty band.
 */
import type { ResolvedConfig } from "../config.js";
import type { JiraData, ScoredCandidate } from "../types.js";

/** Story points at or above this threshold trigger estimate expert bias. */
const HIGH_ESTIMATE_THRESHOLD = 5;

/** Open review load at or above this threshold triggers priority load penalty. */
const HIGH_LOAD_THRESHOLD = 3;

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

/** Mutates/returns candidates with soft boosts folded into `boosts`. */
export function applySoftBoosts(
  ranked: ScoredCandidate[],
  jira: JiraData | undefined,
  config: ResolvedConfig,
): ScoredCandidate[] {
  const {
    estimateExpertBoost,
    priorityExpertBoost,
    highPriorityLoadPenalty,
  } = config.soft;

  const knowledgeMedian = median(ranked.map((c) => c.knowledge));
  const highEstimate =
    jira?.estimate !== undefined && jira.estimate >= HIGH_ESTIMATE_THRESHOLD;
  const highPriority =
    jira?.priority === "high" || jira?.priority === "blocker";

  return ranked.map((candidate) => {
    const boosts = { ...candidate.boosts };

    if (highEstimate && candidate.knowledge >= knowledgeMedian) {
      boosts.softEstimate += estimateExpertBoost;
    }

    if (highPriority) {
      if (candidate.knowledge >= knowledgeMedian) {
        boosts.softPriority += priorityExpertBoost;
      }
      if (candidate.openReviewLoad >= HIGH_LOAD_THRESHOLD) {
        boosts.softPriority -= highPriorityLoadPenalty;
      }
    }

    return { ...candidate, boosts };
  });
}
