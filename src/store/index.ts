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
  PullRequest,
  RecentReview,
} from "../types.js";

export interface SiaraStore extends HistoryStore {
  /** Create tables / indexes if absent. Idempotent. */
  init(): Promise<void>;

  // --- cache writes (populated by sync) --------------------------------------
  /** commits[login][path] = count, within the sync window. */
  upsertCommitHistory(
    repo: string,
    commits: Record<string, Record<string, number>>,
  ): Promise<void>;
  /** reviews[login] = recent reviews, within the sync window. */
  upsertReviewHistory(
    repo: string,
    reviews: Record<string, RecentReview[]>,
  ): Promise<void>;
  /** Current open review load per login. */
  upsertOpenLoad(loads: Record<string, number>): Promise<void>;
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

  close(): Promise<void>;
}

/** Options for opening a store. */
export interface StoreOptions {
  /** Path to the SQLite file. Use ":memory:" for tests. */
  dbPath: string;
  /** Path to the append-only assignment log. */
  assignmentsPath: string;
}
