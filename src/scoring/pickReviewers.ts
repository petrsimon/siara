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
  /** Logins allowed to review this PR (owners ∪ maintainers ∩ roster). undefined/empty ⇒ no gate. */
  eligibleOwners?: string[];
  /** Logins who declined this PR — excluded like the blocklist. */
  declined?: string[];
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
  /** True when the owner/maintainer gate narrowed the eligible pool. */
  ownerGateApplied: boolean;
  /** Extra rationale fragments (owner gate, etc.). */
  notes: string[];
}

/** Eligible = roster ∩ not blocklisted ∩ not author ∩ not already requested. */
export function filterEligible(
  candidates: CandidateHistory[],
  pr: PullRequest,
  config: ResolvedConfig,
  opts: { declined?: string[]; eligibleOwners?: string[] } = {},
): { eligible: CandidateHistory[]; ownerGateApplied: boolean; notes: string[] } {
  const roster = new Set(config.roster);
  const blocked = new Set(config.blocklist);
  const declined = new Set(opts.declined ?? []);
  const requested = new Set(pr.requestedReviewers);
  const filtered = candidates.filter(
    (c) =>
      roster.has(c.login) &&
      !blocked.has(c.login) &&
      !declined.has(c.login) &&
      c.login !== pr.author &&
      !requested.has(c.login),
  );

  const owners = opts.eligibleOwners;
  if (owners === undefined || owners.length === 0) {
    return { eligible: filtered, ownerGateApplied: false, notes: [] };
  }

  const eligibleOwnerSet = new Set(owners);
  const gated = filtered.filter((c) => eligibleOwnerSet.has(c.login));
  if (gated.length === 0) {
    return { eligible: filtered, ownerGateApplied: false, notes: [] };
  }

  return {
    eligible: gated,
    ownerGateApplied: true,
    notes: [
      `owner gate: ${gated.length} of ${filtered.length} candidates are codeowners/maintainers`,
    ],
  };
}

export function pickReviewers(input: PickInput): PickResult {
  const { pr, config, jira, nowIso } = input;
  const strategy = input.strategy ?? "siara";

  const difficulty = scoreDifficulty(pr.files, config);
  const { eligible, ownerGateApplied, notes } = filterEligible(
    input.candidates,
    pr,
    config,
    { declined: input.declined, eligibleOwners: input.eligibleOwners },
  );

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
    ownerGateApplied,
    notes,
  };
}
