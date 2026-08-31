import type { Assignment } from "./types.js";

/** True for synthetic rows that carry difficulty but are not Siara assignments. */
export function isHistoricalDifficultyAssignment(
  assignment: Assignment,
): boolean {
  return assignment.origin === "historical-difficulty-backfill";
}
