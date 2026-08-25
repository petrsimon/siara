import { describe, expect, it } from "vitest";
import { file, jira, pullRequest } from "../../scoring/fixtures.js";
import {
  MockGitHubAdapter,
  MockJiraAdapter,
  MockSlackAdapter,
} from "./index.js";

describe("MockGitHubAdapter", () => {
  it("resolves fixture data and records side effects", async () => {
    const pr = pullRequest({ number: 7, files: [file("src/a.ts", 1, 0)] });
    const adapter = new MockGitHubAdapter({
      openPullRequests: { "org/repo": [pr] },
      filesByPr: { "org/repo#7": pr.files },
      commitHistory: {
        "org/repo": { "src/a.ts": { alice: 3 } },
      },
      reviewHistory: {
        "org/repo": {
          alice: [{ prNumber: 1, branch: "main", reviewedAt: "2026-01-01" }],
        },
      },
      openReviewLoad: { alice: 2, bob: 0 },
    });

    await expect(adapter.listOpenPullRequests("org/repo")).resolves.toEqual([pr]);
    await expect(adapter.getPullRequestFiles("org/repo", 7)).resolves.toEqual(pr.files);
    await expect(
      adapter.getCommitHistory("org/repo", ["src/a.ts"], "2026-01-01"),
    ).resolves.toEqual({ "src/a.ts": { alice: 3 } });
    await expect(adapter.getReviewHistory("org/repo", "2026-01-01")).resolves.toEqual({
      alice: [{ prNumber: 1, branch: "main", reviewedAt: "2026-01-01" }],
    });
    await expect(adapter.getOpenReviewLoad(["alice", "bob"])).resolves.toEqual({
      alice: 2,
      bob: 0,
    });

    await adapter.postComment("org/repo", 7, "rationale");
    await adapter.requestReviewers("org/repo", 7, ["alice"]);

    expect(adapter.comments).toEqual([
      { repo: "org/repo", prNumber: 7, body: "rationale" },
    ]);
    expect(adapter.reviewRequests).toEqual([
      { repo: "org/repo", prNumber: 7, logins: ["alice"] },
    ]);
  });
});

describe("MockJiraAdapter", () => {
  it("returns fixture issue data or an empty object", async () => {
    const adapter = new MockJiraAdapter({
      "RHCLOUD-1": jira({ estimate: 5, priority: "high", epic: "EPIC-1" }),
    });

    await expect(adapter.getIssueData("RHCLOUD-1")).resolves.toEqual({
      estimate: 5,
      priority: "high",
      epic: "EPIC-1",
    });
    await expect(adapter.getIssueData("UNKNOWN")).resolves.toEqual({});
  });
});

describe("MockSlackAdapter", () => {
  it("records messages and returns deterministic thread timestamps", async () => {
    const adapter = new MockSlackAdapter();

    const first = await adapter.postAssignment(undefined, "assigned alice");
    const second = await adapter.repostPending(first, "still pending");

    expect(first).toBe("assignment-1");
    expect(second).toBe("repost-2");
    expect(adapter.assignments).toEqual([
      { threadTs: undefined, text: "assigned alice", ts: "assignment-1" },
    ]);
    expect(adapter.reposts).toEqual([
      { threadTs: "assignment-1", text: "still pending", ts: "repost-2" },
    ]);
  });
});
