import type { Assignment, DifficultyBand } from "../types.js";
import type { DashboardMetrics } from "./index.js";
import { computeGini } from "./gini.js";

export function buildMetrics(assignments: Assignment[]): DashboardMetrics {
  const reviewsPerPerson: Record<string, number> = {};
  const bandDistribution: Record<DifficultyBand, number> = {
    simple: 0,
    moderate: 0,
    hard: 0,
  };

  for (const assignment of assignments) {
    bandDistribution[assignment.band] += 1;
    for (const assignee of assignment.assignees) {
      reviewsPerPerson[assignee] = (reviewsPerPerson[assignee] ?? 0) + 1;
    }
  }

  const loads = Object.values(reviewsPerPerson);

  return {
    totalAssignments: assignments.length,
    reviewsPerPerson,
    giniWork: computeGini(loads),
    bandDistribution,
    activeReviewers: loads.length,
  };
}
