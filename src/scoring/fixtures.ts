import { DEFAULT_TEAM_CONFIG, type ResolvedConfig } from "../config.js";
import type {
  CandidateHistory,
  FileChange,
  JiraData,
  PullRequest,
  ScoredCandidate,
} from "../types.js";
import type { PickInput } from "./pickReviewers.js";

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

/** Small diff that lands in the simple band. */
export function simpleFiles(): FileChange[] {
  return [
    file("src/auth/login.ts", 5, 3),
    file("src/auth/session.ts", 4, 2),
  ];
}

/** Mid-sized diff that lands in the moderate band. */
export function moderateFiles(): FileChange[] {
  return [
    file("src/a/one.ts", 30, 10),
    file("src/b/two.ts", 25, 15),
    file("src/c/three.ts", 20, 10),
    file("lib/d/four.ts", 15, 5),
  ];
}

/** Large multi-directory diff that lands in the hard band. */
export function hardFiles(): FileChange[] {
  return [
    ...Array.from({ length: 4 }, (_, i) => file(`src/a/mod${i}.ts`, 40, 10)),
    ...Array.from({ length: 4 }, (_, i) => file(`src/b/mod${i}.ts`, 40, 10)),
    ...Array.from({ length: 4 }, (_, i) => file(`lib/c/mod${i}.ts`, 40, 10)),
  ];
}

/** Default pickReviewers input for orchestrator tests. */
export function pickInput(
  partial: Partial<Omit<PickInput, "pr" | "config">> & {
    pr?: Partial<PullRequest>;
    config?: Partial<ResolvedConfig>;
  } = {},
): PickInput {
  const { pr: prPartial, config: configPartial, ...rest } = partial;
  return {
    pr: pullRequest(prPartial),
    config: testConfig(configPartial),
    candidates: [
      candidate("alice"),
      candidate("bob"),
      candidate("carol"),
    ],
    nowIso: "2026-01-15T12:00:00.000Z",
    ...rest,
  };
}
