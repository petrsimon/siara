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

/**
 * Editable per-reviewer properties (managed via the local admin page). These are
 * the operator-tunable knobs the availability penalty reads: a manual busyness
 * coefficient and a time-boxed "unavailable" flag (PTO / don't-assign).
 */
export interface ReviewerProps {
  /**
   * Manual "heads-down" busyness coefficient (same units as the legacy
   * `reviewerBusy` map). Feeds the availability penalty via sync. Overrides the
   * legacy map entry when both are present.
   */
  busy?: number;
  /**
   * PTO / don't-assign this reviewer. Applied as a STRONG SOFT penalty: they
   * fall to the bottom but stay assignable if they're the sole viable reviewer
   * (capped by `availability.maxPenaltyFraction`, like the manager penalty).
   */
  unavailable?: boolean;
  /**
   * Optional ISO date ("YYYY-MM-DD"). When set, `unavailable` auto-expires the
   * day AFTER this date — resolved live against `nowIso` at assign time, so PTO
   * clears itself without an admin edit.
   */
  until?: string;
  /** Free-text note surfaced in the admin page (e.g. "back Mon", "on-call"). */
  note?: string;
  /** Real name for display in the dashboard (falls back to the login). */
  name?: string;
  /** Contact email, surfaced only in dashboard tooltips (never a hard filter). */
  email?: string;
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
  /**
   * Roster logins who are managers (or otherwise shouldn't carry hard reviews).
   * They get a soft availability penalty on moderate/hard PRs only — never
   * simple — so those route elsewhere when a capable reviewer exists, but a
   * manager who is the *sole* expert is still assignable. Not an exclusion.
   */
  managers: string[];
  /**
   * Manual "how heads-down is this person" weight per login (e.g. deep in a
   * high-priority/hard Jira ticket). Feeds the availability penalty now; the
   * real Jira adapter can add to it later via getReviewerWorkload. Default {}.
   */
  reviewerBusy: Record<string, number>;
  /**
   * Editable per-reviewer properties (busy coefficient + PTO/don't-assign),
   * managed by the local admin page. Authoritative over the legacy
   * `reviewerBusy` map. Keys must be roster logins. Default {}.
   */
  reviewers: Record<string, ReviewerProps>;
  /**
   * Availability penalty tuning. A candidate's score is reduced before the final
   * sort by bandWeight[band] × (loadWeight·openLoad + busyWeight·jiraBusy +
   * managerPenalty). Soft, deterministic, never a hard filter.
   */
  availability: {
    /** Per open review already assigned. */
    loadWeight: number;
    /** Per unit of jira/manual busy weight. */
    busyWeight: number;
    /** Manager penalty on moderate PRs. */
    managerModeratePenalty: number;
    /** Manager penalty on hard PRs. */
    managerHardPenalty: number;
    /**
     * Flat penalty for an `unavailable` (PTO/don't-assign) reviewer. NOT
     * band-scaled — PTO bites on every band. Large by default so the cap
     * saturates and they sink to the bottom, yet stay assignable if sole viable.
     */
    unavailablePenalty: number;
    /** How much availability matters per band (simple ≈ education, ignore busy). */
    bandWeight: { simple: number; moderate: number; hard: number };
    /**
     * Hard-PR WIP limit: max concurrent hard reviews a person may hold before an
     * extra penalty kicks in, so overflow spills to the next-best expert instead
     * of bombarding one (WhoDo/Sofia-style workload balancing). 0 disables it.
     * The penalty stays inside the soft-cap, so it re-orders *among comparable
     * experts* — it never dumps a hard PR onto a zero-knowledge stranger.
     */
    hardWipLimit: number;
    /** Penalty per hard review held over `hardWipLimit` (folded into the soft, capped penalty). */
    hardWipPenalty: number;
    /**
     * Ceiling on the penalty as a fraction of the candidate's primary score, so
     * availability stays SOFT: a strong expert always keeps at least
     * (1 - maxPenaltyFraction) of their score and can never be flipped below a
     * zero-knowledge peer. Prevents the penalty from becoming a de-facto filter.
     */
    maxPenaltyFraction: number;
  };
  staleness: {
    warningDays: number;
    overdueDays: number;
  };
  syncWindowDays: number;
  /**
   * Maps a git author email (or name) to a roster GitHub login, so the local-git
   * commit provider can attribute `git log` authorship — which carries emails,
   * not logins — to the right reviewer. GitHub noreply emails
   * ("ID+login@users.noreply.github.com") are decoded automatically and need no
   * entry. Unmapped authors are ignored (they're off-roster anyway).
   */
  identityMap: Record<string, string>;
  /**
   * A PR touching more than this many files is flagged "giant" during sync and
   * reported (not capped). Giant PRs dominate commit-history API cost — one
   * `gh api commits` call per changed path — so surfacing them lets the operator
   * split the PR or accept the cost knowingly. No silent truncation.
   */
  giantPrFileThreshold: number;
  /**
   * Jira Cloud integration (redhat.atlassian.net). Optional — when absent, the
   * noop Jira adapter is used and reviewer busyness comes only from the manual
   * `reviewerBusy` map. Credentials (email + API token) are NOT stored here;
   * they come from the JIRA_USER / JIRA_ACCESS_TOKEN environment at the CLI.
   */
  jira?: {
    /** Base URL, e.g. "https://redhat.atlassian.net". */
    baseUrl: string;
    /** Custom field id holding story points, e.g. "customfield_10016". */
    storyPointsFieldId?: string;
    /** Custom field id holding the epic link (classic projects). Next-gen uses
     *  the parent link, read automatically. */
    epicFieldId?: string;
    /** Maps a roster GitHub login → Jira accountId, so reviewer workload can be
     *  queried per person. Logins without a mapping contribute no Jira busyness
     *  (they fall back to the manual `reviewerBusy` map). */
    accountMap?: Record<string, string>;
    workload?: {
      /** statusCategory that counts as "heads-down", default "In Progress". */
      statusCategory?: string;
      /** Per-priority-name weight; unlisted priorities contribute their points
       *  (or 1) with weight 1. */
      priorityWeights?: Record<string, number>;
    };
  };
  /**
   * Slack integration. Optional — when absent (or SLACK_TOKEN unset), daily runs
   * skip Slack posts. The bearer token is NOT stored here; it comes from the
   * SLACK_TOKEN environment. Per Red Hat policy, dev/test must target the sandbox
   * workspace, not production.
   */
  slack?: {
    /** Target channel id (e.g. "C0123ABCD") the token can post to. */
    channel: string;
  };
}

/** Per-repo overrides — partial, inherits team defaults. */
export interface SiaraRepoConfig {
  repo: string;
  blocklist?: string[];
  /**
   * Absolute path to a local clone. When set, commit history is read from
   * `git log` here instead of the GitHub commits API — far cheaper (one process
   * vs one API call per changed path). Keep the clone fetched; stale clones miss
   * recent authorship. Reviews/PRs/load still come from GitHub.
   */
  localPath?: string;
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
  managers: [],
  reviewerBusy: {},
  reviewers: {},
  availability: {
    // Load bites harder now: fairness comes from spreading low-risk PRs by load,
    // not just from familiarity. simple/moderate bandWeights raised so the load
    // term actually re-orders simple PRs (the bulk) away from the single most
    // familiar person instead of letting them sweep the repo.
    loadWeight: 0.12,
    busyWeight: 0.15,
    managerModeratePenalty: 0.25,
    managerHardPenalty: 0.6,
    unavailablePenalty: 5,
    bandWeight: { simple: 0.6, moderate: 0.7, hard: 1.0 },
    // Hard PRs still route to expertise; the WIP cap keeps one expert from being
    // bombarded — the 4th+ concurrent hard review overflows to the next expert.
    hardWipLimit: 3,
    hardWipPenalty: 0.5,
    maxPenaltyFraction: 0.9,
  },
  staleness: {
    warningDays: 3,
    overdueDays: 5,
  },
  syncWindowDays: 90,
  identityMap: {},
  giantPrFileThreshold: 40,
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
