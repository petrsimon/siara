import type {
  GitHubAdapter,
  MergedPullRequest,
  ReviewRequestEvent,
} from "../index.js";
import type {
  PullRequest,
  RecentReview,
  ReviewHistoryPage,
  ReviewHistoryQuery,
} from "../../types.js";

export interface GitHubMockFixture {
  /** Open PRs keyed by repo. */
  openPullRequests?: Record<string, PullRequest[]>;
  /** Per-PR file lists keyed by `${repo}#${prNumber}`. */
  filesByPr?: Record<string, PullRequest["files"]>;
  /** Commit counts keyed by repo → path → author login. */
  commitHistory?: Record<string, Record<string, Record<string, number>>>;
  /** Review history keyed by repo → login → reviews. */
  reviewHistory?: Record<string, Record<string, RecentReview[]>>;
  /** Open review load keyed by login. */
  openReviewLoad?: Record<string, number>;
  /** GitHub review-request timeline events keyed by repo. */
  reviewRequestEvents?: Record<string, ReviewRequestEvent[]>;
  /** Recently-merged PRs keyed by repo. */
  mergedPullRequests?: Record<string, MergedPullRequest[]>;
}

export interface RecordedComment {
  repo: string;
  prNumber: number;
  body: string;
}

export interface RecordedReviewRequest {
  repo: string;
  prNumber: number;
  logins: string[];
}

function prKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

export class MockGitHubAdapter implements GitHubAdapter {
  public readonly comments: RecordedComment[] = [];
  public readonly reviewRequests: RecordedReviewRequest[] = [];

  constructor(private readonly fixture: GitHubMockFixture = {}) {}

  async listOpenPullRequests(repo: string): Promise<PullRequest[]> {
    return this.fixture.openPullRequests?.[repo] ?? [];
  }

  async listRecentlyMergedPullRequests(
    repo: string,
    sinceIso: string,
  ): Promise<MergedPullRequest[]> {
    const since = sinceIso.slice(0, 10);
    return (this.fixture.mergedPullRequests?.[repo] ?? []).filter(
      (pr) => pr.mergedAt.slice(0, 10) >= since,
    );
  }

  async getPullRequestFiles(
    repo: string,
    prNumber: number,
  ): Promise<PullRequest["files"]> {
    return this.fixture.filesByPr?.[prKey(repo, prNumber)] ?? [];
  }

  async getCommitHistory(
    repo: string,
    paths: string[],
    _sinceIso: string,
  ): Promise<Record<string, Record<string, number>>> {
    const repoHistory = this.fixture.commitHistory?.[repo] ?? {};
    const result: Record<string, Record<string, number>> = {};
    for (const path of paths) {
      const authors = repoHistory[path];
      if (authors) {
        result[path] = { ...authors };
      }
    }
    return result;
  }

  async getReviewHistory(
    repo: string,
    query: ReviewHistoryQuery,
  ): Promise<ReviewHistoryPage> {
    const repoReviews = this.fixture.reviewHistory?.[repo] ?? {};
    const reviews: Record<string, RecentReview[]> = {};
    const scanned = new Set<number>();
    let maxPrNumber = query.sincePrNumber ?? 0;
    for (const [login, list] of Object.entries(repoReviews)) {
      reviews[login] = [...list];
      for (const review of list) {
        scanned.add(review.prNumber);
        if (review.prNumber > maxPrNumber) {
          maxPrNumber = review.prNumber;
        }
      }
    }
    for (const open of query.openPrs) {
      scanned.add(open.number);
      if (open.number > maxPrNumber) {
        maxPrNumber = open.number;
      }
    }
    return { reviews, scannedPrNumbers: [...scanned], maxPrNumber };
  }

  async getOpenReviewLoad(logins: string[]): Promise<Record<string, number>> {
    const loads = this.fixture.openReviewLoad ?? {};
    const result: Record<string, number> = {};
    for (const login of logins) {
      result[login] = loads[login] ?? 0;
    }
    return result;
  }

  async getReviewRequestEvents(
    repo: string,
    prNumbers: number[],
  ): Promise<ReviewRequestEvent[]> {
    const wanted = new Set(prNumbers);
    return (this.fixture.reviewRequestEvents?.[repo] ?? []).filter((ev) =>
      wanted.has(ev.pr),
    );
  }

  async postComment(
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<void> {
    this.comments.push({ repo, prNumber, body });
  }

  async requestReviewers(
    repo: string,
    prNumber: number,
    logins: string[],
  ): Promise<void> {
    this.reviewRequests.push({ repo, prNumber, logins: [...logins] });
  }
}
