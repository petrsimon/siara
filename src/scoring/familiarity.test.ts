import { describe, expect, it } from "vitest";
import { scoreFamiliarity } from "./familiarity.js";
import { scoreKnowledge } from "./knowledge.js";
import { candidate, file, testConfig } from "./fixtures.js";

describe("scoreFamiliarity", () => {
  const config = testConfig();
  const files = [file("src/auth/login.ts", 1, 0)];

  it("scores true strangers at 0", () => {
    const scores = scoreFamiliarity(
      [candidate("alice"), candidate("bob")],
      files,
      config,
    );

    expect(scores.alice).toBe(0);
    expect(scores.bob).toBe(0);
  });

  it("gives a small non-zero score for a trivial commit", () => {
    const scores = scoreFamiliarity(
      [
        candidate("stranger"),
        candidate("novice", {
          commitsByPath: { "src/auth/login.ts": 1 },
        }),
      ],
      files,
      config,
    );

    expect(scores.stranger).toBe(0);
    expect(scores.novice).toBeGreaterThan(0);
    expect(scores.novice).toBeLessThanOrEqual(1);
  });

  it("normalizes within the pool so the top candidate is 1", () => {
    const scores = scoreFamiliarity(
      [
        candidate("alice", {
          commitsByPath: { "src/auth/login.ts": 2 },
          repoReviewCount: 1,
        }),
        candidate("bob", {
          commitsByPath: { "src/auth/login.ts": 10 },
          repoReviewCount: 5,
        }),
      ],
      files,
      config,
    );

    expect(scores.bob).toBe(1);
    expect(scores.alice).toBeGreaterThan(0);
    expect(scores.alice).toBeLessThan(1);
  });

  it("counts commits on parent directories", () => {
    const scores = scoreFamiliarity(
      [
        candidate("alice", {
          commitsByPath: { "src/auth": 3 },
        }),
      ],
      files,
      config,
    );

    expect(scores.alice).toBe(1);
  });

  it("includes path-level reviews in reviewScore", () => {
    const scores = scoreFamiliarity(
      [
        candidate("alice", {
          repoReviewCount: 0,
          reviewsByPath: { "src/auth/login.ts": 2 },
        }),
      ],
      files,
      config,
    );

    expect(scores.alice).toBe(1);
  });

  it("ranks novice above stranger on knowledge but not familiarity cliff", () => {
    const pool = [
      candidate("stranger"),
      candidate("novice", {
        commitsByPath: { "src/auth/login.ts": 1 },
      }),
    ];

    const familiarity = scoreFamiliarity(pool, files, config);
    const knowledge = scoreKnowledge(pool, files, config);

    expect(familiarity.stranger).toBe(0);
    expect(familiarity.novice).toBe(1);
    expect(knowledge.stranger).toBe(0);
    expect(knowledge.novice).toBe(1);
  });
});
