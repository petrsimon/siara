import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MockGitHubAdapter,
  MockJiraAdapter,
  MockSlackAdapter,
} from "../adapters/mocks/index.js";
import { DEFAULT_TEAM_CONFIG } from "../config.js";
import { file, pullRequest, simpleFiles } from "../scoring/fixtures.js";
import { openStore, type SqliteStore } from "../store/sqliteStore.js";
import { daily } from "./daily.js";
import { dryRun } from "./dryRun.js";
import { formatRepostLine } from "./staleness.js";
import { sync } from "./sync.js";
import type { SiaraDeps } from "./index.js";

const REPO = "org/repo";
const NOW = "2026-08-25T10:00:00.000Z";
const LATER = "2026-08-26T10:00:00.000Z";

let fixtureCounter = 0;

function nextAssignmentsPath(label: string): string {
  fixtureCounter += 1;
  return join(tmpdir(), `siara-runtime-${label}-${fixtureCounter}.jsonl`);
}

function teamConfig() {
  return {
    ...DEFAULT_TEAM_CONFIG,
    roster: ["alice", "bob", "carol"],
  };
}

function makeDeps(
  github: MockGitHubAdapter,
  store: SqliteStore,
  extras: Partial<Pick<SiaraDeps, "slack" | "jira">> = {},
): SiaraDeps {
  return {
    store,
    github,
    jira: extras.jira ?? new MockJiraAdapter(),
    slack: extras.slack,
    teamConfig: teamConfig(),
    repoConfigs: [{ repo: REPO }],
    repos: [REPO],
  };
}

describe("sync", () => {
  let store: SqliteStore;
  let assignmentsPath: string;

  beforeEach(async () => {
    assignmentsPath = nextAssignmentsPath("sync");
    store = openStore({ dbPath: ":memory:", assignmentsPath });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(assignmentsPath)) {
      unlinkSync(assignmentsPath);
    }
  });

  it("cold-starts with full sync window when no prior sync", async () => {
    const pr = pullRequest({
      number: 1,
      files: [file("src/a.ts", 5, 2)],
    });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [pr] },
      commitHistory: {
        [REPO]: { "src/a.ts": { alice: 12 } },
      },
    });
    const deps = makeDeps(github, store);

    const results = await sync(deps, NOW);

    expect(results).toEqual([
      { repo: REPO, coldStart: true, syncedAtIso: NOW },
    ]);
    expect(await store.getLastSyncAt(REPO)).toBe(NOW);

    const [alice] = await store.getCandidateHistory(REPO, pr, ["alice"]);
    expect(alice?.commitsByPath).toEqual({ "src/a.ts": 12 });
  });

  it("incremental sync on second call uses last sync timestamp", async () => {
    const pr = pullRequest({
      number: 2,
      files: [file("src/b.ts", 1, 0)],
    });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [pr] },
      commitHistory: {
        [REPO]: { "src/b.ts": { bob: 4 } },
      },
    });
    const deps = makeDeps(github, store);

    await sync(deps, NOW);
    const second = await sync(deps, LATER);

    expect(second).toEqual([
      { repo: REPO, coldStart: false, syncedAtIso: LATER },
    ]);
    expect(await store.getLastSyncAt(REPO)).toBe(LATER);
  });
});

describe("daily dry-run", () => {
  let store: SqliteStore;
  let assignmentsPath: string;

  beforeEach(async () => {
    assignmentsPath = nextAssignmentsPath("dry");
    store = openStore({ dbPath: ":memory:", assignmentsPath });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(assignmentsPath)) {
      unlinkSync(assignmentsPath);
    }
  });

  it("computes assignments without GitHub, Slack, or JSONL side effects", async () => {
    const pr = pullRequest({
      number: 10,
      author: "author",
      files: simpleFiles(),
    });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [pr] },
      commitHistory: {
        [REPO]: {
          "src/auth/login.ts": { bob: 8 },
          "src/auth/session.ts": { bob: 6 },
        },
      },
    });
    const slack = new MockSlackAdapter();
    const deps = makeDeps(github, store, { slack });

    const result = await dryRun(deps, NOW);

    expect(result.synced).toHaveLength(1);
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0]?.assignees.length).toBeGreaterThan(0);
    expect(result.assigned[0]?.rationale).toContain("Assigned @");

    expect(github.comments).toEqual([]);
    expect(github.reviewRequests).toEqual([]);
    expect(slack.assignments).toEqual([]);
    expect(slack.reposts).toEqual([]);
    expect(await store.readAssignments()).toEqual([]);
  });
});

describe("daily live", () => {
  let store: SqliteStore;
  let assignmentsPath: string;

  beforeEach(async () => {
    assignmentsPath = nextAssignmentsPath("live");
    store = openStore({ dbPath: ":memory:", assignmentsPath });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(assignmentsPath)) {
      unlinkSync(assignmentsPath);
    }
  });

  it("posts comment, requests review, and appends assignment", async () => {
    const pr = pullRequest({
      number: 20,
      author: "author",
      files: simpleFiles(),
    });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [pr] },
      commitHistory: {
        [REPO]: {
          "src/auth/login.ts": { bob: 8 },
          "src/auth/session.ts": { bob: 6 },
        },
      },
    });
    const slack = new MockSlackAdapter();
    const deps = makeDeps(github, store, { slack });

    const result = await daily(deps, NOW);
    const entry = result.assigned[0];

    expect(entry?.assignees.length).toBeGreaterThan(0);
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]).toMatchObject({
      repo: REPO,
      prNumber: 20,
      body: entry?.rationale,
    });
    expect(github.reviewRequests).toEqual([
      { repo: REPO, prNumber: 20, logins: entry?.assignees },
    ]);
    expect(slack.assignments).toHaveLength(1);

    const assignments = await store.readAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      repo: REPO,
      pr: 20,
      assignees: entry?.assignees,
      band: entry?.band,
    });
  });
});

describe("staleness repost", () => {
  let store: SqliteStore;
  let assignmentsPath: string;

  beforeEach(async () => {
    assignmentsPath = nextAssignmentsPath("staleness");
    store = openStore({ dbPath: ":memory:", assignmentsPath });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(assignmentsPath)) {
      unlinkSync(assignmentsPath);
    }
  });

  it("includes overdue marker for stale posted PRs in Slack repost", async () => {
    const overdueLine = formatRepostLine({
      repo: REPO,
      prNumber: 30,
      ageDays: 10,
      assignee: "alice",
      level: "overdue",
    });
    expect(overdueLine).toContain("🔴");
    expect(overdueLine).toContain("10d overdue");

    const pr = pullRequest({
      number: 30,
      author: "author",
      files: simpleFiles(),
      postedAt: "2026-08-15T10:00:00.000Z",
      requestedReviewers: ["alice"],
    });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [pr] },
      commitHistory: {
        [REPO]: {
          "src/auth/login.ts": { bob: 8 },
          "src/auth/session.ts": { bob: 6 },
        },
      },
    });
    const slack = new MockSlackAdapter();
    const deps = makeDeps(github, store, { slack });

    await daily(deps, NOW);

    expect(slack.reposts).toHaveLength(1);
    expect(slack.reposts[0]?.text).toContain("🔴");
    expect(slack.reposts[0]?.text).toContain("10d overdue");
    expect(slack.reposts[0]?.text).toContain("@alice");
  });
});
