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

export interface GitHubAdapter {
  /** Open PRs for a repo that need assignment. */
  listOpenPullRequests(repo: string): Promise<PullRequest[]>;
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
