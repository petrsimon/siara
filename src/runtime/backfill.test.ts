import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockGitHubAdapter, MockJiraAdapter } from "../adapters/mocks/index.js";
import { DEFAULT_TEAM_CONFIG } from "../config.js";
import { file, pullRequest } from "../scoring/fixtures.js";
import { responsePathFor } from "../store/responseLog.js";
import { openStore, type SqliteStore } from "../store/sqliteStore.js";
import type { Assignment, ReviewResponse } from "../types.js";
import { backfill } from "./backfill.js";
import { buildReviewAgePoints } from "../dashboard/metrics.js";
import type { SiaraDeps } from "./index.js";

const REPO = "org/repo";
const OTHER = "org/other";
const NOW = "2026-08-25T10:00:00.000Z";

let fixtureCounter = 0;

function nextAssignmentsPath(label: string): string {
  fixtureCounter += 1;
  return join(tmpdir(), `siara-backfill-${label}-${fixtureCounter}.jsonl`);
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
  repos: string[] = [REPO],
): SiaraDeps {
  return {
    store,
    github,
    jira: new MockJiraAdapter(),
    teamConfig: teamConfig(),
    repoConfigs: repos.map((repo) => ({ repo })),
    repos,
  };
}

function mergedResponse(
  partial: Partial<ReviewResponse> & Pick<ReviewResponse, "pr" | "reviewer">,
): ReviewResponse {
  return {
    repo: REPO,
    assignedAt: "2026-08-10T12:00:00.000Z",
    outstanding: false,
    mergedAt: "2026-08-12T18:00:00.000Z",
    mergeHours: 54,
    ...partial,
  };
}

describe("backfill", () => {
  let store: SqliteStore;
  let assignmentsPath: string;
  let responsePath: string;

  beforeEach(async () => {
    assignmentsPath = nextAssignmentsPath("case");
    responsePath = responsePathFor(assignmentsPath);
    store = openStore({ dbPath: ":memory:", assignmentsPath });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(assignmentsPath)) unlinkSync(assignmentsPath);
    if (existsSync(responsePath)) unlinkSync(responsePath);
  });

  it("scores a historical merged PR from the response report", async () => {
    const files = [file("src/a.ts", 40, 10), file("src/b.ts", 20, 5)];
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [] },
      filesByPr: { [`${REPO}#42`]: files },
    });
    await store.writeResponseReport({
      takenAt: NOW,
      responses: [
        mergedResponse({
          pr: 42,
          reviewer: "bob",
          assignedAt: "2026-08-11T09:00:00.000Z",
        }),
        mergedResponse({
          pr: 42,
          reviewer: "alice",
          assignedAt: "2026-08-10T08:00:00.000Z",
        }),
      ],
    });

    const result = await backfill(makeDeps(github, store), NOW);

    expect(result).toEqual({
      open: { total: 0, scored: 0, skipped: 0, failed: 0 },
      historical: { total: 1, scored: 1, skipped: 0, failed: 0 },
    });

    const assignments = await store.readAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      date: "2026-08-10",
      repo: REPO,
      pr: 42,
      assignees: ["alice", "bob"],
      candidates: [],
      origin: "historical-difficulty-backfill",
    });
    expect(assignments[0]?.rationale).toContain("BACKFILL:HISTORICAL");
    expect(assignments[0]?.band).toBeTruthy();
    expect(assignments[0]?.difficulty).toBeGreaterThan(0);

    const report = await store.readResponseReport();
    const points = buildReviewAgePoints([], report, assignments);
    expect(points).toMatchObject([{ repo: REPO, pr: 42, band: assignments[0]?.band }]);
  });

  it("ignores response rows without a valid mergedAt", async () => {
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [] },
      filesByPr: { [`${REPO}#7`]: [file("src/x.ts", 5, 1)] },
    });
    await store.writeResponseReport({
      takenAt: NOW,
      responses: [
        {
          repo: REPO,
          pr: 7,
          reviewer: "alice",
          assignedAt: "2026-08-10T12:00:00.000Z",
          outstanding: true,
          waitingHours: 12,
        },
        {
          repo: REPO,
          pr: 8,
          reviewer: "bob",
          assignedAt: "2026-08-10T12:00:00.000Z",
          outstanding: false,
          firstReviewAt: "2026-08-11T12:00:00.000Z",
          latencyHours: 24,
          mergedAt: "not-a-date",
        },
      ],
    });

    const result = await backfill(makeDeps(github, store), NOW);

    expect(result.historical).toEqual({ total: 0, scored: 0, skipped: 0, failed: 0 });
    await expect(store.readAssignments()).resolves.toEqual([]);
  });

  it("deduplicates historical candidates by repo#PR", async () => {
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [] },
      filesByPr: { [`${REPO}#9`]: [file("src/y.ts", 8, 2)] },
    });
    await store.writeResponseReport({
      takenAt: NOW,
      responses: [
        mergedResponse({ pr: 9, reviewer: "carol" }),
        mergedResponse({ pr: 9, reviewer: "alice" }),
        mergedResponse({ pr: 9, reviewer: "bob" }),
      ],
    });

    const result = await backfill(makeDeps(github, store), NOW);

    expect(result.historical).toEqual({ total: 1, scored: 1, skipped: 0, failed: 0 });
    const assignments = await store.readAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.assignees).toEqual(["alice", "bob", "carol"]);
  });

  it("limits historical candidates to configured repos", async () => {
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [] },
      filesByPr: {
        [`${REPO}#3`]: [file("src/in.ts", 4, 1)],
        [`${OTHER}#99`]: [file("src/out.ts", 4, 1)],
      },
    });
    await store.writeResponseReport({
      takenAt: NOW,
      responses: [
        mergedResponse({ pr: 3, reviewer: "alice" }),
        mergedResponse({ repo: OTHER, pr: 99, reviewer: "bob" }),
      ],
    });

    const result = await backfill(makeDeps(github, store, [REPO]), NOW);

    expect(result.historical).toEqual({ total: 1, scored: 1, skipped: 0, failed: 0 });
    const assignments = await store.readAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ repo: REPO, pr: 3 });
  });

  it("skips historical PRs that already have an assignment band", async () => {
    const prior: Assignment = {
      date: "2026-08-01",
      repo: REPO,
      pr: 15,
      assignees: ["alice"],
      band: "moderate",
      difficulty: 0.4,
      rationale: "prior",
      candidates: [],
    };
    await store.appendAssignment(prior);

    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [] },
      filesByPr: { [`${REPO}#15`]: [file("src/z.ts", 50, 20)] },
    });
    await store.writeResponseReport({
      takenAt: NOW,
      responses: [mergedResponse({ pr: 15, reviewer: "bob" })],
    });

    const result = await backfill(makeDeps(github, store), NOW);

    expect(result.historical).toEqual({ total: 1, scored: 0, skipped: 1, failed: 0 });
    await expect(store.readAssignments()).resolves.toEqual([prior]);
  });

  it("keeps successful historical progress when another PR cannot be scored", async () => {
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [] },
      filesByPr: { [`${REPO}#30`]: [file("src/good.ts", 8, 2)] },
    });
    await store.writeResponseReport({
      takenAt: NOW,
      responses: [
        mergedResponse({ pr: 30, reviewer: "alice" }),
        mergedResponse({ pr: 31, reviewer: "bob" }),
      ],
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await backfill(makeDeps(github, store), NOW);

    expect(result.historical).toEqual({ total: 2, scored: 1, skipped: 0, failed: 1 });
    await expect(store.readAssignments()).resolves.toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`${REPO}#31`));
    warning.mockRestore();
  });

  it("ignores historical rows whose assignment time cannot form a chart point", async () => {
    const github = new MockGitHubAdapter({ openPullRequests: { [REPO]: [] } });
    await store.writeResponseReport({
      takenAt: NOW,
      responses: [mergedResponse({ pr: 32, reviewer: "alice", assignedAt: "invalid" })],
    });

    const result = await backfill(makeDeps(github, store), NOW);

    expect(result.historical).toEqual({ total: 0, scored: 0, skipped: 0, failed: 0 });
    await expect(store.readAssignments()).resolves.toEqual([]);
  });

  it("skips historical PRs already encountered as open", async () => {
    const openPr = pullRequest({
      number: 20,
      requestedReviewers: ["alice"],
      files: [file("src/open.ts", 6, 1)],
    });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [openPr] },
      filesByPr: {
        [`${REPO}#20`]: [file("src/open.ts", 6, 1)],
      },
    });
    await store.writeResponseReport({
      takenAt: NOW,
      responses: [mergedResponse({ pr: 20, reviewer: "bob" })],
    });

    const result = await backfill(makeDeps(github, store), NOW);

    expect(result.open).toEqual({ total: 1, scored: 1, skipped: 0, failed: 0 });
    expect(result.historical).toEqual({ total: 1, scored: 0, skipped: 1, failed: 0 });

    const assignments = await store.readAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.rationale).toContain("[BACKFILL]");
    expect(assignments[0]?.rationale).not.toContain("HISTORICAL");
  });

  it("keeps open-PR backfill idempotent across runs", async () => {
    const openPr = pullRequest({
      number: 5,
      requestedReviewers: ["carol"],
    });
    const github = new MockGitHubAdapter({
      openPullRequests: { [REPO]: [openPr] },
      filesByPr: { [`${REPO}#5`]: [file("src/idem.ts", 3, 1)] },
    });
    const deps = makeDeps(github, store);

    const first = await backfill(deps, NOW);
    const second = await backfill(deps, NOW);

    expect(first.open).toEqual({ total: 1, scored: 1, skipped: 0, failed: 0 });
    expect(second.open).toEqual({ total: 1, scored: 0, skipped: 1, failed: 0 });
    await expect(store.readAssignments()).resolves.toHaveLength(1);
  });
});
