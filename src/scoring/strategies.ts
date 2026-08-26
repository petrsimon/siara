/**
 * Pluggable reviewer-selection strategies. Each strategy scores and ranks
 * candidates differently; the caller picks one by name.
 *
 * Every strategy receives the same pre-filtered eligible candidates, the same
 * difficulty result, and the same config — they differ only in HOW they compute
 * and combine scores. The result is a ranked ScoredCandidate[] ready for
 * top-N selection.
 *
 * Strategies:
 *   siara     — band-routed (current default): simple→education, hard→expertise
 *   whodo     — expertise / (1 + α·load)  (Asthana et al., FSE 2019)
 *   sofia     — expertise + files-at-risk spread + Gini-aware load (Mirsaeedi & Rigby, ICSE 2020)
 *   whoreview — expertise + collaboration affinity + load (Ouni et al., 2021)
 *   meta      — current scoring + random-from-top-K anti-bystander (Meta RevRecV2, FSE 2024)
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
import { availabilityPenalty, isReviewerUnavailable } from "./availability.js";
import { scoreFamiliarity } from "./familiarity.js";
import { scoreFilesAtRisk } from "./filesAtRisk.js";
import { scoreFollowUp } from "./followUp.js";
import { scoreKnowledge } from "./knowledge.js";
import { applySoftBoosts } from "./softBoosts.js";

export type StrategyName = "siara" | "whodo" | "sofia" | "whoreview" | "meta";

export const ALL_STRATEGIES: StrategyName[] = [
  "siara",
  "whodo",
  "sofia",
  "whoreview",
  "meta",
];

export interface StrategyInput {
  pr: PullRequest;
  config: ResolvedConfig;
  eligible: CandidateHistory[];
  difficulty: DifficultyResult;
  jira?: JiraData;
  nowIso: string;
}

export interface StrategyResult {
  ranked: ScoredCandidate[];
  assignees: string[];
  finalScoreByLogin: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sumBoosts(c: ScoredCandidate): number {
  return (
    c.boosts.followUp +
    c.boosts.filesAtRisk +
    c.boosts.softEstimate +
    c.boosts.softPriority +
    c.boosts.availability
  );
}

function emptyBoosts(): ScoredCandidate["boosts"] {
  return {
    followUp: 0,
    filesAtRisk: 0,
    softEstimate: 0,
    softPriority: 0,
    availability: 0,
  };
}

function sortByFinalScore(
  candidates: ScoredCandidate[],
  finalScoreByLogin: Record<string, number>,
  pr: PullRequest,
  config: ResolvedConfig,
): ScoredCandidate[] {
  return [...candidates].sort((a, b) => {
    const fs =
      (finalScoreByLogin[b.login] ?? 0) - (finalScoreByLogin[a.login] ?? 0);
    if (Math.abs(fs) > 1e-9) return fs;
    if (a.openReviewLoad !== b.openReviewLoad) {
      return a.openReviewLoad - b.openReviewLoad;
    }
    return (
      seededDice(pr.number, a.login, config.diceSeedSalt) -
      seededDice(pr.number, b.login, config.diceSeedSalt)
    );
  });
}

function topNAssignees(
  ranked: ScoredCandidate[],
  config: ResolvedConfig,
): string[] {
  const n = Math.min(config.reviewersPerPr, ranked.length);
  return ranked.slice(0, n).map((c) => c.login);
}

function buildFinalScores(
  candidates: ScoredCandidate[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const c of candidates) {
    result[c.login] = c.primaryScore + sumBoosts(c);
  }
  return result;
}

function computeAvailabilityPenalty(
  c: CandidateHistory,
  primary: number,
  difficulty: DifficultyResult,
  config: ResolvedConfig,
  nowIso: string,
): { penalty: number; notes: string[] } {
  const notes: string[] = [];
  const unavailable = isReviewerUnavailable(config.reviewers[c.login], nowIso);
  const softRaw = availabilityPenalty({
    login: c.login,
    band: difficulty.band,
    openReviewLoad: c.openReviewLoad,
    jiraBusy: c.jiraBusy,
    hardReviewLoad: c.hardReviewLoad,
    team: config,
  });
  const cappedSoft = Math.min(
    softRaw,
    primary * config.availability.maxPenaltyFraction,
  );
  const penalty =
    cappedSoft + (unavailable ? config.availability.unavailablePenalty : 0);

  if (penalty > 1e-9) {
    const parts: string[] = [];
    if (unavailable) parts.push("PTO/unavailable");
    if (config.managers.includes(c.login) && difficulty.band !== "simple") {
      parts.push("manager");
    }
    if (c.jiraBusy > 0) parts.push("busy");
    if (
      difficulty.band === "hard" &&
      config.availability.hardWipLimit > 0 &&
      (c.hardReviewLoad ?? 0) >= config.availability.hardWipLimit
    ) {
      parts.push("hard-WIP");
    }
    if (c.openReviewLoad > 0) parts.push("load");
    notes.push(
      `availability −${penalty.toFixed(2)} (${parts.join("+") || "load"})`,
    );
  }
  return { penalty, notes };
}

// ---------------------------------------------------------------------------
// Strategy: siara (current default — band-routed)
// ---------------------------------------------------------------------------

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

function siaraSelectAssignees(
  ranked: ScoredCandidate[],
  atRiskCount: number,
  band: DifficultyResult["band"],
  config: ResolvedConfig,
): string[] {
  const n = Math.min(config.reviewersPerPr, ranked.length);
  if (n === 0) return [];

  const topN = ranked.slice(0, n).map((c) => c.login);

  const shouldPair =
    config.filesAtRisk.pairWithExpert &&
    n >= 2 &&
    (band !== "simple" || atRiskCount > 0);
  if (!shouldPair) return topN;

  const expert = [...ranked].sort((a, b) => b.knowledge - a.knowledge)[0];
  const managers = new Set(config.managers);
  const learner =
    [...ranked]
      .filter((c) => c.login !== expert?.login && !managers.has(c.login))
      .sort((a, b) => a.familiarity - b.familiarity)[0] ??
    ranked.find((c) => c.login !== expert?.login);

  const pair: string[] = [];
  if (expert) pair.push(expert.login);
  if (learner && !pair.includes(learner.login)) pair.push(learner.login);
  for (const c of ranked) {
    if (pair.length >= n) break;
    if (!pair.includes(c.login)) pair.push(c.login);
  }
  return pair.slice(0, n);
}

function strategySiara(input: StrategyInput): StrategyResult {
  const { pr, config, eligible, difficulty, jira, nowIso } = input;

  const familiarity = scoreFamiliarity(eligible, pr.files, config);
  const knowledge = scoreKnowledge(eligible, pr.files, config);
  const followUp = scoreFollowUp(eligible, pr, jira, config, nowIso);
  const filesAtRisk = scoreFilesAtRisk(eligible, pr.files, config);

  const scored: ScoredCandidate[] = eligible.map((c) => {
    const fam = familiarity[c.login] ?? 0;
    const know = knowledge[c.login] ?? 0;
    const notes: string[] = [];
    if (difficulty.band === "simple") {
      notes.push(
        `education path: familiarity ${fam.toFixed(2)} (lower = preferred)`,
      );
    } else if (difficulty.band === "hard") {
      notes.push(`expertise path: knowledge ${know.toFixed(2)}`);
    } else {
      notes.push(
        `blended path: familiarity ${fam.toFixed(2)} + knowledge ${know.toFixed(2)}`,
      );
    }
    const followUpBoost = followUp[c.login] ?? 0;
    const spreadBoost = filesAtRisk.boosts[c.login] ?? 0;
    if (followUpBoost > 0)
      notes.push(`follow-up affinity +${followUpBoost.toFixed(2)}`);
    if (spreadBoost > 0)
      notes.push(`files-at-risk spread +${spreadBoost.toFixed(2)}`);

    const primary = primaryScore(difficulty.band, fam, know);
    const avail = computeAvailabilityPenalty(
      c,
      primary,
      difficulty,
      config,
      nowIso,
    );
    notes.push(...avail.notes);

    return {
      login: c.login,
      primaryScore: primary,
      familiarity: fam,
      knowledge: know,
      boosts: {
        followUp: followUpBoost,
        filesAtRisk: spreadBoost,
        softEstimate: 0,
        softPriority: 0,
        availability: avail.penalty > 0 ? -avail.penalty : 0,
      },
      openReviewLoad: c.openReviewLoad,
      notes,
    };
  });

  const boosted = applySoftBoosts(scored, jira, config);
  const finalScoreByLogin = buildFinalScores(boosted);
  const ranked = sortByFinalScore(boosted, finalScoreByLogin, pr, config);
  const assignees = siaraSelectAssignees(
    ranked,
    filesAtRisk.atRiskCount,
    difficulty.band,
    config,
  );

  return { ranked, assignees, finalScoreByLogin };
}

// ---------------------------------------------------------------------------
// Strategy: whodo (expertise / (1 + α·load))  — Asthana et al., FSE 2019
// ---------------------------------------------------------------------------

const WHODO_LOAD_ALPHA = 0.3;

function strategyWhoDo(input: StrategyInput): StrategyResult {
  const { pr, config, eligible } = input;

  const knowledge = scoreKnowledge(eligible, pr.files, config);
  const familiarity = scoreFamiliarity(eligible, pr.files, config);

  const scored: ScoredCandidate[] = eligible.map((c) => {
    const know = knowledge[c.login] ?? 0;
    const fam = familiarity[c.login] ?? 0;
    const primary = know / (1 + WHODO_LOAD_ALPHA * c.openReviewLoad);
    const notes = [
      `whodo: knowledge ${know.toFixed(2)} / (1 + ${WHODO_LOAD_ALPHA}×${c.openReviewLoad} load) = ${primary.toFixed(2)}`,
    ];
    return {
      login: c.login,
      primaryScore: primary,
      familiarity: fam,
      knowledge: know,
      boosts: emptyBoosts(),
      openReviewLoad: c.openReviewLoad,
      notes,
    };
  });

  const finalScoreByLogin = buildFinalScores(scored);
  const ranked = sortByFinalScore(scored, finalScoreByLogin, pr, config);
  const assignees = topNAssignees(ranked, config);

  return { ranked, assignees, finalScoreByLogin };
}

// ---------------------------------------------------------------------------
// Strategy: sofia (expertise + FaR spread + Gini-aware)
// — Mirsaeedi & Rigby, ICSE 2020
// ---------------------------------------------------------------------------

const SOFIA_EXPERTISE_W = 0.5;
const SOFIA_SPREAD_W = 0.3;
const SOFIA_LOAD_W = 0.2;

function strategySofia(input: StrategyInput): StrategyResult {
  const { pr, config, eligible } = input;

  const knowledge = scoreKnowledge(eligible, pr.files, config);
  const familiarity = scoreFamiliarity(eligible, pr.files, config);
  const filesAtRisk = scoreFilesAtRisk(eligible, pr.files, config);

  // Normalize load to 0–1 within the pool for fair weighting.
  const maxLoad = Math.max(1, ...eligible.map((c) => c.openReviewLoad));

  const scored: ScoredCandidate[] = eligible.map((c) => {
    const know = knowledge[c.login] ?? 0;
    const fam = familiarity[c.login] ?? 0;
    const spread = filesAtRisk.boosts[c.login] ?? 0;
    const normSpread = spread > 0 ? 1 : 0;
    const normLoad = c.openReviewLoad / maxLoad;

    const primary =
      SOFIA_EXPERTISE_W * know +
      SOFIA_SPREAD_W * normSpread -
      SOFIA_LOAD_W * normLoad;

    const notes = [
      `sofia: ${SOFIA_EXPERTISE_W}×expertise(${know.toFixed(2)}) + ${SOFIA_SPREAD_W}×spread(${normSpread}) − ${SOFIA_LOAD_W}×load(${normLoad.toFixed(2)}) = ${primary.toFixed(2)}`,
    ];
    if (filesAtRisk.atRiskCount > 0) {
      notes.push(
        `${filesAtRisk.atRiskCount} files at risk — ${normSpread ? "non-owner (spread boost)" : "owner (no boost)"}`,
      );
    }

    return {
      login: c.login,
      primaryScore: primary,
      familiarity: fam,
      knowledge: know,
      boosts: emptyBoosts(),
      openReviewLoad: c.openReviewLoad,
      notes,
    };
  });

  const finalScoreByLogin = buildFinalScores(scored);
  const ranked = sortByFinalScore(scored, finalScoreByLogin, pr, config);
  const assignees = topNAssignees(ranked, config);

  return { ranked, assignees, finalScoreByLogin };
}

// ---------------------------------------------------------------------------
// Strategy: whoreview (expertise + collaboration + load)
// — Ouni et al., 2021
// ---------------------------------------------------------------------------

const WHOREVIEW_EXPERTISE_W = 0.4;
const WHOREVIEW_COLLAB_W = 0.35;
const WHOREVIEW_LOAD_W = 0.25;

function strategyWhoReview(input: StrategyInput): StrategyResult {
  const { pr, config, eligible, jira, nowIso } = input;

  const knowledge = scoreKnowledge(eligible, pr.files, config);
  const familiarity = scoreFamiliarity(eligible, pr.files, config);
  const followUp = scoreFollowUp(eligible, pr, jira, config, nowIso);

  // Collaboration signal: how many recent reviews did this candidate do on PRs
  // by the same author? We approximate via follow-up affinity (same branch
  // family / epic = likely same author's work stream).
  const maxFollowUp = Math.max(
    1e-9,
    ...Object.values(followUp).map((v) => Math.abs(v)),
  );
  const maxLoad = Math.max(1, ...eligible.map((c) => c.openReviewLoad));

  const scored: ScoredCandidate[] = eligible.map((c) => {
    const know = knowledge[c.login] ?? 0;
    const fam = familiarity[c.login] ?? 0;
    const collab = (followUp[c.login] ?? 0) / maxFollowUp;
    const normLoad = c.openReviewLoad / maxLoad;

    const primary =
      WHOREVIEW_EXPERTISE_W * know +
      WHOREVIEW_COLLAB_W * collab -
      WHOREVIEW_LOAD_W * normLoad;

    const notes = [
      `whoreview: ${WHOREVIEW_EXPERTISE_W}×expertise(${know.toFixed(2)}) + ${WHOREVIEW_COLLAB_W}×collab(${collab.toFixed(2)}) − ${WHOREVIEW_LOAD_W}×load(${normLoad.toFixed(2)}) = ${primary.toFixed(2)}`,
    ];

    return {
      login: c.login,
      primaryScore: primary,
      familiarity: fam,
      knowledge: know,
      boosts: emptyBoosts(),
      openReviewLoad: c.openReviewLoad,
      notes,
    };
  });

  const finalScoreByLogin = buildFinalScores(scored);
  const ranked = sortByFinalScore(scored, finalScoreByLogin, pr, config);
  const assignees = topNAssignees(ranked, config);

  return { ranked, assignees, finalScoreByLogin };
}

// ---------------------------------------------------------------------------
// Strategy: meta (current Siara scoring + random-from-top-K anti-bystander)
// — inspired by Meta RevRecV2, FSE 2024
// ---------------------------------------------------------------------------

const META_TOP_K = 3;

function strategyMeta(input: StrategyInput): StrategyResult {
  // Run the full Siara scoring pipeline…
  const siara = strategySiara(input);

  // …then instead of deterministic top-1, pick randomly from the top-K using
  // the seeded dice so it's still reproducible.
  const { pr, config } = input;
  const n = Math.min(config.reviewersPerPr, siara.ranked.length);
  if (n === 0) return siara;

  const poolSize = Math.min(META_TOP_K, siara.ranked.length);
  const pool = siara.ranked.slice(0, poolSize);

  // Rank pool members by their dice roll and pick the top-n.
  const shuffled = [...pool].sort(
    (a, b) =>
      seededDice(pr.number, a.login, config.diceSeedSalt) -
      seededDice(pr.number, b.login, config.diceSeedSalt),
  );
  const assignees = shuffled.slice(0, n).map((c) => c.login);

  // Annotate the ranked list so the rationale shows what happened.
  const chosen = new Set(assignees);
  const ranked = siara.ranked.map((c) => {
    if (chosen.has(c.login) && pool.some((p) => p.login === c.login)) {
      return {
        ...c,
        notes: [
          ...c.notes,
          `meta: selected from top-${poolSize} by anti-bystander dice`,
        ],
      };
    }
    return c;
  });

  return { ranked, assignees, finalScoreByLogin: siara.finalScoreByLogin };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const STRATEGIES: Record<StrategyName, (input: StrategyInput) => StrategyResult> = {
  siara: strategySiara,
  whodo: strategyWhoDo,
  sofia: strategySofia,
  whoreview: strategyWhoReview,
  meta: strategyMeta,
};

export function runStrategy(
  name: StrategyName,
  input: StrategyInput,
): StrategyResult {
  return STRATEGIES[name](input);
}
