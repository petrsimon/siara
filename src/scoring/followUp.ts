/**
 * Follow-up affinity boost: reward reviewer continuity on related work.
 * Signals: shared branch family, shared Jira epic, within windowDays.
 * Stacks with diminishing returns. Additive boost, never a gate.
 *
 * TODO(composer): implement.
 */
import type { ResolvedConfig } from "../config.js";
import type { CandidateHistory, JiraData, PullRequest } from "../types.js";

/** Returns additive follow-up boost per login (0 when no related work). */
export function scoreFollowUp(
  _candidates: CandidateHistory[],
  _pr: PullRequest,
  _jira: JiraData | undefined,
  _config: ResolvedConfig,
  _nowIso: string,
): Record<string, number> {
  throw new Error("not implemented");
}
