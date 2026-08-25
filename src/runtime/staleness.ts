import type { SiaraTeamConfig } from "../config.js";
import type { PullRequest } from "../types.js";
import { daysBetween } from "./dates.js";

export type StalenessLevel = "normal" | "warning" | "overdue";

export function stalenessLevel(
  ageDays: number,
  thresholds: SiaraTeamConfig["staleness"],
): StalenessLevel {
  if (ageDays >= thresholds.overdueDays) return "overdue";
  if (ageDays >= thresholds.warningDays) return "warning";
  return "normal";
}

export function stalenessMarker(level: StalenessLevel): string {
  switch (level) {
    case "overdue":
      return "🔴";
    case "warning":
      return "⚠️";
    case "normal":
      return "";
  }
}

export function formatRepostLine(input: {
  repo: string;
  prNumber: number;
  ageDays: number;
  assignee: string;
  level: StalenessLevel;
}): string {
  const marker = stalenessMarker(input.level);
  const status = input.level === "normal" ? "pending" : input.level;
  const markerSuffix = marker ? ` ${marker}` : "";
  return `PR #${input.prNumber} (${input.repo}) — ${input.ageDays}d ${status}${markerSuffix} — @${input.assignee}`;
}

/** Build repost text for open PRs that were previously posted to Slack. */
export function buildStalenessRepostText(
  prs: PullRequest[],
  nowIso: string,
  staleness: SiaraTeamConfig["staleness"],
  assigneeForPr: (pr: PullRequest) => string,
): string {
  const lines: string[] = [];
  for (const pr of prs) {
    if (!pr.postedAt) continue;
    const ageDays = daysBetween(pr.postedAt, nowIso);
    const level = stalenessLevel(ageDays, staleness);
    const assignee = assigneeForPr(pr);
    if (!assignee) continue;
    lines.push(
      formatRepostLine({
        repo: pr.repo,
        prNumber: pr.number,
        ageDays,
        assignee,
        level,
      }),
    );
  }
  return lines.join("\n");
}
