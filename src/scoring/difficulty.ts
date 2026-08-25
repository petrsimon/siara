/**
 * Difficulty scorer: continuous 0–1 score from diff shape, mapped to 3 bands.
 *
 *   difficultyScore = w.churn * normChurn + w.files * normFiles + w.spread * normSpread
 *
 * All three terms are normalized to 0–1 BEFORE weighting so the weights are
 * directly comparable and don't drift by repo.
 *
 * Path-risk weighting (risk ≠ size): per-file churn is multiplied by a path-risk
 * multiplier BEFORE aggregation, so a tiny change to high-risk code (auth,
 * crypto, migrations) scores harder than its raw size. Independently, touching a
 * high-risk path floors the band (see config.pathRisk.bandFloor) so the
 * education path never routes a small-but-dangerous diff to a stranger.
 */
import type { PathRiskRule, ResolvedConfig } from "../config.js";
import type { DifficultyBand, DifficultyResult, FileChange } from "../types.js";
import { distinctDirs, matchGlob } from "../util/paths.js";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const BAND_RANK: Record<DifficultyBand, number> = {
  simple: 0,
  moderate: 1,
  hard: 2,
};

/** First matching rule for a path (or undefined when risk-neutral). */
function matchRule(
  path: string,
  rules: PathRiskRule[],
): PathRiskRule | undefined {
  return rules.find((rule) => matchGlob(path, rule.pattern));
}

function bandFromScore(score: number, simple: number, hard: number): DifficultyBand {
  if (score < simple) return "simple";
  if (score < hard) return "moderate";
  return "hard";
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
      raw: { totalChurn: 0, baseChurn: 0, filesChanged: 0, directoriesTouched: 0 },
      pathRisk: { matched: [], maxMultiplier: 1, bandFloored: false, sizeBand: "simple" },
    };
  }

  const { perFileChurnCap, churn, files: filesCeiling, spread } =
    config.difficultyCeilings;
  const { rules, bandFloorMultiplier, bandFloor } = config.pathRisk;

  let baseChurn = 0;
  let totalChurn = 0;
  let maxMultiplier = 1;
  const matched: DifficultyResult["pathRisk"]["matched"] = [];

  for (const file of files) {
    const cappedChurn = Math.min(
      Math.max(file.additions, file.deletions),
      perFileChurnCap,
    );
    baseChurn += cappedChurn;

    const rule = matchRule(file.path, rules);
    const multiplier = rule ? rule.multiplier : 1;
    totalChurn += cappedChurn * multiplier;

    if (rule && multiplier > 1) {
      matched.push({ path: file.path, multiplier, label: rule.label });
      if (multiplier > maxMultiplier) maxMultiplier = multiplier;
    }
  }

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
  const sizeBand = bandFromScore(score, simple, hard);

  // Floor the band when a high-risk path is touched, so a "simple"-by-size
  // change to risky code still routes through knowledge, not education.
  let band = sizeBand;
  let bandFloored = false;
  if (
    maxMultiplier >= bandFloorMultiplier &&
    BAND_RANK[band] < BAND_RANK[bandFloor]
  ) {
    band = bandFloor;
    bandFloored = true;
  }

  return {
    score,
    band,
    components: { normChurn, normFiles, normSpread },
    raw: { totalChurn, baseChurn, filesChanged, directoriesTouched },
    pathRisk: { matched, maxMultiplier, bandFloored, sizeBand },
  };
}
