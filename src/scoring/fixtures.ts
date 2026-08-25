import { DEFAULT_TEAM_CONFIG, type ResolvedConfig } from "../config.js";
import type {
  CandidateHistory,
  FileChange,
  JiraData,
  PullRequest,
  ScoredCandidate,
} from "../types.js";

/** Fully-resolved config for unit tests (team defaults + minimal repo fields). */
export function testConfig(
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  return {
    ...DEFAULT_TEAM_CONFIG,
    roster: ["alice", "bob", "carol"],
    repo: "org/repo",
    blocklist: [],
    ...overrides,
  };
}

export function file(
  path: string,
  additions = 0,
  deletions = 0,
): FileChange {
  return { path, additions, deletions };
}

export function candidate(
  login: string,
  partial: Partial<CandidateHistory> = {},
): CandidateHistory {
  return {
    login,
    commitsByPath: {},
    repoReviewCount: 0,
    openReviewLoad: 0,
    recentReviews: [],
    ...partial,
  };
}

export function pullRequest(
  partial: Partial<PullRequest> = {},
): PullRequest {
  return {
    number: 100,
    repo: "org/repo",
    author: "author",
    branch: "feat/auth-login",
    title: "Test PR",
    files: [],
    requestedReviewers: [],
    ...partial,
  };
}

export function scored(
  login: string,
  partial: Partial<ScoredCandidate> = {},
): ScoredCandidate {
  return {
    login,
    primaryScore: 0.5,
    familiarity: 0,
    knowledge: 0,
    boosts: {
      followUp: 0,
      filesAtRisk: 0,
      softEstimate: 0,
      softPriority: 0,
    },
    openReviewLoad: 0,
    notes: [],
    ...partial,
  };
}

export function jira(partial: JiraData = {}): JiraData {
  return { ...partial };
}
