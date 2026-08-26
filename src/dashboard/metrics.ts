import type { Assignment, DifficultyBand, Override, ReviewResponse } from "../types.js";
import type { DashboardMetrics } from "./index.js";
import { computeGini } from "./gini.js";

const prKey = (repo: string, pr: number): string => `${repo}#${pr}`;

/**
 * Assignment rows for the History chart: one entry per PR (last log row wins),
 * plus GitHub review-request rows from the response report for merged PRs that
 * never landed in the Siara log.
 */
export function historyAssignments(
  assignments: Assignment[],
  responses: ReviewResponse[] = [],
): Assignment[] {
  const byPr = new Map<string, Assignment>();
  for (const a of assignments) {
    byPr.set(prKey(a.repo, a.pr), a);
  }

  const grouped = new Map<string, ReviewResponse[]>();
  for (const r of responses) {
    const key = prKey(r.repo, r.pr);
    const list = grouped.get(key) ?? [];
    list.push(r);
    grouped.set(key, list);
  }

  for (const [key, rows] of grouped) {
    if (byPr.has(key)) continue;
    const slash = key.indexOf("#");
    const repo = key.slice(0, slash);
    const pr = Number(key.slice(slash + 1));
    const assignees = [...new Set(rows.map((r) => r.reviewer))].sort();
    const earliest = rows.map((r) => r.assignedAt).sort()[0];
    byPr.set(key, {
      date: earliest?.slice(0, 10) ?? "",
      repo,
      pr,
      assignees,
      difficulty: 0,
      band: "moderate",
      rationale: "",
      candidates: [],
    });
  }

  return [...byPr.values()];
}

export function buildMetrics(
  assignments: Assignment[],
  overrides: Override[] = [],
): DashboardMetrics {
  const reviewsPerPerson: Record<string, number> = {};
  const bandByPerson: Record<string, Record<DifficultyBand, number>> = {};
  const weekByPerson: Record<string, Record<string, number>> = {};
  const weekCounts: Record<string, number> = {};
  const bandDistribution: Record<DifficultyBand, number> = {
    simple: 0,
    moderate: 0,
    hard: 0,
  };

  const assignedPrKeys = new Set<string>();
  for (const assignment of assignments) {
    bandDistribution[assignment.band] += 1;
    assignedPrKeys.add(`${assignment.repo}#${assignment.pr}`);
    const week = weekStart(assignment.date);
    if (week) weekCounts[week] = (weekCounts[week] ?? 0) + 1;
    for (const assignee of assignment.assignees) {
      reviewsPerPerson[assignee] = (reviewsPerPerson[assignee] ?? 0) + 1;
      const byBand = (bandByPerson[assignee] ??= { simple: 0, moderate: 0, hard: 0 });
      byBand[assignment.band] += 1;
      if (week) {
        const byWeek = (weekByPerson[assignee] ??= {});
        byWeek[week] = (byWeek[week] ?? 0) + 1;
      }
    }
  }

  const weeklyTrend = Object.entries(weekCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, count]) => ({ week, count }));

  // Only count overrides on PRs Siara actually assigned (its suggestions are the
  // acceptance denominator); ignore any stray override rows.
  const overriddenPrKeys = new Set<string>();
  for (const o of overrides) {
    const key = `${o.repo}#${o.pr}`;
    if (assignedPrKeys.has(key)) {
      overriddenPrKeys.add(key);
    }
  }

  const loads = Object.values(reviewsPerPerson);
  const assignedPrs = assignedPrKeys.size;
  const overriddenPrs = overriddenPrKeys.size;
  const acceptanceRate =
    assignedPrs > 0 ? (assignedPrs - overriddenPrs) / assignedPrs : 1;

  return {
    totalAssignments: assignments.length,
    reviewsPerPerson,
    giniWork: computeGini(loads),
    bandDistribution,
    activeReviewers: loads.length,
    bandByPerson,
    weeklyTrend,
    weekByPerson,
    assignedPrs,
    overriddenPrs,
    acceptanceRate,
  };
}

/**
 * Monday (UTC) of the ISO week containing `date` ("YYYY-MM-DD"), as "YYYY-MM-DD".
 * Returns "" for an unparseable date so a bad log row never breaks the trend.
 */
function weekStart(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const backToMonday = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - backToMonday);
  return d.toISOString().slice(0, 10);
}
