/**
 * Dashboard contract. Generates a static HTML site (GitHub Pages) from the
 * append-only assignment log. Pure: takes data in, returns an HTML string —
 * no file I/O, no clock (generatedAtIso injected).
 *
 * Implementation lives in ./generate.ts. This file is the LOCKED contract.
 */
import type {
  Assignment,
  DifficultyBand,
  OpenPrsSnapshot,
  Override,
  ResponseTimeReport,
} from "../types.js";
import { renderDashboardHtml } from "./generate.js";
import { buildMetrics } from "./metrics.js";

export interface DashboardInput {
  assignments: Assignment[];
  /** Manual reviewer changes observed after auto-assignment. */
  overrides?: Override[];
  /** Latest point-in-time open-PRs snapshot — powers the PR-age overview and
   *  per-reviewer waiting stats. Optional (older logs predate snapshots). */
  openPrs?: OpenPrsSnapshot;
  /** Latest review-latency report — powers per-reviewer responsiveness stats.
   *  Optional (older logs predate it). */
  responseTimes?: ResponseTimeReport;
  /** Reviewer directory (login → real name / email) for display + tooltips.
   *  Loaded from siara.config.json; absent → logins shown verbatim. */
  reviewers?: Record<string, { name?: string; email?: string }>;
  /** Age → colour thresholds (days). Loaded from config; absent → defaults. */
  staleness?: { warningDays: number; overdueDays: number };
  /** ISO timestamp for the "generated at" footer — injected for determinism. */
  generatedAtIso: string;
}

/** Fairness + engagement metrics computed from the assignment log. */
export interface DashboardMetrics {
  totalAssignments: number;
  /** Assignments per reviewer login. */
  reviewsPerPerson: Record<string, number>;
  /** GiniWork: load Gini coefficient 0 (even) – 1 (one person does everything). */
  giniWork: number;
  /** Count of assignments per difficulty band. */
  bandDistribution: Record<DifficultyBand, number>;
  /** Per-reviewer assignment counts split by difficulty band (fairness: who
   *  carries the hard reviews, not just how many). */
  bandByPerson: Record<string, Record<DifficultyBand, number>>;
  /** Assignment volume per ISO week (Monday start "YYYY-MM-DD"), oldest first —
   *  the engagement trend line. */
  weeklyTrend: { week: string; count: number }[];
  /** Per-reviewer assignment counts per ISO week — the activity heatmap
   *  (reviewer × week). Weeks match `weeklyTrend`. */
  weekByPerson: Record<string, Record<string, number>>;
  /** Distinct reviewers who received at least one assignment. */
  activeReviewers: number;
  /** Distinct PRs Siara assigned (denominator for acceptance). */
  assignedPrs: number;
  /** Distinct assigned PRs whose reviewers were later manually changed. */
  overriddenPrs: number;
  /** Share of assigned PRs whose suggestion stuck (1 = all accepted). */
  acceptanceRate: number;
}

/** Compute metrics from the assignment + override logs. Pure. */
export function computeMetrics(
  assignments: Assignment[],
  overrides: Override[] = [],
): DashboardMetrics {
  return buildMetrics(assignments, overrides);
}

/** Render the full static dashboard HTML. Pure. */
export function generateDashboard(input: DashboardInput): string {
  return renderDashboardHtml(input);
}
