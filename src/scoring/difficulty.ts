/**
 * Difficulty scorer: continuous 0–1 score from diff shape, mapped to 3 bands.
 *
 *   difficultyScore = w.churn * normChurn + w.files * normFiles + w.spread * normSpread
 *
 * All three terms are normalized to 0–1 BEFORE weighting so the weights are
 * directly comparable and don't drift by repo.
 */
import type { ResolvedConfig } from "../config.js";
import type { DifficultyResult, FileChange } from "../types.js";
import { distinctDirs } from "../util/paths.js";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreDifficulty(
  files: FileChange[],
  config: ResolvedConfig,
): DifficultyResult {
  const filesChanged = files.length;

  if (filesChanged === 0) {
    return {
      score: 0,
      band: "simple",
      components: { normChurn: 0, normFiles: 0, normSpread: 0 },
      raw: { totalChurn: 0, filesChanged: 0, directoriesTouched: 0 },
    };
  }

  const { perFileChurnCap, churn, files: filesCeiling, spread } =
    config.difficultyCeilings;

  const totalChurn = files.reduce((sum, file) => {
    const fileChurn = Math.max(file.additions, file.deletions);
    return sum + Math.min(fileChurn, perFileChurnCap);
  }, 0);

  const directoriesTouched = distinctDirs(files.map((f) => f.path)).length;

  const normChurn = clamp01(totalChurn / churn);
  const normFiles = clamp01(
    Math.log(1 + filesChanged) / Math.log(1 + filesCeiling),
  );
  const normSpread = clamp01(directoriesTouched / spread);

  const { churn: wChurn, files: wFiles, spread: wSpread } =
    config.difficulty.weights;

  const score = clamp01(
    wChurn * normChurn + wFiles * normFiles + wSpread * normSpread,
  );

  const { simple, hard } = config.difficulty.bands;
  let band: DifficultyResult["band"];
  if (score < simple) {
    band = "simple";
  } else if (score < hard) {
    band = "moderate";
  } else {
    band = "hard";
  }

  return {
    score,
    band,
    components: { normChurn, normFiles, normSpread },
    raw: { totalChurn, filesChanged, directoriesTouched },
  };
}
