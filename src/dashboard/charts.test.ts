import { describe, it, expect } from "vitest";
import { renderAgeDistribution, renderDifficultyAgeScatter } from "./charts.js";
import type { OpenPrSnapshot } from "../types.js";

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
});
