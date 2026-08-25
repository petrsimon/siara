/**
 * Soft helpers: Jira estimate + priority. Additive biases on the ranked list.
 * High estimate → slight expert boost. High priority → expert boost and/or
 * load protection. Never reclassifies the difficulty band.
 *
 * TODO(composer): implement.
 */
import type { ResolvedConfig } from "../config.js";
import type { JiraData, ScoredCandidate } from "../types.js";

/** Mutates/returns candidates with soft boosts folded into `boosts`. */
export function applySoftBoosts(
  _ranked: ScoredCandidate[],
  _jira: JiraData | undefined,
  _config: ResolvedConfig,
): ScoredCandidate[] {
  throw new Error("not implemented");
}
