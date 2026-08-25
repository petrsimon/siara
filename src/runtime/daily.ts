/**
 * Daily run: sync → assign new PRs (comment + request review + Slack post +
 * JSONL append) → repost pending with age + assignee + staleness marker →
 * completed PRs dropped. Honors DailyOptions.dryRun (no side effects).
 */
import { resolveConfig } from "../config.js";
import { pickReviewers } from "../scoring/pickReviewers.js";
import { formatRationale, toAssignment } from "../rationale.js";
import type {
  Assignment,
  DifficultyBand,
  OpenPrSnapshot,
  Override,
  PullRequest,
} from "../types.js";
import { sync } from "./sync.js";
import { daysBetween } from "./dates.js";
import { buildStalenessRepostText, stalenessLevel } from "./staleness.js";
import type { DailyOptions, DailyPrResult, DailyResult, SiaraDeps } from "./index.js";

const prKey = (repo: string, pr: number): string => `${repo}#${pr}`;

/** Latest suggested-reviewer set Siara logged per PR (last write wins). */
function latestSuggestions(assignments: Assignment[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const a of assignments) {
    map.set(prKey(a.repo, a.pr), [...a.assignees].sort());
  }
  return map;
}

/** Latest difficulty band Siara logged per PR (last write wins). */
function latestBands(assignments: Assignment[]): Map<string, DifficultyBand> {
  const map = new Map<string, DifficultyBand>();
  for (const a of assignments) {
    map.set(prKey(a.repo, a.pr), a.band);
  }
  return map;
}

/** Latest observed actual-reviewer set per PR from the override log. */
function latestOverrideActuals(overrides: Override[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const o of overrides) {
    map.set(prKey(o.repo, o.pr), o.actual.join(","));
  }
  return map;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function findRepoConfig(
  deps: SiaraDeps,
  repo: string,
): ReturnType<typeof resolveConfig> {
  const repoConfig = deps.repoConfigs.find((config) => config.repo === repo);
  return resolveConfig(deps.teamConfig, repoConfig);
}

function assigneeLabel(pr: PullRequest): string {
  if (pr.requestedReviewers.length > 0) {
    return pr.requestedReviewers[0] ?? "";
  }
  return "";
}

export async function daily(
  deps: SiaraDeps,
  nowIso: string,
  opts: DailyOptions = {},
): Promise<DailyResult> {
  const dry = opts.dryRun === true;
  const synced = opts.noSync === true ? [] : await sync(deps, nowIso);
  const assigned: DailyPrResult[] = [];
  const assigneesByPr = new Map<string, string[]>();
  const pendingForRepost: PullRequest[] = [];
  // Point-in-time open-PRs snapshot rows, collected across all repos this run.
  const snapshotPrs: OpenPrSnapshot[] = [];

  // Manual-override tracking: what Siara last suggested per PR, and the last
  // divergence we already logged (so we don't re-log the same change daily).
  const priorAssignments = await deps.store.readAssignments();
  const suggestions = latestSuggestions(priorAssignments);
  const bands = latestBands(priorAssignments);
  const loggedOverrideActuals = latestOverrideActuals(
    await deps.store.readOverrides(),
  );
  const overrides: Override[] = [];

  // Build one point-in-time snapshot row for an open PR.
  const snapshotRow = (
    pr: PullRequest,
    assignees: string[],
    band: DifficultyBand | undefined,
  ): OpenPrSnapshot => {
    const ageDays = pr.postedAt ? daysBetween(pr.postedAt, nowIso) : undefined;
    const staleness =
      ageDays === undefined
        ? "normal"
        : stalenessLevel(ageDays, deps.teamConfig.staleness);
    const row: OpenPrSnapshot = {
      repo: pr.repo,
      pr: pr.number,
      title: pr.title,
      author: pr.author,
      assignees,
      staleness,
    };
    if (ageDays !== undefined) row.ageDays = ageDays;
    if (band !== undefined) row.band = band;
    if (pr.postedAt) row.postedAt = pr.postedAt;
    return row;
  };

  for (const repo of deps.repos) {
    const resolved = findRepoConfig(deps, repo);
    const openPrs = await deps.github.listOpenPullRequests(repo);

    for (const pr of openPrs) {
      // A PR that already has a requested reviewer is "pending", not "new":
      // repost it with its existing assignee + staleness, never reassign.
      if (pr.requestedReviewers.length > 0) {
        // Detect a manual reviewer change: the live reviewer set diverges from
        // what Siara suggested. Respect it (never revert) — just log it once.
        const key = prKey(repo, pr.number);
        const suggested = suggestions.get(key);
        if (suggested) {
          const actual = [...pr.requestedReviewers].sort();
          const actualKey = actual.join(",");
          if (
            !sameSet(suggested, actual) &&
            loggedOverrideActuals.get(key) !== actualKey
          ) {
            const override: Override = {
              seenAt: nowIso,
              repo,
              pr: pr.number,
              suggested,
              actual,
            };
            overrides.push(override);
            loggedOverrideActuals.set(key, actualKey);
            if (!dry) {
              await deps.store.appendOverride(override);
            }
          }
        }
        if (pr.postedAt) {
          pendingForRepost.push(pr);
        }
        snapshotPrs.push(
          snapshotRow(pr, [...pr.requestedReviewers].sort(), bands.get(prKey(repo, pr.number))),
        );
        continue;
      }

      if (pr.postedAt) {
        pendingForRepost.push(pr);
      }

      const logins = resolved.roster;
      const candidates = await deps.store.getCandidateHistory(repo, pr, logins);
      const jira = pr.jiraKey
        ? await deps.store.getJira(pr.jiraKey)
        : undefined;
      const result = pickReviewers({
        pr,
        config: resolved,
        candidates,
        jira,
        nowIso,
      });

      const rationaleInput = {
        repo,
        prNumber: pr.number,
        result,
        date: nowIso.slice(0, 10),
      };
      const rationale = formatRationale(rationaleInput);
      const assignment = toAssignment(rationaleInput);

      assigneesByPr.set(`${repo}#${pr.number}`, result.assignees);

      if (!dry && result.assignees.length > 0) {
        await deps.github.postComment(repo, pr.number, rationale);
        await deps.github.requestReviewers(repo, pr.number, result.assignees);
        if (deps.slack) {
          await deps.slack.postAssignment(undefined, rationale);
        }
        await deps.store.appendAssignment(assignment);
      }

      assigned.push({
        repo,
        pr: pr.number,
        assignees: result.assignees,
        band: result.difficulty.band,
        rationale,
      });

      snapshotPrs.push(
        snapshotRow(pr, result.assignees, result.difficulty.band),
      );
    }
  }

  if (!dry) {
    await deps.store.writeOpenPrsSnapshot({ takenAt: nowIso, prs: snapshotPrs });
  }

  if (deps.slack && !dry && pendingForRepost.length > 0) {
    const repostText = buildStalenessRepostText(
      pendingForRepost,
      nowIso,
      deps.teamConfig.staleness,
      (pr) => {
        const key = `${pr.repo}#${pr.number}`;
        const fresh = assigneesByPr.get(key);
        if (fresh && fresh.length > 0) {
          return fresh[0] ?? "";
        }
        return assigneeLabel(pr);
      },
    );
    if (repostText) {
      await deps.slack.repostPending(undefined, repostText);
    }
  }

  return { synced, assigned, overrides };
}
