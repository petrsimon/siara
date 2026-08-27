import { describe, expect, it } from "vitest";
import type { Assignment, Override } from "../types.js";
import { computeMetrics, generateDashboard, historyAssignments } from "./index.js";

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

  it("reports full acceptance when there are no overrides", () => {
    const metrics = computeMetrics([
      assignment({ assignees: ["alice"], band: "simple", pr: 1 }),
      assignment({ assignees: ["bob"], band: "moderate", pr: 2 }),
    ]);
    expect(metrics.assignedPrs).toBe(2);
    expect(metrics.overriddenPrs).toBe(0);
    expect(metrics.acceptanceRate).toBe(1);
  });

  it("counts overridden PRs and lowers the acceptance rate", () => {
    const overrides: Override[] = [
      { seenAt: "2026-01-16", repo: "org/repo", pr: 1, suggested: ["alice"], actual: ["bob"] },
    ];
    const metrics = computeMetrics(
      [
        assignment({ assignees: ["alice"], band: "simple", pr: 1 }),
        assignment({ assignees: ["bob"], band: "moderate", pr: 2 }),
      ],
      overrides,
    );
    expect(metrics.overriddenPrs).toBe(1);
    expect(metrics.acceptanceRate).toBe(0.5);
  });

  it("ignores overrides for PRs Siara never assigned", () => {
    const overrides: Override[] = [
      { seenAt: "2026-01-16", repo: "org/repo", pr: 99, suggested: [], actual: ["bob"] },
    ];
    const metrics = computeMetrics(
      [assignment({ assignees: ["alice"], band: "simple", pr: 1 })],
      overrides,
    );
    expect(metrics.overriddenPrs).toBe(0);
    expect(metrics.acceptanceRate).toBe(1);
  });

  it("treats an empty log as full acceptance (no divide-by-zero)", () => {
    const metrics = computeMetrics([]);
    expect(metrics.assignedPrs).toBe(0);
    expect(metrics.acceptanceRate).toBe(1);
  });

  it("splits each reviewer's assignments by difficulty band", () => {
    const metrics = computeMetrics([
      assignment({ assignees: ["alice"], band: "simple", pr: 1 }),
      assignment({ assignees: ["alice"], band: "hard", pr: 2 }),
      assignment({ assignees: ["alice"], band: "hard", pr: 3 }),
      assignment({ assignees: ["bob"], band: "moderate", pr: 4 }),
    ]);
    expect(metrics.bandByPerson.alice).toEqual({ simple: 1, moderate: 0, hard: 2 });
    expect(metrics.bandByPerson.bob).toEqual({ simple: 0, moderate: 1, hard: 0 });
  });

  it("buckets assignments into ISO weeks (Monday start), oldest first", () => {
    const metrics = computeMetrics([
      // 2026-01-15 is a Thursday → week of Mon 2026-01-12.
      assignment({ assignees: ["alice"], band: "simple", pr: 1, date: "2026-01-15" }),
      assignment({ assignees: ["bob"], band: "simple", pr: 2, date: "2026-01-12" }),
      // 2026-01-19 is the next Monday → its own week.
      assignment({ assignees: ["carol"], band: "simple", pr: 3, date: "2026-01-19" }),
    ]);
    expect(metrics.weeklyTrend).toEqual([
      { week: "2026-01-12", count: 2 },
      { week: "2026-01-19", count: 1 },
    ]);
  });

  it("counts reviews per reviewer per week for the heatmap", () => {
    const metrics = computeMetrics([
      assignment({ assignees: ["alice"], band: "simple", pr: 1, date: "2026-01-12" }),
      assignment({ assignees: ["alice"], band: "hard", pr: 2, date: "2026-01-15" }),
      assignment({ assignees: ["bob"], band: "simple", pr: 3, date: "2026-01-19" }),
    ]);
    expect(metrics.weekByPerson.alice).toEqual({ "2026-01-12": 2 });
    expect(metrics.weekByPerson.bob).toEqual({ "2026-01-19": 1 });
  });
});

describe("historyAssignments", () => {
  it("dedupes the log to one row per PR (last wins)", () => {
    const rows = historyAssignments([
      assignment({ assignees: ["alice"], band: "simple", pr: 1, date: "2026-01-01" }),
      assignment({ assignees: ["bob"], band: "hard", pr: 1, date: "2026-01-15" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.assignees).toEqual(["bob"]);
    expect(rows[0]?.band).toBe("hard");
  });

  it("adds merged PRs from the response report when missing from the log", () => {
    const rows = historyAssignments(
      [assignment({ assignees: ["alice"], band: "simple", pr: 1 })],
      [
        {
          repo: "org/repo",
          pr: 99,
          reviewer: "carol",
          assignedAt: "2026-08-01T00:00:00.000Z",
          outstanding: false,
          mergedAt: "2026-08-10T00:00:00.000Z",
          mergeHours: 216,
        },
      ],
    );
    expect(rows).toHaveLength(2);
    const merged = rows.find((r) => r.pr === 99);
    expect(merged?.assignees).toEqual(["carol"]);
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

  it("renders the manual-override section with the acceptance KPI", () => {
    const html = generateDashboard({
      assignments: [assignment({ assignees: ["alice"], band: "hard", pr: 7 })],
      overrides: [
        { seenAt: "2026-08-24", repo: "org/repo", pr: 7, suggested: ["alice"], actual: ["bob"] },
      ],
      generatedAtIso,
    });

    expect(html).toContain("Suggestion acceptance");
    expect(html).toContain("Manual overrides");
    expect(html).toContain("org/repo#7");
    expect(html).toContain("0%");
  });

  it("renders SVG charts and a theme toggle for light/dark", () => {
    const html = generateDashboard({
      assignments: [
        assignment({ assignees: ["alice"], band: "hard", pr: 1 }),
        assignment({ assignees: ["bob"], band: "simple", pr: 2 }),
      ],
      generatedAtIso,
    });

    expect(html).toContain("<svg");
    expect(html).toContain('data-theme');
    expect(html).toContain('[data-theme="dark"]');
    expect(html).toContain("__toggleTheme");
    // Band segments are colour-keyed via CSS variables.
    expect(html).toContain("var(--band-hard)");
  });

  it("renders the activity heatmap and scrollable full-history charts", () => {
    const html = generateDashboard({
      assignments: [
        assignment({ assignees: ["alice"], band: "hard", pr: 1, date: "2026-01-12" }),
        assignment({ assignees: ["bob"], band: "simple", pr: 2, date: "2026-01-19" }),
      ],
      generatedAtIso,
    });
    expect(html).toContain("Reviewer × repo");
    expect(html).toContain("scroll-latest");
    expect(html).toContain("scrollLeft");
  });

  it("splits Open PRs into its own tab", () => {
    const html = generateDashboard({
      assignments: [assignment({ assignees: ["alice"], band: "simple", pr: 1 })],
      openPrs: {
        takenAt: "2026-08-25T09:00:00.000Z",
        prs: [
          {
            repo: "org/repo",
            pr: 1,
            title: "x",
            author: "a",
            assignees: ["alice"],
            ageDays: 1,
            band: "simple",
            staleness: "normal",
          },
        ],
      },
      generatedAtIso,
    });
    expect(html).toContain('class="tabs"');
    expect(html).toContain('data-tab="open-prs"');
    expect(html).toContain('id="tab-open-prs"');
    expect(html).toContain('id="tab-overview"');
    expect(html).not.toContain('data-tab="merge-matrix"');
    expect(html).not.toContain('id="tab-merge-matrix"');
  });

  it("makes reviewer names link to the Open PRs tab filtered by that reviewer", () => {
    const html = generateDashboard({
      assignments: [
        assignment({ assignees: ["alice"], band: "hard", pr: 1 }),
        assignment({ assignees: ["bob"], band: "simple", pr: 2 }),
      ],
      generatedAtIso,
    });
    // Reviewer name in the per-person chart carries a filter hook.
    expect(html).toContain('data-filter-login="alice"');
    expect(html).toContain("svg-link");
    // Click wiring: switch to the open-prs tab and seed its search box.
    expect(html).toContain("[data-filter-login]");
    expect(html).toContain('.table-search[data-target="open-prs-table"]');
  });

  it("shows reviewer real names with a login/email tooltip, falling back to login", () => {
    const html = generateDashboard({
      assignments: [
        assignment({ assignees: ["alice"], band: "hard", pr: 1 }),
        assignment({ assignees: ["bob"], band: "simple", pr: 2 }),
      ],
      reviewers: { alice: { name: "Alice Cooper", email: "alice@example.com" } },
      openPrs: {
        takenAt: "2026-08-25T09:00:00.000Z",
        prs: [
          {
            repo: "org/repo",
            pr: 1,
            title: "x",
            author: "a",
            assignees: ["alice"],
            ageDays: 1,
            band: "simple",
            staleness: "normal",
          },
        ],
      },
      generatedAtIso,
    });
    // Real name shown, nick + email in the tooltip.
    expect(html).toContain("Alice Cooper");
    expect(html).toContain('title="alice · alice@example.com"');
    // A reviewer with no directory entry falls back to the login.
    expect(html).toContain(">bob<");
    // The assignees cell keeps the login searchable via data-logins.
    expect(html).toContain('data-logins="alice"');
  });

  it("renders the Sankey flow with node counts", () => {
    const html = generateDashboard({
      assignments: [
        assignment({ assignees: ["alice"], band: "hard", pr: 1 }),
        assignment({ assignees: ["alice"], band: "simple", pr: 2 }),
        assignment({ assignees: ["very-long-reviewer-name"], band: "moderate", pr: 3 }),
      ],
      generatedAtIso,
    });
    // Sankey: band → reviewer flow with node counts and enough width for labels.
    expect(html).toContain("Assignment flow");
    expect(html).toContain("Ribbon thickness");
    expect(html).toContain('viewBox="0 0 759 200"');
    // The redundant flame-graph "Workload breakdown" was removed.
    expect(html).not.toContain("Workload breakdown");
  });

  it("renders the How-it-works doc with a pipeline diagram and live knobs", () => {
    const html = generateDashboard({
      assignments: [assignment({ assignees: ["alice"], band: "hard", pr: 1 })],
      algorithm: {
        reviewersPerPr: 1,
        bands: { simple: 0.3, hard: 0.6 },
        availability: {
          loadWeight: 0.12,
          busyWeight: 0.15,
          bandWeight: { simple: 0.6, moderate: 0.7, hard: 1.0 },
          hardWipLimit: 3,
          hardWipPenalty: 0.5,
          maxPenaltyFraction: 0.9,
        },
        followUpAffinity: { branchFamilyBoost: 0.4, epicBoost: 0.5, windowDays: 7 },
        filesAtRisk: { spreadBoost: 0.22 },
        soft: { estimateExpertBoost: 0.3, priorityExpertBoost: 0.4, highPriorityLoadPenalty: 0.5 },
        pathRisk: { labels: ["deployment", "schema"], bandFloorMultiplier: 2, bandFloor: "moderate" },
      },
      generatedAtIso,
    });
    // Its own tab + panel.
    expect(html).toContain('data-tab="how"');
    expect(html).toContain('id="tab-how"');
    expect(html).toContain("How it works");
    expect(html).toContain("<strong>siara</strong>");
    expect(html).not.toContain('data-tab="strategies"');
    expect(html).not.toContain("<h2>Strategy comparison</h2>");
    expect(html).toContain("Review assignments");
    expect(html).toContain("Continuity boosts");
    expect(html).toContain("Eligibility and decline handling");
    expect(html).toContain("deployment, schema");
    expect(html).toContain("0.4");
    expect(html).toContain("0.22");
    expect(html).toContain("0.3");
    // The pipeline diagram (arrow marker) and the WIP cap explained with live values.
    expect(html).toContain('id="arw"');
    expect(html).toContain('viewBox="0 0 640 160"');
    expect(html).toContain('width="132" height="58"');
    // Live knobs echoed (load weight + WIP limit), not hard-coded prose.
    expect(html).toContain("<code>0.12</code>");
    expect(html).toContain("<code>3</code>");
  });

  it("renders the open-PRs age overview and per-reviewer waiting stats", () => {
    const html = generateDashboard({
      assignments: [assignment({ assignees: ["bob"], band: "hard", pr: 7 })],
      openPrs: {
        takenAt: "2026-08-25T09:00:00.000Z",
        prs: [
          {
            repo: "org/repo",
            pr: 7,
            title: "Add auth guard",
            author: "alice",
            assignees: ["bob"],
            ageDays: 6,
            band: "hard",
            staleness: "overdue",
          },
        ],
      },
      generatedAtIso,
    });
    expect(html).toContain("Open PRs");
    expect(html).toContain("PR age by repository");
    expect(html).toContain("Add auth guard");
    expect(html).toContain("6d");
    expect(html).toContain("overdue");
    // PR cell is a link to the GitHub PR, shown as repo/number (not repo#number).
    expect(html).toContain('href="https://github.com/org/repo/pull/7"');
    expect(html).toContain(">repo/7</a>");
    expect(html).not.toContain("Time to merge");
    // Open-PRs table is sortable and searchable.
    expect(html).toContain('id="open-prs-table"');
    expect(html).toContain('class="sortable"');
    expect(html).toContain('class="table-search"');
    expect(html).toContain("localeCompare"); // client-side sort wiring
    // Difficulty/Age/Status carry numeric sort values.
    expect(html).toContain('data-val="2"'); // hard band rank / overdue rank
  });

  it("shows empty states for open-PRs sections without a snapshot", () => {
    const html = generateDashboard({
      assignments: [assignment({ assignees: ["alice"], band: "simple", pr: 1 })],
      generatedAtIso,
    });
    expect(html).toContain("No open PRs in the latest snapshot.");
    expect(html).not.toContain("Response time");
    expect(html).not.toContain("Time to merge");
  });

  it("combines current and history assignments in a tabbed section", () => {
    const html = generateDashboard({
      assignments: [
        assignment({ assignees: ["alice"], band: "hard", pr: 1 }),
        assignment({ assignees: ["bob"], band: "simple", pr: 2 }),
      ],
      openPrs: {
        takenAt: "2026-08-25T09:00:00.000Z",
        prs: [
          {
            repo: "org/repo",
            pr: 1,
            title: "x",
            author: "a",
            assignees: ["alice"],
            ageDays: 1,
            band: "hard",
            staleness: "normal",
          },
        ],
      },
      generatedAtIso,
    });
    expect(html).toContain("Review assignments");
    expect(html).toContain('data-subtab="assign-current"');
    expect(html).toContain('data-subtab="assign-history"');
    expect(html).toContain('id="assign-history"');
    expect(html).not.toContain("<h2>Current assignments</h2>");
    expect(html).not.toContain("<h2>Assignment history</h2>");
  });

  it("includes merged PRs from the response report in assignment history", () => {
    const html = generateDashboard({
      assignments: [assignment({ assignees: ["alice"], band: "simple", pr: 1 })],
      responseTimes: {
        takenAt: "2026-08-25T10:00:00.000Z",
        responses: [
          {
            repo: "org/repo",
            pr: 99,
            reviewer: "carol",
            assignedAt: "2026-08-01T00:00:00.000Z",
            outstanding: false,
            mergedAt: "2026-08-10T00:00:00.000Z",
            mergeHours: 216,
          },
        ],
      },
      generatedAtIso,
    });
    expect(html).toContain("carol");
    expect(html).toContain("merged PRs from GitHub");
  });

  it("shows PR difficulty metadata in the manual-override row", () => {
    const html = generateDashboard({
      assignments: [assignment({ assignees: ["alice"], band: "hard", pr: 7, difficulty: 0.72 })],
      overrides: [
        { seenAt: "2026-08-24", repo: "org/repo", pr: 7, suggested: ["alice"], actual: ["bob"] },
      ],
      generatedAtIso,
    });
    expect(html).toContain("<th>Difficulty</th>");
    expect(html).toContain("Hard");
    expect(html).toContain("0.72");
  });
});
