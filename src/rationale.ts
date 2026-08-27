/**
 * Human-readable rationale for an assignment — posted as a GitHub PR comment
 * and logged (structured) to assignments.jsonl. Pure string building.
 */
import type { Assignment, DifficultyResult, ScoredCandidate } from "./types.js";
import type { PickResult } from "./scoring/pickReviewers.js";

/** Advisory for a genuinely simple PR with no path-risk signal (residual caveat). */
const SIMPLE_ADVISORY =
  "advisory: 'simple' is by diff size only — verify this isn't a small high-risk change no path-risk rule caught";

/** Summarize matched path-risk labels, e.g. "auth, migration". */
function riskLabels(d: DifficultyResult): string {
  const labels = new Set<string>();
  for (const m of d.pathRisk.matched) labels.add(m.label ?? "risky path");
  return [...labels].join(", ");
}

export interface RationaleInput {
  repo: string;
  prNumber: number;
  result: PickResult;
  /** ISO date "YYYY-MM-DD" for the log record. */
  date: string;
}

function difficultyLine(d: DifficultyResult): string {
  return `Difficulty: ${d.band} (score ${d.score.toFixed(2)}) — ${d.raw.filesChanged} files, ${d.raw.totalChurn} lines, ${d.raw.directoriesTouched} directories`;
}

function candidateLine(c: ScoredCandidate, finalScore: number): string {
  return `  - @${c.login}: ${finalScore.toFixed(2)} — ${c.notes.join("; ")}; ${c.openReviewLoad} open reviews`;
}

/** Build the full rationale string for the chosen reviewer(s). */
export function formatRationale(input: RationaleInput): string {
  const { repo, prNumber, result } = input;
  const { difficulty, ranked, assignees, atRiskCount, finalScoreByLogin } = result;

  const who = assignees.length ? assignees.map((a) => `@${a}`).join(", ") : "(no eligible reviewer)";
  const lines: string[] = [];
  lines.push(`Assigned ${who} to review PR #${prNumber} (${repo}):`);
  lines.push(`  ${difficultyLine(difficulty)}`);
  if (difficulty.pathRisk.matched.length > 0) {
    const labels = riskLabels(difficulty);
    if (difficulty.pathRisk.bandFloored) {
      lines.push(
        `  Path-risk: touches ${labels} — band raised from '${difficulty.pathRisk.sizeBand}' to '${difficulty.band}' (routed by knowledge, not education)`,
      );
    } else {
      lines.push(
        `  Path-risk: touches ${labels} — churn weighted up to ${difficulty.pathRisk.maxMultiplier}×`,
      );
    }
  } else if (difficulty.band === "simple") {
    lines.push(`  ${SIMPLE_ADVISORY}`);
  }
  if (atRiskCount > 0) {
    lines.push(`  Files-at-risk: ${atRiskCount} bus-factor-1 file(s) — spread boost applied to non-owners`);
  }
  for (const note of result.notes) {
    lines.push(`  ${note}`);
  }
  lines.push("  Ranked candidates:");
  for (const c of ranked) {
    lines.push(candidateLine(c, finalScoreByLogin[c.login] ?? 0));
  }
  return lines.join("\n");
}

/** Structured record appended to assignments.jsonl. */
export function toAssignment(input: RationaleInput): Assignment {
  const { repo, prNumber, result, date } = input;
  return {
    date,
    pr: prNumber,
    repo,
    assignees: result.assignees,
    difficulty: result.difficulty.score,
    band: result.difficulty.band,
    rationale: formatRationale(input),
    candidates: result.ranked.map(
      (c) => `${c.login}:${(result.finalScoreByLogin[c.login] ?? 0).toFixed(2)}`,
    ),
  };
}
