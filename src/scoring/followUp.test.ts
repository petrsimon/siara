import { describe, expect, it } from "vitest";
import { scoreFollowUp } from "./followUp.js";
import { candidate, jira, pullRequest, testConfig } from "./fixtures.js";

describe("scoreFollowUp", () => {
  const config = testConfig();
  const nowIso = "2026-08-25T12:00:00.000Z";
  const pr = pullRequest({ branch: "feat/auth-login" });

  it("boosts when a recent review shares the branch family", () => {
    const scores = scoreFollowUp(
      [
        candidate("alice", {
          recentReviews: [
            {
              prNumber: 90,
              branch: "feat/auth-session",
              reviewedAt: "2026-08-20T10:00:00.000Z",
            },
          ],
        }),
      ],
      pr,
      undefined,
      config,
      nowIso,
    );

    expect(scores.alice).toBe(config.followUpAffinity.branchFamilyBoost);
  });

  it("boosts when a recent review shares the Jira epic", () => {
    const scores = scoreFollowUp(
      [
        candidate("bob", {
          recentReviews: [
            {
              prNumber: 91,
              branch: "fix/unrelated",
              jiraEpic: "EPIC-100",
              reviewedAt: "2026-08-22T10:00:00.000Z",
            },
          ],
        }),
      ],
      pr,
      jira({ epic: "EPIC-100" }),
      config,
      nowIso,
    );

    expect(scores.bob).toBe(config.followUpAffinity.epicBoost);
  });

  it("does not boost reviews outside the affinity window", () => {
    const scores = scoreFollowUp(
      [
        candidate("carol", {
          recentReviews: [
            {
              prNumber: 80,
              branch: "feat/auth-session",
              reviewedAt: "2026-07-01T10:00:00.000Z",
            },
          ],
        }),
      ],
      pr,
      jira({ epic: "EPIC-100" }),
      config,
      nowIso,
    );

    expect(scores.carol).toBe(0);
  });

  it("applies diminishing returns when multiple related reviews stack", () => {
    const { branchFamilyBoost } = config.followUpAffinity;
    const scores = scoreFollowUp(
      [
        candidate("alice", {
          recentReviews: [
            {
              prNumber: 90,
              branch: "feat/auth-session",
              reviewedAt: "2026-08-20T10:00:00.000Z",
            },
            {
              prNumber: 91,
              branch: "feat/auth-settings",
              reviewedAt: "2026-08-21T10:00:00.000Z",
            },
            {
              prNumber: 92,
              branch: "feat/auth-logout",
              reviewedAt: "2026-08-22T10:00:00.000Z",
            },
          ],
        }),
      ],
      pr,
      undefined,
      config,
      nowIso,
    );

    const expected =
      branchFamilyBoost +
      branchFamilyBoost * 0.5 +
      branchFamilyBoost * 0.25;

    expect(scores.alice).toBeCloseTo(expected);
    expect(scores.alice).toBeLessThan(branchFamilyBoost * 3);
  });

  it("stacks branch and epic boosts independently with diminishing returns", () => {
    const { branchFamilyBoost, epicBoost } = config.followUpAffinity;
    const scores = scoreFollowUp(
      [
        candidate("alice", {
          recentReviews: [
            {
              prNumber: 90,
              branch: "feat/auth-session",
              jiraEpic: "EPIC-100",
              reviewedAt: "2026-08-20T10:00:00.000Z",
            },
            {
              prNumber: 91,
              branch: "feat/auth-settings",
              jiraEpic: "EPIC-100",
              reviewedAt: "2026-08-21T10:00:00.000Z",
            },
          ],
        }),
      ],
      pr,
      jira({ epic: "EPIC-100" }),
      config,
      nowIso,
    );

    const expected =
      branchFamilyBoost +
      branchFamilyBoost * 0.5 +
      epicBoost +
      epicBoost * 0.5;

    expect(scores.alice).toBeCloseTo(expected);
  });
});
