/**
 * Adapter interfaces. Concrete implementations (github/jira/slack) and
 * fixture mocks live alongside. Scorers never call these directly — sync
 * populates the store, scorers read the store.
 */
import type {
  CandidateHistory,
  JiraData,
  PullRequest,
  ReviewHistoryPage,
  ReviewHistoryQuery,
} from "../types.js";

/** One GitHub timeline event that requested or un-requested a user reviewer. */
export interface ReviewRequestEvent {
  pr: number;
  login: string;
  /** ISO timestamp of the event. */
  at: string;
  kind: "requested" | "removed";
}

/** A PR that merged within the lookback window — powers time-to-merge stats. */
export interface MergedPullRequest {
  number: number;
  author: string;
  /** ISO timestamp the PR was merged. */
  mergedAt: string;
}

export interface GitHubAdapter {
  /** Open PRs for a repo that need assignment. */
  listOpenPullRequests(repo: string): Promise<PullRequest[]>;
  /** PRs merged on/after `sinceIso` — for reviewer time-to-merge stats. */
  listRecentlyMergedPullRequests(
    repo: string,
    sinceIso: string,
  ): Promise<MergedPullRequest[]>;
  /** Timeline of user review-request / request-removed events for the given PRs. */
  getReviewRequestEvents(
    repo: string,
    prNumbers: number[],
  ): Promise<ReviewRequestEvent[]>;
  /** Per-file diff stats for a PR. */
  getPullRequestFiles(repo: string, prNumber: number): Promise<PullRequest["files"]>;
  /** Commit counts on given paths per author within the sync window. */
  getCommitHistory(
    repo: string,
    paths: string[],
    sinceIso: string,
  ): Promise<Record<string, Record<string, number>>>;
  /** Review history: incremental fetch bounded by watermark + window.
   *  Returns a mergeable page (not a full replacement). */
  getReviewHistory(
    repo: string,
    query: ReviewHistoryQuery,
  ): Promise<ReviewHistoryPage>;
  /** Open review load per login across tracked repos. */
  getOpenReviewLoad(logins: string[]): Promise<Record<string, number>>;
  /** Post the rationale as a PR comment. */
  postComment(repo: string, prNumber: number, body: string): Promise<void>;
  /** Request review on GitHub. */
  requestReviewers(
    repo: string,
    prNumber: number,
    logins: string[],
  ): Promise<void>;
}

export interface JiraAdapter {
  /** Estimate / priority / epic for a ticket key. */
  getIssueData(key: string): Promise<JiraData>;
  /**
   * Per-reviewer "heads-down" workload weight — how busy each login is on their
   * own high-priority/hard tickets, reducing review capacity. Returns a weight
   * per login (0 = free). Stub returns {} until real Jira is wired; the manual
   * `reviewerBusy` config is merged on top by sync.
   */
  getReviewerWorkload(logins: string[]): Promise<Record<string, number>>;
}

export interface SlackAdapter {
  /** Post assignment + rationale to the daily workflow thread. */
  postAssignment(threadTs: string | undefined, text: string): Promise<string>;
  /** Repost a pending PR with age + assignee + staleness marker. */
  repostPending(threadTs: string | undefined, text: string): Promise<string>;
}

/** Read side used by scorers — backed by the store, not the network. */
export interface HistoryStore {
  getCandidateHistory(
    repo: string,
    pr: PullRequest,
    logins: string[],
  ): Promise<CandidateHistory[]>;
}
