import { describe, expect, it } from "vitest";
import type { Assignment } from "../types.js";
import { computeMetrics, generateDashboard } from "./index.js";

function assignment(
  overrides: Partial<Assignment> & Pick<Assignment, "assignees" | "band">,
): Assignment {
  return {
    date: "2026-01-15",
    pr: 1,
    repo: "org/repo",
    difficulty: 0.3,
    rationale: "test rationale",
    candidates: ["alice:0.9"],
    ...overrides,
  };
}

describe("computeMetrics", () => {
  it("counts totalAssignments from the log length", () => {
    const assignments = [
      assignment({ assignees: ["alice"], band: "simple", pr: 1 }),
      assignment({ assignees: ["bob"], band: "moderate", pr: 2 }),
    ];

    expect(computeMetrics(assignments).totalAssignments).toBe(2);
  });

  it("counts each assignee on multi-assignee PRs separately", () => {
    const assignments = [
      assignment({ assignees: ["alice", "bob"], band: "simple", pr: 1 }),
      assignment({ assignees: ["alice"], band: "hard", pr: 2 }),
    ];

    const metrics = computeMetrics(assignments);

    expect(metrics.reviewsPerPerson).toEqual({
      alice: 2,
      bob: 1,
    });
  });

  it("counts activeReviewers as distinct assignee logins", () => {
    const assignments = [
      assignment({ assignees: ["alice", "bob"], band: "simple", pr: 1 }),
      assignment({ assignees: ["bob", "carol"], band: "moderate", pr: 2 }),
    ];

    expect(computeMetrics(assignments).activeReviewers).toBe(3);
  });

  it("always includes all three band keys, defaulting missing bands to 0", () => {
    const metrics = computeMetrics([
      assignment({ assignees: ["alice"], band: "simple", pr: 1 }),
      assignment({ assignees: ["bob"], band: "hard", pr: 2 }),
    ]);

    expect(metrics.bandDistribution).toEqual({
      simple: 1,
      moderate: 0,
      hard: 1,
    });
  });

  it("returns zeroed bandDistribution keys for an empty log", () => {
    expect(computeMetrics([]).bandDistribution).toEqual({
      simple: 0,
      moderate: 0,
      hard: 0,
    });
  });

  it("returns giniWork 0 for a single active reviewer", () => {
    const metrics = computeMetrics([
      assignment({ assignees: ["solo"], band: "simple", pr: 1 }),
      assignment({ assignees: ["solo"], band: "moderate", pr: 2 }),
    ]);

    expect(metrics.giniWork).toBe(0);
  });

  it("returns giniWork 0 for a perfectly even distribution", () => {
    const metrics = computeMetrics([
      assignment({ assignees: ["alice"], band: "simple", pr: 1 }),
      assignment({ assignees: ["bob"], band: "simple", pr: 2 }),
      assignment({ assignees: ["alice"], band: "moderate", pr: 3 }),
      assignment({ assignees: ["bob"], band: "hard", pr: 4 }),
    ]);

    expect(metrics.giniWork).toBe(0);
  });

  it("returns giniWork > 0 for a skewed distribution", () => {
    const metrics = computeMetrics([
      assignment({ assignees: ["alice"], band: "simple", pr: 1 }),
      assignment({ assignees: ["alice"], band: "simple", pr: 2 }),
      assignment({ assignees: ["alice"], band: "moderate", pr: 3 }),
      assignment({ assignees: ["bob"], band: "hard", pr: 4 }),
    ]);

    expect(metrics.giniWork).toBeGreaterThan(0);
  });

  it("keeps giniWork within [0, 1]", () => {
    const metrics = computeMetrics([
      assignment({ assignees: ["alice"], band: "simple", pr: 1 }),
      assignment({ assignees: ["alice"], band: "simple", pr: 2 }),
      assignment({ assignees: ["alice"], band: "moderate", pr: 3 }),
      assignment({ assignees: ["bob"], band: "hard", pr: 4 }),
      assignment({ assignees: ["carol"], band: "hard", pr: 5 }),
    ]);

    expect(metrics.giniWork).toBeGreaterThanOrEqual(0);
    expect(metrics.giniWork).toBeLessThanOrEqual(1);
  });

  it("returns giniWork 0 for an empty log", () => {
    expect(computeMetrics([]).giniWork).toBe(0);
  });
});

describe("generateDashboard", () => {
  const generatedAtIso = "2026-08-25T09:00:00.000Z";

  it("returns a complete HTML document with the dashboard title", () => {
    const html = generateDashboard({
      assignments: [assignment({ assignees: ["alice"], band: "simple", pr: 1 })],
      generatedAtIso,
    });

    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("Siara — Review Fairness Dashboard");
  });

  it("includes each active reviewer login", () => {
    const html = generateDashboard({
      assignments: [
        assignment({ assignees: ["alice", "bob"], band: "simple", pr: 1 }),
        assignment({ assignees: ["carol"], band: "moderate", pr: 2 }),
      ],
      generatedAtIso,
    });

    expect(html).toContain("alice");
    expect(html).toContain("bob");
    expect(html).toContain("carol");
  });

  it("includes the injected generatedAtIso timestamp", () => {
    const html = generateDashboard({
      assignments: [assignment({ assignees: ["alice"], band: "simple", pr: 1 })],
      generatedAtIso,
    });

    expect(html).toContain(generatedAtIso);
  });

  it("does not throw on an empty assignments array", () => {
    expect(() =>
      generateDashboard({ assignments: [], generatedAtIso }),
    ).not.toThrow();

    const html = generateDashboard({ assignments: [], generatedAtIso });
    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain(generatedAtIso);
  });

  it("escapes HTML in user-derived strings", () => {
    const html = generateDashboard({
      assignments: [
        assignment({
          assignees: ["<script>alert(1)</script>"],
          band: "simple",
          pr: 1,
          repo: "org/<evil>",
        }),
      ],
      generatedAtIso,
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
