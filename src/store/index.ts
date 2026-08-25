/**
 * Store contract. Hybrid persistence per the plan:
 *   - SQLite (siara.db, gitignored) — cached GitHub/Jira signals + computed load.
 *     Rebuilt from APIs on cold start, incrementally updated daily.
 *   - JSONL (data/assignments.jsonl, git-tracked) — append-only assignment log.
 *
 * Scorers never touch this directly; sync populates it, the orchestrator reads
 * CandidateHistory out of it via the HistoryStore interface.
 *
 * Implementation lives in ./sqliteStore.ts. This file is the LOCKED contract.
 */
import type { HistoryStore } from "../adapters/index.js";
import type {
  Assignment,
  CandidateHistory,
  JiraData,
  OpenPrsSnapshot,
  Override,
  PullRequest,
  ResponseTimeReport,
  ReviewHistoryPage,
} from "../types.js";

/** One ingested review event: who reviewed which PR, and when. */
export interface ReviewEvent {
  pr: number;
  login: string;
  reviewedAt: string;
}

export interface SiaraStore extends HistoryStore {
  /** Create tables / indexes if absent. Idempotent. */
  init(): Promise<void>;

  // --- cache writes (populated by sync) --------------------------------------
  /** commits[login][path] = count, within the sync window. */
  upsertCommitHistory(
    repo: string,
    commits: Record<string, Record<string, number>>,
  ): Promise<void>;
  /** Merge a review-history page: replace rows for exactly the scanned PRs,
   *  prune reviews older than the window, and advance the PR watermark.
   *  Never a wholesale replace — old PRs' reviews survive between syncs. */
  mergeReviewHistory(
    repo: string,
    page: ReviewHistoryPage,
    windowStartIso: string,
  ): Promise<void>;
  /** Highest PR number whose reviews are already ingested, or undefined (cold). */
  getReviewWatermark(repo: string): Promise<number | undefined>;
  /** Current open review load per login. */
  upsertOpenLoad(loads: Record<string, number>): Promise<void>;
  /** Per-login "heads-down" busy weight (jira/manual) — reduces review capacity. */
  upsertBusyLoad(busy: Record<string, number>): Promise<void>;
  /** Cache Jira signals for a ticket. */
  upsertJira(key: string, data: JiraData): Promise<void>;
  getJira(key: string): Promise<JiraData | undefined>;

  // --- sync bookkeeping ------------------------------------------------------
  getLastSyncAt(repo: string): Promise<string | undefined>;
  setLastSyncAt(repo: string, iso: string): Promise<void>;

  // --- read side (also satisfies HistoryStore.getCandidateHistory) -----------
  getCandidateHistory(
    repo: string,
    pr: PullRequest,
    logins: string[],
  ): Promise<CandidateHistory[]>;

  // --- assignment log (JSONL) ------------------------------------------------
  appendAssignment(a: Assignment): Promise<void>;
  readAssignments(): Promise<Assignment[]>;

  // --- override log (JSONL) --------------------------------------------------
  /** Record a manual reviewer change observed after auto-assignment. */
  appendOverride(o: Override): Promise<void>;
  readOverrides(): Promise<Override[]>;

  // --- open-PRs snapshot (JSON, git-tracked, overwritten each run) ------------
  /** Overwrite the point-in-time open-PRs snapshot. */
  writeOpenPrsSnapshot(snapshot: OpenPrsSnapshot): Promise<void>;
  readOpenPrsSnapshot(): Promise<OpenPrsSnapshot | undefined>;

  // --- review events (read side, for latency computation) --------------------
  /** All ingested review events for the given PRs in a repo (pr, login, when). */
  getReviewEvents(repo: string, prNumbers: number[]): Promise<ReviewEvent[]>;

  // --- review-latency report (JSON, git-tracked, overwritten each run) --------
  /** Overwrite the point-in-time review-latency report. */
  writeResponseReport(report: ResponseTimeReport): Promise<void>;
  readResponseReport(): Promise<ResponseTimeReport | undefined>;

  close(): Promise<void>;
}

/** Options for opening a store. */
export interface StoreOptions {
  /** Path to the SQLite file. Use ":memory:" for tests. */
  dbPath: string;
  /** Path to the append-only assignment log. */
  assignmentsPath: string;
  /** Path to the append-only override log. Defaults to overrides.jsonl beside
   *  the assignments log. */
  overridesPath?: string;
}
