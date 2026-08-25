import { describe, expect, it } from "vitest";
import { scoreFilesAtRisk } from "./filesAtRisk.js";
import { candidate, file, testConfig } from "./fixtures.js";

describe("scoreFilesAtRisk", () => {
  const config = testConfig();

  it("flags bus-factor-1 files and boosts non-owners", () => {
    const files = [file("src/risky.ts")];
    const result = scoreFilesAtRisk(
      [
        candidate("owner", {
          commitsByPath: { "src/risky.ts": 3 },
        }),
        candidate("learner"),
        candidate("also-learner", {
          commitsByPath: { "src/other.ts": 1 },
        }),
      ],
      files,
      config,
    );

    expect(result.atRiskCount).toBe(1);
    expect(result.boosts.owner).toBe(0);
    expect(result.boosts.learner).toBe(config.filesAtRisk.spreadBoost);
    expect(result.boosts["also-learner"]).toBe(config.filesAtRisk.spreadBoost);
  });

  it("does not count files known by nobody as at-risk", () => {
    const result = scoreFilesAtRisk(
      [candidate("alice"), candidate("bob")],
      [file("src/unknown.ts")],
      config,
    );

    expect(result.atRiskCount).toBe(0);
    expect(result.boosts.alice).toBe(0);
    expect(result.boosts.bob).toBe(0);
  });

  it("does not count files known by many as at-risk", () => {
    const result = scoreFilesAtRisk(
      [
        candidate("alice", {
          commitsByPath: { "src/shared.ts": 2 },
        }),
        candidate("bob", {
          reviewsByPath: { "src/shared.ts": 1 },
        }),
      ],
      [file("src/shared.ts")],
      config,
    );

    expect(result.atRiskCount).toBe(0);
    expect(result.boosts.alice).toBe(0);
    expect(result.boosts.bob).toBe(0);
  });

  it("treats review-only knowledge as ownership", () => {
    const result = scoreFilesAtRisk(
      [
        candidate("reviewer", {
          reviewsByPath: { "src/reviewed.ts": 1 },
        }),
        candidate("learner"),
      ],
      [file("src/reviewed.ts")],
      config,
    );

    expect(result.atRiskCount).toBe(1);
    expect(result.boosts.reviewer).toBe(0);
    expect(result.boosts.learner).toBe(config.filesAtRisk.spreadBoost);
  });

  it("gives owners of one at-risk file zero boost even if other files exist", () => {
    const result = scoreFilesAtRisk(
      [
        candidate("owner-a", {
          commitsByPath: { "src/a.ts": 1 },
        }),
        candidate("owner-b", {
          commitsByPath: { "src/b.ts": 1 },
        }),
        candidate("spread"),
      ],
      [file("src/a.ts"), file("src/b.ts")],
      config,
    );

    expect(result.atRiskCount).toBe(2);
    expect(result.boosts["owner-a"]).toBe(0);
    expect(result.boosts["owner-b"]).toBe(0);
    expect(result.boosts.spread).toBe(config.filesAtRisk.spreadBoost);
  });
});
