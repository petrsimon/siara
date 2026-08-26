/**
 * pickReviewers — the orchestrator that composes every scorer into a ranked,
 * deterministic assignment.
 *
 * Pipeline (per the plan):
 *   eligible filter → difficulty band → strategy-specific scoring → top N
 *
 * The scoring strategy is pluggable: "siara" (default, band-routed), "whodo"
 * (expertise/load), "sofia" (expertise + FaR + Gini), "whoreview" (expertise +
 * collaboration + load), "meta" (Siara + anti-bystander randomization).
 *
 * Pure and deterministic: no I/O, no clock (nowIso passed in), ties broken by a
 * seeded dice so identical inputs always yield identical assignments.
 */
import type { ResolvedConfig } from "../config.js";
import type {
  CandidateHistory,
  DifficultyResult,
  JiraData,
  PullRequest,
  ScoredCandidate,
} from "../types.js";
import { scoreDifficulty } from "./difficulty.js";
import { scoreFilesAtRisk } from "./filesAtRisk.js";
import { type StrategyName, runStrategy } from "./strategies.js";

export type { StrategyName } from "./strategies.js";
export { ALL_STRATEGIES } from "./strategies.js";

export interface PickInput {
  pr: PullRequest;
  config: ResolvedConfig;
  /** History for every roster member (already fetched from the store). */
  candidates: CandidateHistory[];
  jira?: JiraData;
  /** ISO "now" for affinity windowing — injected for determinism. */
  nowIso: string;
  /** Scoring strategy to use (default: "siara"). */
  strategy?: StrategyName;
}

export interface PickResult {
  difficulty: DifficultyResult;
  /** Files-at-risk count surfaced for rationale + dashboard. */
  atRiskCount: number;
  /** Full ranked pool, best first. */
  ranked: ScoredCandidate[];
  /** Chosen reviewer logins (top N, or fewer if the pool is smaller). */
  assignees: string[];
  /** Total additive boosts folded into the final sort, per login. */
  finalScoreByLogin: Record<string, number>;
  /** Which strategy produced this result. */
  strategy: StrategyName;
}

/** Eligible = roster ∩ not blocklisted ∩ not author ∩ not already requested. */
function filterEligible(
  candidates: CandidateHistory[],
  pr: PullRequest,
  config: ResolvedConfig,
): CandidateHistory[] {
  const roster = new Set(config.roster);
  const blocked = new Set(config.blocklist);
  const requested = new Set(pr.requestedReviewers);
  return candidates.filter(
    (c) =>
      roster.has(c.login) &&
      !blocked.has(c.login) &&
      c.login !== pr.author &&
      !requested.has(c.login),
  );
}

export function pickReviewers(input: PickInput): PickResult {
  const { pr, config, jira, nowIso } = input;
  const strategy = input.strategy ?? "siara";

  const difficulty = scoreDifficulty(pr.files, config);
  const eligible = filterEligible(input.candidates, pr, config);

  // Files-at-risk count is always computed for rationale/dashboard, even if the
  // strategy doesn't use it directly.
  const filesAtRisk = scoreFilesAtRisk(eligible, pr.files, config);

  const result = runStrategy(strategy, {
    pr,
    config,
    eligible,
    difficulty,
    jira,
    nowIso,
  });

  return {
    difficulty,
    atRiskCount: filesAtRisk.atRiskCount,
    ranked: result.ranked,
    assignees: result.assignees,
    finalScoreByLogin: result.finalScoreByLogin,
    strategy,
  };
}
