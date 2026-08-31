import { describe, expect, it } from "vitest";
import {
  parseFiles,
  parseJiraKey,
  parsePullRequests,
  parseReviewHistory,
  parseReviewRequestTimeline,
  openRequestStartedAt,
  firstRequestedAt,
  parseMergedPullRequests,
  tallyCommitsByLogin,
} from "./github.js";

describe("parseJiraKey", () => {
  it("extracts a ticket key from branch names", () => {
    expect(parseJiraKey("feat/RHCLOUD-50438-auth")).toBe("RHCLOUD-50438");
  });

  it("extracts a ticket key from titles", () => {
    expect(parseJiraKey("[RHCLOUD-99] Fix login")).toBe("RHCLOUD-99");
  });

  it("returns undefined when no key is present", () => {
    expect(parseJiraKey("chore/deps-bump")).toBeUndefined();
  });
});

describe("parseFiles", () => {
  it("maps a raw file array", () => {
    expect(
      parseFiles([
        { path: "src/a.ts", additions: 10, deletions: 2 },
        { path: "src/b.ts", additions: 0, deletions: 5 },
      ]),
    ).toEqual([
      { path: "src/a.ts", additions: 10, deletions: 2 },
      { path: "src/b.ts", additions: 0, deletions: 5 },
    ]);
  });

  it("maps gh pr view --json files wrapper", () => {
    expect(
      parseFiles({
        files: [{ path: "README.md", additions: 1, deletions: 0 }],
      }),
    ).toEqual([{ path: "README.md", additions: 1, deletions: 0 }]);
  });

  it("defaults missing numeric fields to zero", () => {
    expect(parseFiles([{ path: "x.ts" }])).toEqual([
      { path: "x.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("skips invalid entries", () => {
    expect(parseFiles([null, {}, { path: 42 }])).toEqual([]);
  });
});

describe("parsePullRequests", () => {
  const fixture = [
    {
      number: 42,
      headRefName: "feat/RHCLOUD-100-login",
      author: { login: "alice" },
      title: "Add login",
      files: [{ path: "src/auth.ts", additions: 5, deletions: 1 }],
      reviewRequests: [{ login: "bob" }, { login: "carol" }],
    },
    {
      number: 7,
      headRefName: "chore/deps",
      author: null,
      title: "Bump deps",
      reviewRequests: [],
    },
  ];

  it("maps gh pr list JSON to PullRequest objects", () => {
    const prs = parsePullRequests("org/repo", fixture);

    expect(prs).toHaveLength(2);
    expect(prs[0]).toEqual({
      number: 42,
      repo: "org/repo",
      author: "alice",
      branch: "feat/RHCLOUD-100-login",
      title: "Add login",
      files: [{ path: "src/auth.ts", additions: 5, deletions: 1 }],
      requestedReviewers: ["bob", "carol"],
      jiraKey: "RHCLOUD-100",
    });
  });

  it("uses unknown author when author is null", () => {
    const prs = parsePullRequests("org/repo", fixture);
    expect(prs[1]?.author).toBe("unknown");
    expect(prs[1]?.jiraKey).toBeUndefined();
  });

  it("returns empty array for non-array input", () => {
    expect(parsePullRequests("org/repo", null)).toEqual([]);
    expect(parsePullRequests("org/repo", {})).toEqual([]);
  });
});

describe("tallyCommitsByLogin", () => {
  it("counts logins per path into login → path maps", () => {
    const tallied = tallyCommitsByLogin("src/a.ts", [
      "alice",
      "alice",
      "bob",
      "",
    ]);

    expect(tallied).toEqual({
      alice: { "src/a.ts": 2 },
      bob: { "src/a.ts": 1 },
    });
  });
});

describe("parseReviewHistory", () => {
  it("groups reviews by login within the since window", () => {
    const pulls = [{ number: 10, head: { ref: "feat/foo" } }];
    const reviewsByPr = new Map([
      [
        10,
        [
          {
            user: { login: "alice" },
            submitted_at: "2026-02-01T00:00:00.000Z",
          },
          {
            user: { login: "bob" },
            submitted_at: "2025-01-01T00:00:00.000Z",
          },
          { user: { login: "carol" }, submitted_at: null },
        ],
      ],
    ]);

    const history = parseReviewHistory(
      pulls,
      reviewsByPr,
      "2026-01-01T00:00:00.000Z",
    );

    expect(history.alice).toEqual([
      {
        prNumber: 10,
        branch: "feat/foo",
        reviewedAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    expect(history.bob).toBeUndefined();
    expect(history.carol).toBeUndefined();
  });
});

describe("parseReviewRequestTimeline", () => {
  it("keeps user request/remove events and skips teams", () => {
    const events = parseReviewRequestTimeline(7, {
      timelineItems: {
        nodes: [
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-01-01T00:00:00.000Z",
            requestedReviewer: { __typename: "User", login: "bob" },
          },
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-01-02T00:00:00.000Z",
            requestedReviewer: { __typename: "Team", login: null },
          },
          {
            __typename: "ReviewRequestRemovedEvent",
            createdAt: "2026-01-03T00:00:00.000Z",
            requestedReviewer: { __typename: "User", login: "bob" },
          },
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-01-04T00:00:00.000Z",
            requestedReviewer: { __typename: "User", login: "carol" },
          },
        ],
      },
    });

    expect(events).toEqual([
      { pr: 7, login: "bob", at: "2026-01-01T00:00:00.000Z", kind: "requested" },
      { pr: 7, login: "bob", at: "2026-01-03T00:00:00.000Z", kind: "removed" },
      { pr: 7, login: "carol", at: "2026-01-04T00:00:00.000Z", kind: "requested" },
    ]);
  });
});

describe("openRequestStartedAt", () => {
  it("uses the latest still-open request per reviewer", () => {
    const starts = openRequestStartedAt([
      { pr: 1, login: "bob", at: "2026-01-01T00:00:00.000Z", kind: "requested" },
      { pr: 1, login: "bob", at: "2026-01-10T00:00:00.000Z", kind: "removed" },
      { pr: 1, login: "bob", at: "2026-01-20T00:00:00.000Z", kind: "requested" },
      { pr: 1, login: "carol", at: "2026-01-01T00:00:00.000Z", kind: "requested" },
      { pr: 1, login: "carol", at: "2026-01-02T00:00:00.000Z", kind: "removed" },
    ]);

    expect(starts.get("1\0bob")).toBe("2026-01-20T00:00:00.000Z");
    expect(starts.get("1\0carol")).toBeUndefined();
  });
});

describe("firstRequestedAt", () => {
  it("keeps the earliest requested time per reviewer, ignoring removals", () => {
    const starts = firstRequestedAt([
      { pr: 1, login: "bob", at: "2026-01-20T00:00:00.000Z", kind: "requested" },
      { pr: 1, login: "bob", at: "2026-01-01T00:00:00.000Z", kind: "requested" },
      { pr: 1, login: "bob", at: "2026-01-10T00:00:00.000Z", kind: "removed" },
      { pr: 2, login: "carol", at: "2026-02-05T00:00:00.000Z", kind: "requested" },
    ]);

    expect(starts.get("1\0bob")).toBe("2026-01-01T00:00:00.000Z");
    expect(starts.get("2\0carol")).toBe("2026-02-05T00:00:00.000Z");
  });
});

describe("parseMergedPullRequests", () => {
  it("maps number/author/createdAt/mergedAt and skips rows without a merge time", () => {
    const merged = parseMergedPullRequests([
      { number: 7, author: { login: "alice" }, createdAt: "2026-08-01T00:00:00.000Z", mergedAt: "2026-08-20T00:00:00.000Z" },
      { number: 8, author: null, mergedAt: "2026-08-21T00:00:00.000Z" },
      { number: 9, author: { login: "bob" }, mergedAt: null }, // not merged
      { number: 10 }, // missing fields
    ]);

    expect(merged).toEqual([
      { number: 7, author: "alice", createdAt: "2026-08-01T00:00:00.000Z", mergedAt: "2026-08-20T00:00:00.000Z" },
      { number: 8, author: "unknown", mergedAt: "2026-08-21T00:00:00.000Z" },
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(parseMergedPullRequests(null)).toEqual([]);
    expect(parseMergedPullRequests({})).toEqual([]);
  });
});
