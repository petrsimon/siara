/**
 * Human-readable rationale for an assignment — posted as a GitHub PR comment
 * and logged (structured) to assignments.jsonl. Pure string building.
 */
import type { Assignment, DifficultyResult, ScoredCandidate } from "./types.js";
import type { PickResult } from "./scoring/pickReviewers.js";

/** Advisory note attached to simple-band picks (risk ≠ size caveat from plan). */
const SIMPLE_ADVISORY =
  "advisory: 'simple' is by diff size only — verify this isn't a small high-risk change (auth/crypto/migration)";

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
  if (difficulty.band === "simple") lines.push(`  ${SIMPLE_ADVISORY}`);
  if (atRiskCount > 0) {
    lines.push(`  Files-at-risk: ${atRiskCount} bus-factor-1 file(s) — spread boost applied to non-owners`);
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
