/**
 * Core domain types for Siara.
 *
 * These are the contracts every scorer, adapter, and orchestrator implements
 * against. Keep this file free of logic — types and enums only.
 */
import type { CodeownersRule } from "./scoring/codeowners.js";

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
  /** ISO timestamp the PR was opened on GitHub — the real PR age, independent of
   *  whether it was ever posted to Slack. Preferred for age/staleness. */
  createdAt?: string;
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
   * Concurrent hard-band reviews this person currently holds, per Siara's own
   * assignment log (open PRs it scored hard). Drives the hard-WIP overflow cap.
   * Optional — absent ⇒ treated as 0. Live GitHub load can't carry Siara's band.
   */
  hardReviewLoad?: number;
  /** Jira/manual "heads-down" weight — how busy this person is on their own work. */
  jiraBusy: number;
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

/** Cached CODEOWNERS + maintain/admin collaborators for reviewer gating. */
export interface RepoMaintainers {
  repo: string;
  /** ISO timestamp when this cache row was fetched. */
  fetchedAt: string;
  /** Owners resolved to logins (teams expanded, "@" stripped). */
  codeownersRules: CodeownersRule[];
  /** Logins with maintain/admin permission on the repo. */
  collaborators: string[];
}

/** A reviewer removed from a PR after Siara assigned them — treated as a decline. */
export interface Decline {
  repo: string;
  pr: number;
  login: string;
  /** ISO timestamp of the removal event. */
  at: string;
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
    /** Availability penalty (manager/busy/load), <= 0, subtracted from score. */
    availability: number;
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

/**
 * A point-in-time record of one open PR, emitted by `daily` into a git-tracked
 * snapshot each run. Powers the dashboard's PR-age overview without needing
 * config or the SQLite store at dashboard time.
 */
export interface OpenPrSnapshot {
  repo: string;
  pr: number;
  title: string;
  author: string;
  /** Reviewers currently requested (or freshly assigned this run). */
  assignees: string[];
  /** Age in days since the PR was posted to the Slack workflow, if known. */
  ageDays?: number;
  /** Difficulty band, when the PR was scored this run. */
  band?: DifficultyBand;
  /** "normal" | "warning" | "overdue" from the staleness thresholds. */
  staleness: "normal" | "warning" | "overdue";
  /** ISO timestamp the PR was posted (drives age), if known. */
  postedAt?: string;
}

/** A full open-PRs snapshot: point-in-time, overwritten each `daily` run. */
export interface OpenPrsSnapshot {
  /** ISO timestamp the snapshot was taken. */
  takenAt: string;
  prs: OpenPrSnapshot[];
}

/**
 * One reviewer's response to one assignment: how long they took from being
 * assigned to leaving their first review on that PR. Computed by `daily` (which
 * has the SQLite review-event data) and written to a git-tracked artifact so the
 * store-free dashboard can render responsiveness without loading the addon.
 */
export interface ReviewResponse {
  repo: string;
  pr: number;
  reviewer: string;
  /** PR author login, when known (from open PRs or merged-PR sync). */
  author?: string;
  /** ISO timestamp GitHub requested this reviewer (`review_requested`).
   *  Completed reviews may fall back to the Siara assignment-log date. */
  assignedAt: string;
  /** ISO timestamp of their first review on/after assignedAt, if any. */
  firstReviewAt?: string;
  /** Whole hours from assignedAt to firstReviewAt (present iff reviewed). */
  latencyHours?: number;
  /** True when the PR is still open and this reviewer has not yet reviewed. */
  outstanding: boolean;
  /** Whole hours from assignedAt to now (present iff outstanding). */
  waitingHours?: number;
  /** ISO timestamp the PR merged, for reviewers requested on a since-merged PR. */
  mergedAt?: string;
  /** Whole hours from assignedAt to mergedAt (present iff the PR has merged). */
  mergeHours?: number;
}

/** Provisional time from PR creation to its first reviewer request. */
export interface OpenedToAssignment {
  repo: string;
  pr: number;
  /** ISO timestamp the PR was opened. */
  openedAt: string;
  /** First direct reviewer request at or after openedAt, when assigned. */
  assignedAt?: string;
  /** Login requested first, when assigned. */
  reviewer?: string;
  /** Whole hours from readyAt to assignedAt, when assigned. */
  latencyHours?: number;
  /** True when no qualifying reviewer request exists yet. */
  outstanding: boolean;
  /** Whole hours from readyAt to the report timestamp, when outstanding. */
  waitingHours?: number;
}

/** Review-latency report: point-in-time, overwritten each `daily` run. */
export interface ResponseTimeReport {
  /** ISO timestamp the report was computed. */
  takenAt: string;
  responses: ReviewResponse[];
  /** Provisional PR-opened → first direct reviewer request observations. */
  openedToAssignment?: OpenedToAssignment[];
}

/**
 * A manual reviewer change observed after Siara's auto-assignment: the PR's
 * live requested reviewers no longer match what Siara suggested. Logged (never
 * reverted) so the dashboard can report suggestion-acceptance over time.
 */
export interface Override {
  /** ISO timestamp when the divergence was first observed. */
  seenAt: string;
  repo: string;
  pr: number;
  /** Reviewers Siara originally suggested (sorted). */
  suggested: string[];
  /** Reviewers actually requested on the PR now (sorted). */
  actual: string[];
}
