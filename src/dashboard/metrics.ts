import type {
  Assignment,
  DifficultyBand,
  OpenPrSnapshot,
  Override,
  ResponseTimeReport,
  ReviewAgePoint,
  ReviewResponse,
} from "../types.js";
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

/**
 * Build one review-lifecycle age point per PR. A PR is anchored at its earliest
 * recorded reviewer request; merged PRs end at merge, while open PRs end at
 * the response report timestamp. PRs without a known lifecycle endpoint are
 * omitted rather than falling back to GitHub creation age.
 */
export function buildReviewAgePoints(
  openPrs: OpenPrSnapshot[],
  report: ResponseTimeReport | undefined,
  assignments: Assignment[] = [],
): ReviewAgePoint[] {
  if (!report) return [];

  const openKeys = new Set(openPrs.map((pr) => prKey(pr.repo, pr.pr)));
  const bandByKey = new Map<string, DifficultyBand>();
  for (const pr of openPrs) {
    if (pr.band) bandByKey.set(prKey(pr.repo, pr.pr), pr.band);
  }
  for (const assignment of assignments) {
    bandByKey.set(prKey(assignment.repo, assignment.pr), assignment.band);
  }

  const grouped = new Map<string, ReviewResponse[]>();
  for (const response of report.responses) {
    const key = prKey(response.repo, response.pr);
    const rows = grouped.get(key) ?? [];
    rows.push(response);
    grouped.set(key, rows);
  }

  const reportAt = Date.parse(report.takenAt);
  const out: ReviewAgePoint[] = [];
  for (const [key, rows] of grouped) {
    const starts = rows
      .map((row) => Date.parse(row.assignedAt))
      .filter((at) => Number.isFinite(at));
    if (starts.length === 0) continue;

    const start = Math.min(...starts);
    const isOpen = openKeys.has(key);
    const mergedEnds = rows
      .map((row) => (row.mergedAt ? Date.parse(row.mergedAt) : NaN))
      .filter((at) => Number.isFinite(at));
    const end = isOpen ? reportAt : (mergedEnds.length > 0 ? Math.min(...mergedEnds) : NaN);
    if (!Number.isFinite(end) || end < start) continue;

    const [repo, prText] = key.split("#");
    if (!repo || !prText) continue;
    out.push({
      repo,
      pr: Number(prText),
      ageDays: (end - start) / (24 * 60 * 60 * 1000),
      ...(bandByKey.has(key) ? { band: bandByKey.get(key) } : {}),
      status: isOpen ? "open" : "merged",
    });
  }

  return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);
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
