/**
 * Difficulty scorer: continuous 0–1 score from diff shape, mapped to 3 bands.
 *
 *   difficultyScore = w.churn * normChurn + w.files * normFiles + w.spread * normSpread
 *
 * All three terms are normalized to 0–1 BEFORE weighting so the weights are
 * directly comparable and don't drift by repo.
 *
 * TODO(composer): implement.
 */
import type { ResolvedConfig } from "../config.js";
import type { DifficultyResult, FileChange } from "../types.js";

export function scoreDifficulty(
  _files: FileChange[],
  _config: ResolvedConfig,
): DifficultyResult {
  throw new Error("not implemented");
}
