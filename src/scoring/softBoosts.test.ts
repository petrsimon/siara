import { describe, expect, it } from "vitest";
import { applySoftBoosts } from "./softBoosts.js";
import { jira, scored, testConfig } from "./fixtures.js";

describe("applySoftBoosts", () => {
  const config = testConfig();

  const pool = [
    scored("expert", { knowledge: 0.9, openReviewLoad: 1 }),
    scored("mid", { knowledge: 0.5, openReviewLoad: 2 }),
    scored("junior", { knowledge: 0.2, openReviewLoad: 4 }),
  ];

  it("is a no-op when jira data is missing", () => {
    const result = applySoftBoosts(pool, undefined, config);

    for (const c of result) {
      expect(c.boosts.softEstimate).toBe(0);
      expect(c.boosts.softPriority).toBe(0);
      expect(c.primaryScore).toBe(pool.find((p) => p.login === c.login)?.primaryScore);
    }
  });

  it("biases high-knowledge candidates when estimate is high", () => {
    const result = applySoftBoosts(pool, jira({ estimate: 8 }), config);

    const expert = result.find((c) => c.login === "expert")!;
    const mid = result.find((c) => c.login === "mid")!;
    const junior = result.find((c) => c.login === "junior")!;

    expect(expert.boosts.softEstimate).toBe(config.soft.estimateExpertBoost);
    expect(mid.boosts.softEstimate).toBe(config.soft.estimateExpertBoost);
    expect(junior.boosts.softEstimate).toBe(0);
    expect(expert.primaryScore).toBe(0.5);
  });

  it("applies priority expert boost and high-load penalty", () => {
    const result = applySoftBoosts(pool, jira({ priority: "high" }), config);

    const expert = result.find((c) => c.login === "expert")!;
    const junior = result.find((c) => c.login === "junior")!;

    expect(expert.boosts.softPriority).toBe(config.soft.priorityExpertBoost);
    expect(junior.boosts.softPriority).toBe(
      -config.soft.highPriorityLoadPenalty,
    );
  });

  it("treats blocker priority like high priority", () => {
    const result = applySoftBoosts(
      [scored("expert", { knowledge: 1, openReviewLoad: 5 })],
      jira({ priority: "blocker" }),
      config,
    );

    expect(result[0]!.boosts.softPriority).toBe(
      config.soft.priorityExpertBoost - config.soft.highPriorityLoadPenalty,
    );
  });

  it("skips estimate boost for low or missing estimates", () => {
    const low = applySoftBoosts(pool, jira({ estimate: 2 }), config);
    const missing = applySoftBoosts(pool, jira({}), config);

    for (const c of [...low, ...missing]) {
      expect(c.boosts.softEstimate).toBe(0);
    }
  });

  it("does not mutate primaryScore", () => {
    const input = [scored("expert", { knowledge: 1, primaryScore: 0.42 })];
    const result = applySoftBoosts(
      input,
      jira({ estimate: 10, priority: "high" }),
      config,
    );

    expect(result[0]!.primaryScore).toBe(0.42);
    expect(input[0]!.boosts.softEstimate).toBe(0);
  });
});
