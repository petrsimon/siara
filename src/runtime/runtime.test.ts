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
import { overridesPathFor } from "../store/overridesLog.js";
import { snapshotPathFor } from "../store/snapshotLog.js";
import { responsePathFor } from "../store/responseLog.js";
import { hoursBetween } from "./dates.js";
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
      { repo: REPO, coldStart: true, syncedAtIso: NOW, giantPrs: [] },
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
      { repo: REPO, coldStart: false, syncedAtIso: LATER, giantPrs: [] },
    ]);
    expect(await store.getLastSyncAt(REPO)).toBe(LATER);
  });

  it("flags (but does not cap) a PR exceeding the giant-PR file threshold", async () => {
    const bigFiles = Array.from({ length: 45 }, (_, i) =>
      file(`src/mod${i}.ts`, 3, 1),
    );
    const pr = pullRequest({ number: 7, author: "author", files: bigFiles });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [pr] },
    });
    const deps = makeDeps(github, store);

    const [result] = await sync(deps, NOW);

    expect(result?.giantPrs).toEqual([
      { pr: 7, author: "author", fileCount: 45 },
    ]);
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

  it("noSync scores from the cached store without a sync pass", async () => {
    const pr = pullRequest({ number: 11, author: "author", files: simpleFiles() });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [pr] },
    });
    const deps = makeDeps(github, store);

    const result = await dryRun(deps, NOW, { noSync: true });

    expect(result.synced).toEqual([]);
    expect(result.assigned).toHaveLength(1);
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
    for (const p of [
      assignmentsPath,
      snapshotPathFor(assignmentsPath),
      responsePathFor(assignmentsPath),
    ]) {
      if (existsSync(p)) unlinkSync(p);
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

    // A point-in-time open-PRs snapshot is written for the dashboard.
    const snapshot = await store.readOpenPrsSnapshot();
    expect(snapshot?.takenAt).toBe(NOW);
    expect(snapshot?.prs).toHaveLength(1);
    expect(snapshot?.prs[0]).toMatchObject({
      repo: REPO,
      pr: 20,
      assignees: entry?.assignees,
      band: entry?.band,
    });
  });

  it("shadow mode logs recommendations + artifacts but posts nothing, deduped", async () => {
    const pr = pullRequest({ number: 60, author: "author", files: simpleFiles() });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [pr] },
      commitHistory: {
        [REPO]: { "src/auth/login.ts": { bob: 8 }, "src/auth/session.ts": { bob: 6 } },
      },
    });
    const slack = new MockSlackAdapter();
    const deps = makeDeps(github, store, { slack });

    const first = await daily(deps, NOW, { post: false });
    expect(first.assigned[0]?.assignees.length).toBeGreaterThan(0);

    // No external side effects.
    expect(github.comments).toEqual([]);
    expect(github.reviewRequests).toEqual([]);
    expect(slack.assignments).toEqual([]);
    expect(slack.reposts).toEqual([]);

    // But the local artifacts are written.
    expect(await store.readAssignments()).toHaveLength(1);
    expect((await store.readOpenPrsSnapshot())?.prs).toHaveLength(1);
    expect(await store.readResponseReport()).toBeDefined();

    // A second identical run does not re-append the same recommendation.
    await daily(makeDeps(github, store, { slack }), LATER, { post: false });
    expect(await store.readAssignments()).toHaveLength(1);
  });

  it("does not write a snapshot on a dry run", async () => {
    const pr = pullRequest({ number: 21, author: "author", files: simpleFiles() });
    const github = new MockGitHubAdapter({ openPullRequests: { [REPO]: [pr] } });
    const deps = makeDeps(github, store);

    await dryRun(deps, NOW);
    expect(await store.readOpenPrsSnapshot()).toBeUndefined();
    expect(await store.readResponseReport()).toBeUndefined();
  });

  it("writes a review-latency report with reviewed and outstanding entries", async () => {
    // Two assignments five days ago: alice on #50 (later reviewed), bob on #51.
    const past = "2026-08-20";
    const base = { repo: REPO, difficulty: 0.5, band: "moderate" as const, rationale: "x", candidates: [] };
    await store.appendAssignment({ ...base, date: past, pr: 50, assignees: ["alice"] });
    await store.appendAssignment({ ...base, date: past, pr: 51, assignees: ["bob"] });

    // #51 stays open (pending bob, no review) → outstanding; #50 is closed but
    // alice reviewed it two days after assignment → measured latency.
    const pending = pullRequest({
      number: 51,
      author: "author",
      files: simpleFiles(),
      requestedReviewers: ["bob"],
    });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [pending] },
      reviewHistory: {
        [REPO]: { alice: [{ prNumber: 50, branch: "b", reviewedAt: "2026-08-22T10:00:00.000Z" }] },
      },
      reviewRequestEvents: {
        [REPO]: [
          {
            pr: 51,
            login: "bob",
            at: "2026-08-20T00:00:00.000Z",
            kind: "requested",
          },
        ],
      },
    });
    const deps = makeDeps(github, store);

    await daily(deps, NOW);

    const report = await store.readResponseReport();
    const alice = report?.responses.find((r) => r.reviewer === "alice");
    const bob = report?.responses.find((r) => r.reviewer === "bob");

    expect(alice?.outstanding).toBe(false);
    expect(alice?.firstReviewAt).toBe("2026-08-22T10:00:00.000Z");
    expect(alice?.latencyHours).toBe(
      hoursBetween("2026-08-20T00:00:00.000Z", "2026-08-22T10:00:00.000Z"),
    );

    expect(bob?.outstanding).toBe(true);
    expect(bob?.waitingHours).toBe(hoursBetween("2026-08-20T00:00:00.000Z", NOW));
  });

  it("measures outstanding wait from the GitHub review-request time", async () => {
    const past = "2026-08-24";
    await store.appendAssignment({
      date: past,
      repo: REPO,
      pr: 51,
      assignees: ["bob"],
      difficulty: 0.5,
      band: "moderate",
      rationale: "x",
      candidates: [],
    });
    const pending = pullRequest({
      number: 51,
      author: "author",
      files: simpleFiles(),
      requestedReviewers: ["bob"],
    });
    const githubRequestedAt = "2026-08-10T12:00:00.000Z";
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [pending] },
      reviewRequestEvents: {
        [REPO]: [
          { pr: 51, login: "bob", at: githubRequestedAt, kind: "requested" },
        ],
      },
    });

    await daily(makeDeps(github, store), NOW, { noSync: true });

    const bob = (await store.readResponseReport())?.responses.find(
      (r) => r.reviewer === "bob",
    );
    expect(bob?.outstanding).toBe(true);
    expect(bob?.assignedAt).toBe(githubRequestedAt);
    expect(bob?.waitingHours).toBe(hoursBetween(githubRequestedAt, NOW));
  });

  it("omits outstanding reviewers GitHub never requested", async () => {
    await store.appendAssignment({
      date: "2026-08-20",
      repo: REPO,
      pr: 51,
      assignees: ["bob"],
      difficulty: 0.5,
      band: "moderate",
      rationale: "x",
      candidates: [],
    });
    const pending = pullRequest({
      number: 51,
      author: "author",
      files: simpleFiles(),
      requestedReviewers: ["bob"],
    });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [pending] },
    });

    await daily(makeDeps(github, store), NOW, { noSync: true });

    const report = await store.readResponseReport();
    expect(report?.responses.find((r) => r.reviewer === "bob")).toBeUndefined();
  });

  it("records time-to-merge for reviewers on a since-merged PR", async () => {
    const requestedAt = "2026-08-15T09:00:00.000Z";
    const mergedAt = "2026-08-20T09:00:00.000Z";
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [] },
      mergedPullRequests: {
        [REPO]: [{ number: 60, author: "author", mergedAt }],
      },
      reviewRequestEvents: {
        [REPO]: [{ pr: 60, login: "bob", at: requestedAt, kind: "requested" }],
      },
    });

    await daily(makeDeps(github, store), NOW, { noSync: true });

    const bob = (await store.readResponseReport())?.responses.find(
      (r) => r.reviewer === "bob" && r.pr === 60,
    );
    expect(bob?.mergedAt).toBe(mergedAt);
    expect(bob?.assignedAt).toBe(requestedAt);
    expect(bob?.mergeHours).toBe(hoursBetween(requestedAt, mergedAt));
    expect(bob?.author).toBe("author");
  });

  it("omits merge time when GitHub never recorded the review request", async () => {
    // Siara logged the assignment, but there is no GitHub review_requested
    // event — so there is no real assignment time to measure merge from.
    await store.appendAssignment({
      date: "2026-08-14",
      repo: REPO,
      pr: 62,
      assignees: ["bob"],
      difficulty: 0.5,
      band: "moderate",
      rationale: "x",
      candidates: [],
    });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [] },
      mergedPullRequests: {
        [REPO]: [{ number: 62, author: "author", mergedAt: "2026-08-20T09:00:00.000Z" }],
      },
    });

    await daily(makeDeps(github, store), NOW, { noSync: true });

    const bob = (await store.readResponseReport())?.responses.find(
      (r) => r.reviewer === "bob" && r.pr === 62,
    );
    expect(bob?.mergeHours).toBeUndefined();
    expect(bob?.mergedAt).toBeUndefined();
  });

  it("overlays merge time onto a completed-review response", async () => {
    const past = "2026-08-14";
    await store.appendAssignment({
      date: past,
      repo: REPO,
      pr: 61,
      assignees: ["alice"],
      difficulty: 0.5,
      band: "moderate",
      rationale: "x",
      candidates: [],
    });
    const reviewedAt = "2026-08-16T10:00:00.000Z";
    const requestedAt = "2026-08-15T09:00:00.000Z";
    const mergedAt = "2026-08-18T09:00:00.000Z";
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [] },
      reviewHistory: {
        [REPO]: { alice: [{ prNumber: 61, branch: "b", reviewedAt }] },
      },
      reviewRequestEvents: {
        [REPO]: [{ pr: 61, login: "alice", at: requestedAt, kind: "requested" }],
      },
      mergedPullRequests: {
        [REPO]: [{ number: 61, author: "author", mergedAt }],
      },
    });

    await daily(makeDeps(github, store), NOW);

    const responses = (await store.readResponseReport())?.responses.filter(
      (r) => r.reviewer === "alice" && r.pr === 61,
    );
    // Single response for the pair — merge fields overlaid, not duplicated.
    expect(responses).toHaveLength(1);
    const alice = responses?.[0];
    // Merge overlay re-anchors the record to the real GitHub request time,
    // overriding the assignment-log date and recomputing latency from it.
    expect(alice?.assignedAt).toBe(requestedAt);
    expect(alice?.latencyHours).toBe(hoursBetween(requestedAt, reviewedAt));
    expect(alice?.mergedAt).toBe(mergedAt);
    expect(alice?.mergeHours).toBe(hoursBetween(requestedAt, mergedAt));
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
    for (const p of [assignmentsPath, snapshotPathFor(assignmentsPath)]) {
      if (existsSync(p)) unlinkSync(p);
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

describe("manual override tracking", () => {
  let store: SqliteStore;
  let assignmentsPath: string;

  beforeEach(async () => {
    assignmentsPath = nextAssignmentsPath("override");
    store = openStore({ dbPath: ":memory:", assignmentsPath });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    for (const p of [
      assignmentsPath,
      overridesPathFor(assignmentsPath),
      snapshotPathFor(assignmentsPath),
    ]) {
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("detects, logs, and reports a reviewer change without reverting it", async () => {
    // Run 1: assign a fresh PR.
    const pr = pullRequest({ number: 40, author: "author", files: simpleFiles() });
    const github = new MockGitHubAdapter({ openPullRequests: { [REPO]: [pr] } });
    const deps = makeDeps(github, store);
    const first = await daily(deps, NOW);
    const suggested = first.assigned[0]?.assignees ?? [];
    expect(suggested.length).toBeGreaterThan(0);
    expect(first.overrides).toEqual([]);

    // Run 2: the PR now carries a different, manually-set reviewer.
    const manual = ["alice", "bob", "carol"].find((l) => !suggested.includes(l))!;
    const changed = pullRequest({
      number: 40,
      author: "author",
      files: simpleFiles(),
      requestedReviewers: [manual],
    });
    const github2 = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [changed] },
    });
    const deps2 = makeDeps(github2, store);
    const second = await daily(deps2, LATER);

    // Respected (never re-requested) and logged exactly once.
    expect(github2.reviewRequests).toEqual([]);
    expect(second.overrides).toHaveLength(1);
    expect(second.overrides[0]).toMatchObject({
      repo: REPO,
      pr: 40,
      suggested: [...suggested].sort(),
      actual: [manual],
    });

    const logged = await store.readOverrides();
    expect(logged).toHaveLength(1);

    // Run 3: same divergence — not re-logged.
    const third = await daily(makeDeps(github2, store), LATER);
    expect(third.overrides).toEqual([]);
    expect(await store.readOverrides()).toHaveLength(1);
  });

  it("does not flag a PR whose reviewers match the suggestion", async () => {
    const pr = pullRequest({ number: 41, author: "author", files: simpleFiles() });
    const github = new MockGitHubAdapter({ openPullRequests: { [REPO]: [pr] } });
    const first = await daily(makeDeps(github, store), NOW);
    const suggested = first.assigned[0]?.assignees ?? [];

    const kept = pullRequest({
      number: 41,
      author: "author",
      files: simpleFiles(),
      requestedReviewers: suggested,
    });
    const github2 = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [kept] },
    });
    const second = await daily(makeDeps(github2, store), LATER);

    expect(second.overrides).toEqual([]);
    expect(await store.readOverrides()).toEqual([]);
  });
});
