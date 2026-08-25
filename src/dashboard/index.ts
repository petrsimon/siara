/**
 * Dashboard contract. Generates a static HTML site (GitHub Pages) from the
 * append-only assignment log. Pure: takes data in, returns an HTML string —
 * no file I/O, no clock (generatedAtIso injected).
 *
 * Implementation lives in ./generate.ts. This file is the LOCKED contract.
 */
import type { Assignment, DifficultyBand } from "../types.js";
import { renderDashboardHtml } from "./generate.js";
import { buildMetrics } from "./metrics.js";

export interface DashboardInput {
  assignments: Assignment[];
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
  /** Distinct reviewers who received at least one assignment. */
  activeReviewers: number;
}

/** Compute metrics from the assignment log. Pure. */
export function computeMetrics(assignments: Assignment[]): DashboardMetrics {
  return buildMetrics(assignments);
}

/** Render the full static dashboard HTML. Pure. */
export function generateDashboard(input: DashboardInput): string {
  return renderDashboardHtml(input);
}
