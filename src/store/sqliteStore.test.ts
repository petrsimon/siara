import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Assignment, PullRequest } from "../types.js";
import { openStore, type SqliteStore } from "./sqliteStore.js";

let fixtureCounter = 0;

function nextAssignmentsPath(label: string): string {
  fixtureCounter += 1;
  return join(tmpdir(), `siara-store-${label}-${fixtureCounter}.jsonl`);
}

function samplePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    repo: "org/repo",
    author: "author",
    branch: "feat/auth-login",
    title: "Add login",
    files: [{ path: "src/auth/login.ts", additions: 10, deletions: 2 }],
    requestedReviewers: [],
    ...overrides,
  };
}

describe("SqliteStore", () => {
  let store: SqliteStore;
  let assignmentsPath: string;

  beforeEach(async () => {
    assignmentsPath = nextAssignmentsPath("default");
    store = openStore({ dbPath: ":memory:", assignmentsPath });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(assignmentsPath)) {
      unlinkSync(assignmentsPath);
    }
  });

  it("init() is idempotent", async () => {
    await expect(store.init()).resolves.toBeUndefined();
    await expect(store.init()).resolves.toBeUndefined();
  });

  it("upsertCommitHistory filters commitsByPath to PR paths and parent dirs", async () => {
    const repo = "org/repo";
    const pr = samplePr();

    await store.upsertCommitHistory(repo, {
      alice: {
        "src/auth/login.ts": 5,
        "src/other/unrelated.ts": 99,
      },
      bob: {
        "src/auth": 3,
      },
    });

    const [alice, bob, stranger] = await store.getCandidateHistory(repo, pr, [
      "alice",
      "bob",
      "stranger",
    ]);

    expect(alice).toMatchObject({
      login: "alice",
      commitsByPath: { "src/auth/login.ts": 5 },
      repoReviewCount: 0,
      openReviewLoad: 0,
      recentReviews: [],
    });
    expect(alice?.commitsByPath["src/other/unrelated.ts"]).toBeUndefined();

    expect(bob).toMatchObject({
      login: "bob",
      commitsByPath: { "src/auth": 3 },
    });

    expect(stranger).toMatchObject({
      login: "stranger",
      commitsByPath: {},
      repoReviewCount: 0,
      openReviewLoad: 0,
      recentReviews: [],
    });
  });

  it("upsertReviewHistory populates repoReviewCount and recentReviews; re-upsert replaces", async () => {
    const repo = "org/repo";
    const pr = samplePr();

    await store.upsertReviewHistory(repo, {
      alice: [
        {
          prNumber: 10,
          branch: "feat/auth-login",
          jiraEpic: "EPIC-1",
          reviewedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          prNumber: 11,
          branch: "feat/other",
          reviewedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });

    let [alice] = await store.getCandidateHistory(repo, pr, ["alice"]);
    expect(alice?.repoReviewCount).toBe(2);
    expect(alice?.recentReviews).toEqual([
      {
        prNumber: 10,
        branch: "feat/auth-login",
        jiraEpic: "EPIC-1",
        reviewedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        prNumber: 11,
        branch: "feat/other",
        reviewedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);

    await store.upsertReviewHistory(repo, {
      alice: [
        {
          prNumber: 99,
          branch: "feat/replacement",
          reviewedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    });

    [alice] = await store.getCandidateHistory(repo, pr, ["alice"]);
    expect(alice?.repoReviewCount).toBe(1);
    expect(alice?.recentReviews).toEqual([
      {
        prNumber: 99,
        branch: "feat/replacement",
        reviewedAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("upsertOpenLoad is reflected in openReviewLoad; unknown login defaults to 0", async () => {
    const repo = "org/repo";
    const pr = samplePr();

    await store.upsertOpenLoad({ alice: 4, bob: 1 });

    const [alice, bob, stranger] = await store.getCandidateHistory(repo, pr, [
      "alice",
      "bob",
      "stranger",
    ]);

    expect(alice?.openReviewLoad).toBe(4);
    expect(bob?.openReviewLoad).toBe(1);
    expect(stranger?.openReviewLoad).toBe(0);
  });

  it("upsertJira/getJira round-trip; unknown key returns undefined", async () => {
    await store.upsertJira("RHCLOUD-500", {
      estimate: 3,
      priority: "high",
      epic: "EPIC-42",
    });

    await expect(store.getJira("RHCLOUD-500")).resolves.toEqual({
      estimate: 3,
      priority: "high",
      epic: "EPIC-42",
    });
    await expect(store.getJira("RHCLOUD-999")).resolves.toBeUndefined();
  });

  it("getLastSyncAt/setLastSyncAt round-trip", async () => {
    await expect(store.getLastSyncAt("org/repo")).resolves.toBeUndefined();

    await store.setLastSyncAt("org/repo", "2026-01-15T12:00:00.000Z");
    await expect(store.getLastSyncAt("org/repo")).resolves.toBe(
      "2026-01-15T12:00:00.000Z",
    );
  });

  it("appendAssignment and readAssignments round-trip multiple records", async () => {
    const a1: Assignment = {
      date: "2026-01-01",
      pr: 1,
      repo: "org/repo",
      assignees: ["alice"],
      difficulty: 0.2,
      band: "simple",
      rationale: "alice knows the area",
      candidates: ["alice:1.0", "bob:0.5"],
    };
    const a2: Assignment = {
      date: "2026-01-02",
      pr: 2,
      repo: "org/repo",
      assignees: ["bob"],
      difficulty: 0.7,
      band: "hard",
      rationale: "bob has depth",
      candidates: ["bob:1.0"],
    };

    await store.appendAssignment(a1);
    await store.appendAssignment(a2);

    await expect(store.readAssignments()).resolves.toEqual([a1, a2]);
  });

  it("readAssignments on a missing file returns []", async () => {
    const missingPath = nextAssignmentsPath("missing");
    const missingStore = openStore({
      dbPath: ":memory:",
      assignmentsPath: missingPath,
    });
    await missingStore.init();

    await expect(missingStore.readAssignments()).resolves.toEqual([]);
    await missingStore.close();
  });
});
