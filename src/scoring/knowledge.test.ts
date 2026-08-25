import { describe, expect, it } from "vitest";
import { scoreKnowledge } from "./knowledge.js";
import { candidate, file, testConfig } from "./fixtures.js";

describe("scoreKnowledge", () => {
  const config = testConfig();
  const files = [
    file("src/auth/login.ts"),
    file("src/auth/session.ts"),
  ];

  it("ranks deeper commit history above light reviewers", () => {
    const scores = scoreKnowledge(
      [
        candidate("reviewer", {
          repoReviewCount: 2,
          reviewsByPath: { "src/auth/login.ts": 1 },
        }),
        candidate("expert", {
          commitsByPath: {
            "src/auth/login.ts": 8,
            "src/auth": 4,
          },
          repoReviewCount: 1,
        }),
        candidate("stranger"),
      ],
      files,
      config,
    );

    expect(scores.expert).toBe(1);
    expect(scores.reviewer).toBeGreaterThan(scores.stranger!);
    expect(scores.reviewer).toBeLessThan(scores.expert!);
  });

  it("normalizes to 0 when the whole pool has no history", () => {
    const scores = scoreKnowledge(
      [candidate("alice"), candidate("bob")],
      files,
      config,
    );

    expect(scores.alice).toBe(0);
    expect(scores.bob).toBe(0);
  });

  it("weights commits more heavily than reviews alone", () => {
    const commitOnly = scoreKnowledge(
      [candidate("commits", { commitsByPath: { "src/auth/login.ts": 5 } })],
      files,
      config,
    );
    const reviewOnly = scoreKnowledge(
      [
        candidate("reviews", {
          repoReviewCount: 5,
          reviewsByPath: { "src/auth/login.ts": 5 },
        }),
      ],
      files,
      config,
    );

    // Single-candidate pools normalize to 1; compare raw ordering via two-candidate pool.
    const combined = scoreKnowledge(
      [
        candidate("commits", { commitsByPath: { "src/auth/login.ts": 5 } }),
        candidate("reviews", {
          repoReviewCount: 5,
          reviewsByPath: { "src/auth/login.ts": 5 },
        }),
      ],
      files,
      config,
    );

    expect(combined.commits).toBeGreaterThan(combined.reviews!);
    expect(commitOnly.commits).toBe(1);
    expect(reviewOnly.reviews).toBe(1);
  });
});
