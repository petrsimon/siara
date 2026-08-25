/**
 * pickReviewers — the orchestrator that composes every scorer into a ranked,
 * deterministic assignment.
 *
 * Pipeline (per the plan):
 *   eligible filter → difficulty band → band-routed primary score
 *   → files-at-risk spread boost → follow-up affinity boost → soft Jira boosts
 *   → sort by (finalScore desc, load asc, seeded dice asc) → top N
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
import { seededDice } from "../util/dice.js";
import { scoreDifficulty } from "./difficulty.js";
import { scoreFamiliarity } from "./familiarity.js";
import { scoreFilesAtRisk } from "./filesAtRisk.js";
import { scoreFollowUp } from "./followUp.js";
import { scoreKnowledge } from "./knowledge.js";
import { applySoftBoosts } from "./softBoosts.js";

export interface PickInput {
  pr: PullRequest;
  config: ResolvedConfig;
  /** History for every roster member (already fetched from the store). */
  candidates: CandidateHistory[];
  jira?: JiraData;
  /** ISO "now" for affinity windowing — injected for determinism. */
  nowIso: string;
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

/**
 * Band-routed primary score in 0–1.
 *   simple   → education: LOWEST familiarity wins → 1 - familiarity
 *   moderate → equal blend of familiarity and knowledge
 *   hard     → expertise: knowledge
 */
function primaryScore(
  band: DifficultyResult["band"],
  familiarity: number,
  knowledge: number,
): number {
  switch (band) {
    case "simple":
      return 1 - familiarity;
    case "moderate":
      return 0.5 * familiarity + 0.5 * knowledge;
    case "hard":
      return knowledge;
  }
}

function sumBoosts(c: ScoredCandidate): number {
  return (
    c.boosts.followUp +
    c.boosts.filesAtRisk +
    c.boosts.softEstimate +
    c.boosts.softPriority
  );
}

export function pickReviewers(input: PickInput): PickResult {
  const { pr, config, jira, nowIso } = input;

  const difficulty = scoreDifficulty(pr.files, config);
  const eligible = filterEligible(input.candidates, pr, config);

  const familiarity = scoreFamiliarity(eligible, pr.files, config);
  const knowledge = scoreKnowledge(eligible, pr.files, config);
  const followUp = scoreFollowUp(eligible, pr, jira, config, nowIso);
  const filesAtRisk = scoreFilesAtRisk(eligible, pr.files, config);

  const scored: ScoredCandidate[] = eligible.map((c) => {
    const fam = familiarity[c.login] ?? 0;
    const know = knowledge[c.login] ?? 0;
    const notes: string[] = [];
    if (difficulty.band === "simple") {
      notes.push(`education path: familiarity ${fam.toFixed(2)} (lower = preferred)`);
    } else if (difficulty.band === "hard") {
      notes.push(`expertise path: knowledge ${know.toFixed(2)}`);
    } else {
      notes.push(`blended path: familiarity ${fam.toFixed(2)} + knowledge ${know.toFixed(2)}`);
    }
    const followUpBoost = followUp[c.login] ?? 0;
    const spreadBoost = filesAtRisk.boosts[c.login] ?? 0;
    if (followUpBoost > 0) notes.push(`follow-up affinity +${followUpBoost.toFixed(2)}`);
    if (spreadBoost > 0) notes.push(`files-at-risk spread +${spreadBoost.toFixed(2)}`);
    return {
      login: c.login,
      primaryScore: primaryScore(difficulty.band, fam, know),
      familiarity: fam,
      knowledge: know,
      boosts: {
        followUp: followUpBoost,
        filesAtRisk: spreadBoost,
        softEstimate: 0,
        softPriority: 0,
      },
      openReviewLoad: c.openReviewLoad,
      notes,
    };
  });

  const boosted = applySoftBoosts(scored, jira, config);

  const finalScoreByLogin: Record<string, number> = {};
  for (const c of boosted) {
    finalScoreByLogin[c.login] = c.primaryScore + sumBoosts(c);
  }

  // Sort: final score desc → open load asc → seeded dice asc (deterministic).
  const ranked = [...boosted].sort((a, b) => {
    const fs = (finalScoreByLogin[b.login] ?? 0) - (finalScoreByLogin[a.login] ?? 0);
    if (Math.abs(fs) > 1e-9) return fs;
    if (a.openReviewLoad !== b.openReviewLoad) {
      return a.openReviewLoad - b.openReviewLoad;
    }
    return (
      seededDice(pr.number, a.login, config.diceSeedSalt) -
      seededDice(pr.number, b.login, config.diceSeedSalt)
    );
  });

  const assignees = selectAssignees(ranked, filesAtRisk.atRiskCount, config);

  return {
    difficulty,
    atRiskCount: filesAtRisk.atRiskCount,
    ranked,
    assignees,
    finalScoreByLogin,
  };
}

/**
 * Pick the top N reviewers. When files are at risk, reviewersPerPr >= 2, and
 * pairWithExpert is on, guarantee the set pairs the highest-knowledge expert
 * with a spread-boosted learner so knowledge actually propagates.
 */
function selectAssignees(
  ranked: ScoredCandidate[],
  atRiskCount: number,
  config: ResolvedConfig,
): string[] {
  const n = Math.min(config.reviewersPerPr, ranked.length);
  if (n === 0) return [];

  const topN = ranked.slice(0, n).map((c) => c.login);

  const shouldPair =
    atRiskCount > 0 && config.filesAtRisk.pairWithExpert && n >= 2;
  if (!shouldPair) return topN;

  // Ensure the highest-knowledge expert is present alongside the top learner.
  const expert = [...ranked].sort((a, b) => b.knowledge - a.knowledge)[0];
  if (expert && !topN.includes(expert.login)) {
    // Replace the weakest of the top-N with the expert to form the pair.
    topN[topN.length - 1] = expert.login;
  }
  return topN;
}
