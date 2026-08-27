import { describe, it, expect } from "vitest";
import { renderAgeDistribution, renderAuthorReviewerMergeMatrix, renderDifficultyAgeScatter, renderMergeTimeDistribution, renderRepoAgeDistribution } from "./charts.js";
import type { OpenPrSnapshot, ReviewResponse } from "../types.js";

function merged(
  reviewer: string,
  mergeHours: number,
  pr: number,
  author = "alice",
): ReviewResponse {
  return {
    repo: "org/repo",
    pr,
    reviewer,
    author,
    assignedAt: "2026-08-20T00:00:00.000Z",
    outstanding: false,
    mergedAt: "2026-09-01T00:00:00.000Z",
    mergeHours,
  };
}

describe("charts", () => {
  describe("renderAgeDistribution", () => {
    it("should render empty state when no PRs", () => {
      const html = renderAgeDistribution([]);
      expect(html).toContain("No open PRs with known age");
    });

    it("should render histogram with quartile markers", () => {
      const prs: OpenPrSnapshot[] = [
        { repo: "org/repo", pr: 1, title: "PR 1", author: "alice", assignees: [], ageDays: 1, band: "simple", staleness: "normal" },
        { repo: "org/repo", pr: 2, title: "PR 2", author: "bob", assignees: [], ageDays: 3, band: "moderate", staleness: "normal" },
        { repo: "org/repo", pr: 3, title: "PR 3", author: "carol", assignees: [], ageDays: 5, band: "hard", staleness: "warning" },
        { repo: "org/repo", pr: 4, title: "PR 4", author: "dave", assignees: [], ageDays: 7, band: "simple", staleness: "overdue" },
        { repo: "org/repo", pr: 5, title: "PR 5", author: "eve", assignees: [], ageDays: 10, band: "moderate", staleness: "overdue" },
      ];
      const html = renderAgeDistribution(prs);
      
      expect(html).toContain("PR age distribution");
      expect(html).toContain("All data");
      expect(html).toContain("Filtered");
      expect(html).toContain("Median");
      expect(html).toContain("Q1/Q3");
    });

    it("should detect and report outliers", () => {
      const prs: OpenPrSnapshot[] = [
        { repo: "org/repo", pr: 1, title: "PR 1", author: "alice", assignees: [], ageDays: 1, band: "simple", staleness: "normal" },
        { repo: "org/repo", pr: 2, title: "PR 2", author: "bob", assignees: [], ageDays: 2, band: "moderate", staleness: "normal" },
        { repo: "org/repo", pr: 3, title: "PR 3", author: "carol", assignees: [], ageDays: 3, band: "hard", staleness: "normal" },
        { repo: "org/repo", pr: 4, title: "PR 4", author: "dave", assignees: [], ageDays: 4, band: "simple", staleness: "normal" },
        { repo: "org/repo", pr: 5, title: "PR 5", author: "eve", assignees: [], ageDays: 100, band: "simple", staleness: "overdue" }, // extreme outlier
      ];
      const html = renderAgeDistribution(prs);
      
      expect(html).toMatch(/\d+ outliers? detected/);
      expect(html).toContain("100d");
    });
  });

  describe("renderRepoAgeDistribution", () => {
    it("should render empty state when no PRs have known age", () => {
      const html = renderRepoAgeDistribution([]);
      expect(html).toContain("No open PRs with known age by repository");
    });

    it("should render stacked age buckets grouped by repository", () => {
      const prs: OpenPrSnapshot[] = [
        { repo: "org/alpha", pr: 1, title: "PR 1", author: "alice", assignees: [], ageDays: 1, staleness: "normal" },
        { repo: "org/alpha", pr: 2, title: "PR 2", author: "bob", assignees: [], ageDays: 10, staleness: "warning" },
        { repo: "org/beta", pr: 3, title: "PR 3", author: "carol", assignees: [], ageDays: 45, staleness: "overdue" },
        { repo: "org/beta", pr: 4, title: "PR 4", author: "dave", assignees: [], ageDays: undefined, staleness: "normal" },
      ];
      const html = renderRepoAgeDistribution(prs);

      expect(html).toContain("PR age by repository");
      expect(html).toContain("alpha");
      expect(html).toContain("beta");
      expect(html).toContain("0-1d");
      expect(html).toContain("1-2w");
      expect(html).toContain("1-2mo");
      expect(html).toContain("Open PR age distribution by repository");
    });
  });

  describe("renderDifficultyAgeScatter", () => {
    it("should render empty state when no PRs", () => {
      const html = renderDifficultyAgeScatter([]);
      expect(html).toContain("No open PRs with difficulty and age data");
    });

    it("should render scatter plot with band-based positioning", () => {
      const prs: OpenPrSnapshot[] = [
        { repo: "org/repo", pr: 1, title: "PR 1", author: "alice", assignees: [], ageDays: 1, band: "simple", staleness: "normal" },
        { repo: "org/repo", pr: 2, title: "PR 2", author: "bob", assignees: [], ageDays: 5, band: "moderate", staleness: "warning" },
        { repo: "org/repo", pr: 3, title: "PR 3", author: "carol", assignees: [], ageDays: 10, band: "hard", staleness: "overdue" },
      ];
      const html = renderDifficultyAgeScatter(prs);
      
      expect(html).toContain("Difficulty × age");
      expect(html).toContain("Difficulty band");
      expect(html).toContain("Age (days)");
      expect(html).toContain("Simple");
      expect(html).toContain("Moderate");
      expect(html).toContain("Hard");
      expect(html).toContain("circle");
    });

    it("should skip PRs without age or band", () => {
      const prs: OpenPrSnapshot[] = [
        { repo: "org/repo", pr: 1, title: "PR 1", author: "alice", assignees: [], ageDays: undefined, band: "simple", staleness: "normal" },
        { repo: "org/repo", pr: 2, title: "PR 2", author: "bob", assignees: [], ageDays: 5, band: undefined, staleness: "normal" },
        { repo: "org/repo", pr: 3, title: "PR 3", author: "carol", assignees: [], ageDays: 10, band: "hard", staleness: "overdue" },
      ];
      const html = renderDifficultyAgeScatter(prs);
      
      // Should only render 1 point (PR 3)
      expect(html).toContain("circle");
      expect(html).not.toContain("No open PRs");
    });
  });

  describe("renderMergeTimeDistribution", () => {
    it("should render empty state when no merged PRs", () => {
      const html = renderMergeTimeDistribution([], {}, 90);
      expect(html).toContain("No merged PRs with a known review-request time in the last 90 days");
    });

    it("should render box plots for each reviewer", () => {
      const responses = [
        merged("bob", 5 * 24, 1),
        merged("bob", 10 * 24, 2),
        merged("bob", 15 * 24, 3),
        merged("carol", 2 * 24, 4),
      ];
      const dir = {
        bob: { name: "Bob Smith", email: "bob@example.com" },
        carol: { name: "Carol Jones", email: "carol@example.com" },
      };
      const html = renderMergeTimeDistribution(responses, dir);

      expect(html).toContain("Time to merge");
      expect(html).toContain("until the PR merged");
      expect(html).toContain("Bob Smith");
      expect(html).toContain("Carol Jones");
      expect(html).toContain("Box shows quartiles");
      expect(html).toContain("<rect");
    });

    it("should surface the window caveat", () => {
      const html = renderMergeTimeDistribution([merged("bob", 24, 1)], {}, 45);
      expect(html).toContain("last 45 days");
    });

    it("should show outliers as separate points", () => {
      const responses = [
        merged("bob", 1 * 24, 1),
        merged("bob", 2 * 24, 2),
        merged("bob", 3 * 24, 3),
        merged("bob", 4 * 24, 4),
        merged("bob", 100 * 24, 5),
      ];
      const html = renderMergeTimeDistribution(responses, {});

      expect(html).toContain("circle");
      expect(html).toContain("outlier");
      expect(html).toContain("100d (outlier)");
    });

    it("should sort reviewers by slowest median", () => {
      const responses = [
        merged("bob", 10 * 24, 1),
        merged("carol", 50 * 24, 2),
        merged("dave", 5 * 24, 3),
      ];
      const html = renderMergeTimeDistribution(responses, {});

      // Carol (50d) should appear before Bob (10d) and Dave (5d)
      const carolIdx = html.indexOf("carol");
      const bobIdx = html.indexOf("bob");
      const daveIdx = html.indexOf("dave");

      expect(carolIdx).toBeLessThan(bobIdx);
      expect(bobIdx).toBeLessThan(daveIdx);
    });

    it("should ignore responses without a merge time", () => {
      const responses: ReviewResponse[] = [
        {
          repo: "org/repo",
          pr: 1,
          reviewer: "bob",
          assignedAt: "2026-08-20T00:00:00.000Z",
          firstReviewAt: "2026-08-21T00:00:00.000Z",
          latencyHours: 24,
          outstanding: false,
        },
        {
          repo: "org/repo",
          pr: 2,
          reviewer: "carol",
          assignedAt: "2026-08-20T00:00:00.000Z",
          outstanding: true,
          waitingHours: 48,
        },
        merged("dave", 24, 3),
      ];
      const html = renderMergeTimeDistribution(responses, {});

      expect(html).toContain("dave");
      expect(html).not.toContain("bob");
      expect(html).not.toContain("carol");
    });
  });

  describe("renderAuthorReviewerMergeMatrix", () => {
    it("renders empty state when no merge data with authors", () => {
      const html = renderAuthorReviewerMergeMatrix([], {}, [], 90);
      expect(html).toContain("Author × reviewer time to merge");
      expect(html).toContain("No merged PRs with author");
    });

    it("renders a heatmap cell per author/reviewer pair", () => {
      const responses = [
        merged("bob", 5 * 24, 1, "alice"),
        merged("bob", 10 * 24, 2, "alice"),
        merged("carol", 3 * 24, 3, "dave"),
      ];
      const dir = {
        alice: { name: "Alice Cooper" },
        bob: { name: "Bob Smith" },
        carol: { name: "Carol Jones" },
        dave: { name: "Dave Evans" },
      };
      const html = renderAuthorReviewerMergeMatrix(responses, dir, [], 90);

      expect(html).toContain("Author × reviewer time to merge");
      expect(html).toContain("Alice Cooper");
      expect(html).toContain("Bob Smith");
      expect(html).toContain("Dave Evans");
      expect(html).toContain("7.5d");
      expect(html).toContain("3d");
    });

    it("falls back to open-PR snapshot authors when response rows omit author", () => {
      const responses = [
        {
          repo: "org/repo",
          pr: 9,
          reviewer: "bob",
          assignedAt: "2026-08-01T00:00:00.000Z",
          outstanding: false,
          mergedAt: "2026-08-06T00:00:00.000Z",
          mergeHours: 120,
        },
      ];
      const openPrs = [
        {
          repo: "org/repo",
          pr: 9,
          title: "x",
          author: "alice",
          assignees: ["bob"],
          staleness: "normal" as const,
        },
      ];
      const html = renderAuthorReviewerMergeMatrix(responses, {}, openPrs, 90);
      expect(html).toContain("5d");
      expect(html).not.toContain("No merged PRs");
    });
  });
});
