/**
 * Configuration types + defaults for Siara.
 *
 * Team-level defaults with per-repo overrides. All tunable weights live here so
 * they can change without touching scorer code.
 */
import type { DifficultyBand } from "./types.js";

/**
 * One path-risk rule: files whose path matches `pattern` (glob, see matchGlob)
 * have their per-file churn multiplied by `multiplier` before aggregation, so a
 * tiny change to high-risk code (auth/crypto/migrations) scores harder than its
 * size alone. First matching rule in the list wins per file.
 */
export interface PathRiskRule {
  /** Glob against the repo-relative path, e.g. "** /auth/**", "*.sql". */
  pattern: string;
  /** Churn multiplier applied to matching files (>= 1). */
  multiplier: number;
  /** Short label surfaced in the rationale, e.g. "auth", "migration". */
  label?: string;
}

export interface SiaraTeamConfig {
  /** GitHub logins on the team. */
  roster: string[];
  /** Reviewers to request per PR. */
  reviewersPerPr: number;
  /** Salt mixed into the seeded dice for tie-breaks. */
  diceSeedSalt?: string;
  difficulty: {
    weights: { churn: number; files: number; spread: number };
    /** Band boundaries: [0, simple) simple, [simple, hard) moderate, [hard, 1] hard. */
    bands: { simple: number; hard: number };
  };
  /** Ceilings used to normalize each difficulty term to 0–1. */
  difficultyCeilings: {
    /** Per-file churn cap, then total churn ceiling. */
    perFileChurnCap: number;
    churn: number;
    files: number;
    spread: number;
  };
  familiarity: {
    /** α — weight on commit signal. */
    commitWeight: number;
    /** β — weight on review signal. */
    reviewWeight: number;
  };
  followUpAffinity: {
    branchFamilyBoost: number;
    epicBoost: number;
    windowDays: number;
  };
  filesAtRisk: {
    /** Additive boost to a non-owner when a changed file is bus-factor-1. */
    spreadBoost: number;
    /** If reviewersPerPr >= 2, pair a learner with an expert. */
    pairWithExpert: boolean;
  };
  /**
   * Path-risk weighting: makes "difficulty" account for risk, not just size, so
   * the education path never routes a small-but-dangerous diff to a stranger.
   */
  pathRisk: {
    /** Per-file churn multipliers by path glob (first match wins). */
    rules: PathRiskRule[];
    /**
     * If any changed file matches a rule with multiplier >= this, the PR's band
     * is floored at `bandFloor` (a "simple"-by-size auth diff becomes moderate,
     * so knowledge — not just low familiarity — drives routing).
     */
    bandFloorMultiplier: number;
    /** Minimum band when a high-risk path is touched. */
    bandFloor: DifficultyBand;
  };
  soft: {
    estimateExpertBoost: number;
    priorityExpertBoost: number;
    highPriorityLoadPenalty: number;
  };
  staleness: {
    warningDays: number;
    overdueDays: number;
  };
  syncWindowDays: number;
}

/** Per-repo overrides — partial, inherits team defaults. */
export interface SiaraRepoConfig {
  repo: string;
  blocklist?: string[];
  reviewersPerPr?: number;
  difficulty?: Partial<SiaraTeamConfig["difficulty"]>;
  filesAtRisk?: Partial<SiaraTeamConfig["filesAtRisk"]>;
  pathRisk?: Partial<SiaraTeamConfig["pathRisk"]>;
  soft?: Partial<SiaraTeamConfig["soft"]>;
}

/** Fully-resolved config for one repo (team defaults merged with repo overrides). */
export interface ResolvedConfig extends SiaraTeamConfig {
  repo: string;
  blocklist: string[];
}

export const DEFAULT_TEAM_CONFIG: Omit<SiaraTeamConfig, "roster"> = {
  reviewersPerPr: 1,
  difficulty: {
    weights: { churn: 0.5, files: 0.25, spread: 0.25 },
    bands: { simple: 0.3, hard: 0.6 },
  },
  difficultyCeilings: {
    perFileChurnCap: 200,
    churn: 300,
    files: 15,
    spread: 6,
  },
  familiarity: {
    commitWeight: 0.6,
    reviewWeight: 0.4,
  },
  followUpAffinity: {
    branchFamilyBoost: 0.2,
    epicBoost: 0.2,
    windowDays: 14,
  },
  filesAtRisk: {
    spreadBoost: 0.15,
    pairWithExpert: true,
  },
  pathRisk: {
    // Security/data-sensitive paths weigh heavier than their diff size implies.
    rules: [
      { pattern: "**/auth/**", multiplier: 2.5, label: "auth" },
      { pattern: "**/*auth*", multiplier: 2, label: "auth" },
      { pattern: "**/*crypto*/**", multiplier: 2.5, label: "crypto" },
      { pattern: "**/*crypto*", multiplier: 2.5, label: "crypto" },
      { pattern: "**/security/**", multiplier: 2.5, label: "security" },
      { pattern: "**/migrations/**", multiplier: 2, label: "migration" },
      { pattern: "**/*.sql", multiplier: 2, label: "sql/schema" },
      { pattern: "**/*secret*", multiplier: 3, label: "secrets" },
      { pattern: "**/.env*", multiplier: 3, label: "env/secrets" },
      { pattern: "**/*.env*", multiplier: 3, label: "env/secrets" },
      { pattern: "**/*.tf", multiplier: 2, label: "infra" },
      { pattern: "**/Dockerfile*", multiplier: 1.5, label: "container" },
      { pattern: "**/*.pem", multiplier: 3, label: "keys/certs" },
    ],
    bandFloorMultiplier: 2,
    bandFloor: "moderate",
  },
  soft: {
    estimateExpertBoost: 0.1,
    priorityExpertBoost: 0.1,
    highPriorityLoadPenalty: 0.1,
  },
  staleness: {
    warningDays: 3,
    overdueDays: 5,
  },
  syncWindowDays: 90,
};

/**
 * Merge team defaults with per-repo overrides into a fully-resolved config.
 * Shallow-merges nested objects one level deep (sufficient for the override shape).
 */
export function resolveConfig(
  team: SiaraTeamConfig,
  repo?: SiaraRepoConfig,
): ResolvedConfig {
  if (!repo) {
    return { ...team, repo: "", blocklist: [] };
  }
  return {
    ...team,
    reviewersPerPr: repo.reviewersPerPr ?? team.reviewersPerPr,
    difficulty: { ...team.difficulty, ...repo.difficulty },
    filesAtRisk: { ...team.filesAtRisk, ...repo.filesAtRisk },
    pathRisk: { ...team.pathRisk, ...repo.pathRisk },
    soft: { ...team.soft, ...repo.soft },
    repo: repo.repo,
    blocklist: repo.blocklist ?? [],
  };
}
