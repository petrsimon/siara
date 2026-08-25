/**
 * Availability penalty — how much to *reduce* a candidate's score because they
 * have little capacity to review right now. Folds three signals into one soft,
 * deterministic penalty applied before the final sort:
 *
 *   - open review load (already-assigned reviews),
 *   - jira/manual "heads-down" busy weight,
 *   - manager role (managers shouldn't carry moderate/hard reviews).
 *
 * Scaled by band: it barely matters for simple education-track PRs and dominates
 * for hard ones. Never an exclusion — a manager who is the sole expert still
 * wins, because this only subtracts from an otherwise-high knowledge score.
 */
import type { ReviewerProps, SiaraTeamConfig } from "../config.js";
import type { DifficultyBand } from "../types.js";

/**
 * Is a reviewer unavailable (PTO / don't-assign) *right now*? Resolved live
 * against `nowIso` so a time-boxed `until` auto-expires without an admin edit.
 * `until` is inclusive — the last day off — so unavailability clears the day
 * after. An unparseable `until` is treated as no expiry (stays unavailable).
 */
export function isReviewerUnavailable(
  props: ReviewerProps | undefined,
  nowIso: string,
): boolean {
  if (!props?.unavailable) return false;
  if (!props.until) return true;
  const today = nowIso.slice(0, 10); // "YYYY-MM-DD", lexicographically comparable
  return today <= props.until;
}

/** Manager penalty component for a band (0 for simple, config for moderate/hard). */
function managerPenalty(
  isManager: boolean,
  band: DifficultyBand,
  cfg: SiaraTeamConfig["availability"],
): number {
  if (!isManager) {
    return 0;
  }
  if (band === "hard") {
    return cfg.managerHardPenalty;
  }
  if (band === "moderate") {
    return cfg.managerModeratePenalty;
  }
  return 0;
}

/**
 * The availability penalty (>= 0) to subtract from a candidate's score. Returns
 * a non-negative magnitude; the caller subtracts it (stored as a negative boost).
 */
export function availabilityPenalty(params: {
  login: string;
  band: DifficultyBand;
  openReviewLoad: number;
  jiraBusy: number;
  /** PTO / don't-assign — adds a flat, band-independent strong-soft penalty. */
  unavailable?: boolean;
  team: Pick<SiaraTeamConfig, "managers" | "availability">;
}): number {
  const { login, band, openReviewLoad, jiraBusy, unavailable, team } = params;
  const cfg = team.availability;
  const bandWeight = cfg.bandWeight[band];
  const isManager = team.managers.includes(login);

  const raw =
    cfg.loadWeight * Math.max(0, openReviewLoad) +
    cfg.busyWeight * Math.max(0, jiraBusy) +
    managerPenalty(isManager, band, cfg);

  // Load/busy/manager scale by band; PTO does not — it should bite even on a
  // simple education-track PR (you can't route to someone who's out).
  return bandWeight * raw + (unavailable ? cfg.unavailablePenalty : 0);
}
