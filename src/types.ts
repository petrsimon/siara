/**
 * Core domain types for Siara.
 *
 * These are the contracts every scorer, adapter, and orchestrator implements
 * against. Keep this file free of logic — types and enums only.
 */

// ---------------------------------------------------------------------------
// PR / diff inputs
// ---------------------------------------------------------------------------

/** Per-file diff stat as reported by the GitHub API. */
export interface FileChange {
  /** Repo-relative path, e.g. "src/auth/login.ts". */
  path: string;
  additions: number;
  deletions: number;
}

/** Everything Siara needs to know about a PR to score it. */
export interface PullRequest {
  number: number;
  /** "org/repo-name". */
  repo: string;
  /** GitHub login of the PR author — always excluded from candidates. */
  author: string;
  /** Head branch name, e.g. "feat/auth-login" — used for branch-family affinity. */
  branch: string;
  title: string;
  files: FileChange[];
  /** Logins already requested as reviewers — excluded from candidates. */
  requestedReviewers: string[];
  /** Linked Jira ticket key, e.g. "RHCLOUD-500", if any. */
  jiraKey?: string;
  /** ISO timestamp the PR was posted to the Slack workflow (drives staleness). */
  postedAt?: string;
}

// ---------------------------------------------------------------------------
// Per-candidate history signals (populated from the store / adapters)
// ---------------------------------------------------------------------------

/**
 * A candidate's history relative to a specific PR/repo, already fetched from the
 * store. Scorers are pure functions of this — no network access inside scorers.
 */
export interface CandidateHistory {
  login: string;
  /**
   * Commit counts keyed by changed-file path (and/or parent dir) within the
   * sync window. Empty map = true stranger to these paths.
   */
  commitsByPath: Record<string, number>;
  /** Total prior reviews on this repo within the sync window. */
  repoReviewCount: number;
  /** Prior reviews keyed by changed-file path, if path-level data is available. */
  reviewsByPath?: Record<string, number>;
  /** Current count of open review assignments (load signal). */
  openReviewLoad: number;
  /**
   * Recently-reviewed PRs by this candidate, for follow-up affinity.
   * Only those within the affinity window need be included.
   */
  recentReviews: RecentReview[];
}

export interface RecentReview {
  prNumber: number;
  branch: string;
  jiraEpic?: string;
  /** ISO timestamp of the review. */
  reviewedAt: string;
}

/** A currently-open PR whose reviews should always be rescanned (number + branch). */
export interface OpenPrRef {
  number: number;
  branch: string;
}

/** Inputs for an incremental review-history fetch. */
export interface ReviewHistoryQuery {
  /** Window start (now − syncWindowDays). Reviews older than this are dropped;
   *  on cold start it also bounds the PR walk. */
  windowStartIso: string;
  /** Incremental watermark: only PRs numbered above this are pulled fresh (plus
   *  the always-rescanned open PRs). undefined ⇒ cold start (full window walk). */
  sincePrNumber?: number;
  /** Open PRs to always rescan for new reviews (catches reviews on old-but-active PRs). */
  openPrs: OpenPrRef[];
}

/** Result of a review-history fetch — enough for the store to merge, not replace. */
export interface ReviewHistoryPage {
  /** login → reviews within the window. */
  reviews: Record<string, RecentReview[]>;
  /** PR numbers whose reviews were (re)fetched — the store replaces exactly these. */
  scannedPrNumbers: number[];
  /** Highest PR number seen — the next watermark. */
  maxPrNumber: number;
}

/** Jira signals for a PR — all soft, never gate the band. */
export interface JiraData {
  /** Story points / effort estimate, if present. */
  estimate?: number;
  /** Normalized priority, higher = more urgent. */
  priority?: "low" | "medium" | "high" | "blocker";
  /** Epic key the ticket belongs to, for follow-up affinity. */
  epic?: string;
}

// ---------------------------------------------------------------------------
// Scoring outputs
// ---------------------------------------------------------------------------

export type DifficultyBand = "simple" | "moderate" | "hard";

export interface DifficultyResult {
  /** Continuous 0–1 difficulty score. */
  score: number;
  band: DifficultyBand;
  /** Normalized component terms, retained for rationale. */
  components: {
    normChurn: number;
    normFiles: number;
    normSpread: number;
  };
  /** Raw shape stats for the rationale string. */
  raw: {
    /** Churn after per-file cap AND path-risk multipliers (drives the score). */
    totalChurn: number;
    /** Churn after per-file cap only, ignoring path-risk (size baseline). */
    baseChurn: number;
    filesChanged: number;
    directoriesTouched: number;
  };
  /** Path-risk weighting outcome (empty matches = risk-neutral PR). */
  pathRisk: {
    /** Changed files that matched a risk rule, with the applied multiplier. */
    matched: { path: string; multiplier: number; label?: string }[];
    /** Highest multiplier among matched files (1 when none matched). */
    maxMultiplier: number;
    /** True when the band was raised from its size-only value by a risky path. */
    bandFloored: boolean;
    /** The band computed from size alone, before any risk floor. */
    sizeBand: DifficultyBand;
  };
}

/** A single candidate after full scoring, ready to sort. */
export interface ScoredCandidate {
  login: string;
  /** Band-appropriate primary score (familiarity-inverted for simple, knowledge for hard). */
  primaryScore: number;
  familiarity: number;
  knowledge: number;
  /** Sum of additive soft/affinity/spread boosts applied to primaryScore. */
  boosts: {
    followUp: number;
    filesAtRisk: number;
    softEstimate: number;
    softPriority: number;
  };
  openReviewLoad: number;
  /** Per-candidate rationale fragments accumulated during scoring. */
  notes: string[];
}

export interface Assignment {
  /** ISO date "YYYY-MM-DD". */
  date: string;
  pr: number;
  repo: string;
  /** Chosen reviewer login(s). */
  assignees: string[];
  difficulty: number;
  band: DifficultyBand;
  /** Human-readable rationale (also posted as PR comment). */
  rationale: string;
  /** Ranked candidate list "login:score", best first. */
  candidates: string[];
}
