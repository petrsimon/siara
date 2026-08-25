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
  ReviewResponse,
} from "../types.js";
import { sync } from "./sync.js";
import { daysBetween, hoursBetween, subtractDays } from "./dates.js";
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

/** The latest assignment per PR (last write wins), within the sync window. */
function latestAssignmentsInWindow(
  assignments: Assignment[],
  windowStartDate: string,
): Map<string, Assignment> {
  const map = new Map<string, Assignment>();
  for (const a of assignments) {
    if (a.date < windowStartDate) continue;
    map.set(prKey(a.repo, a.pr), a);
  }
  return map;
}

/**
 * Build the review-latency report. For each in-window assignment, measure the
 * clock from assignment to each assigned reviewer's first review on/after that
 * assignment. A reviewer with no such review on a still-open PR is outstanding.
 */
async function computeResponses(
  deps: SiaraDeps,
  nowIso: string,
  openKeys: Set<string>,
): Promise<ReviewResponse[]> {
  const windowStartDate = subtractDays(nowIso, deps.teamConfig.syncWindowDays).slice(0, 10);
  const latest = latestAssignmentsInWindow(
    await deps.store.readAssignments(),
    windowStartDate,
  );

  // Group PR numbers per repo so review events can be fetched in one query each.
  const prNumbersByRepo = new Map<string, number[]>();
  for (const a of latest.values()) {
    const list = prNumbersByRepo.get(a.repo) ?? [];
    list.push(a.pr);
    prNumbersByRepo.set(a.repo, list);
  }

  // firstReviewAt[repo#pr\0login] = earliest review timestamp by that reviewer.
  const firstReviewAt = new Map<string, string>();
  for (const [repo, prNumbers] of prNumbersByRepo) {
    const events = await deps.store.getReviewEvents(repo, prNumbers);
    for (const ev of events) {
      const key = `${prKey(repo, ev.pr)}\0${ev.login}`;
      const prev = firstReviewAt.get(key);
      if (prev === undefined || ev.reviewedAt < prev) {
        firstReviewAt.set(key, ev.reviewedAt);
      }
    }
  }

  const responses: ReviewResponse[] = [];
  for (const a of latest.values()) {
    const key = prKey(a.repo, a.pr);
    const assignedAt = `${a.date}T00:00:00.000Z`;
    for (const reviewer of a.assignees) {
      const reviewedAt = firstReviewAt.get(`${key}\0${reviewer}`);
      // Only count a review that landed on/after the assignment (ignore an
      // earlier re-review from a prior round).
      if (reviewedAt !== undefined && reviewedAt >= assignedAt) {
        responses.push({
          repo: a.repo,
          pr: a.pr,
          reviewer,
          assignedAt,
          firstReviewAt: reviewedAt,
          latencyHours: hoursBetween(assignedAt, reviewedAt),
          outstanding: false,
        });
      } else if (openKeys.has(key)) {
        responses.push({
          repo: a.repo,
          pr: a.pr,
          reviewer,
          assignedAt,
          outstanding: true,
          waitingHours: hoursBetween(assignedAt, nowIso),
        });
      }
      // else: PR closed without a review from this reviewer → not reported.
    }
  }
  return responses;
}

export async function daily(
  deps: SiaraDeps,
  nowIso: string,
  opts: DailyOptions = {},
): Promise<DailyResult> {
  const dry = opts.dryRun === true;
  // Shadow mode: write local artifacts but post nothing externally.
  const doPost = !dry && opts.post !== false;
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

  // Fetch every repo's open PRs up front so shadow-mode load feedback can be
  // seeded from the full open set before any distribution happens.
  const openPrsByRepo = new Map<string, PullRequest[]>();
  for (const repo of deps.repos) {
    openPrsByRepo.set(repo, await deps.github.listOpenPullRequests(repo));
  }

  // Shadow-mode load feedback. Live mode gets its fairness signal from GitHub
  // (each request bumps openReviewLoad on the next sync); shadow posts nothing,
  // so without this a whole batch scores against frozen near-zero load and the
  // single strongest expert sweeps every PR. Here we synthesize that signal:
  // seed from Siara's own still-open standing recommendations, then increment as
  // we distribute the not-yet-recommended PRs — so the batch spreads like live.
  const shadowLoad = new Map<string, number>();
  if (!doPost) {
    for (const [repo, prs] of openPrsByRepo) {
      for (const pr of prs) {
        // PRs with a real GitHub reviewer are already counted in openReviewLoad.
        if (pr.requestedReviewers.length > 0) continue;
        const prior = suggestions.get(prKey(repo, pr.number));
        if (prior) {
          for (const r of prior) shadowLoad.set(r, (shadowLoad.get(r) ?? 0) + 1);
        }
      }
    }
  }
  const bumpShadowLoad = (logins: string[]): void => {
    for (const r of logins) shadowLoad.set(r, (shadowLoad.get(r) ?? 0) + 1);
  };

  for (const repo of deps.repos) {
    const resolved = findRepoConfig(deps, repo);
    const openPrs = openPrsByRepo.get(repo) ?? [];

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

      // Shadow mode: a still-open PR Siara already recommended keeps its pick
      // (it's "assigned" in shadow terms) — re-scoring it against accumulated
      // load would churn the recommendation every run. It's already counted in
      // the shadowLoad seed above; report it unchanged and move on.
      const prKeyStr = prKey(repo, pr.number);
      const standing = !doPost ? suggestions.get(prKeyStr) : undefined;
      if (standing) {
        const band = bands.get(prKeyStr) ?? "moderate";
        assigned.push({
          repo,
          pr: pr.number,
          assignees: standing,
          band,
          rationale: `Standing recommendation (unchanged): @${standing.join(", @")}`,
        });
        snapshotPrs.push(snapshotRow(pr, standing, bands.get(prKeyStr)));
        continue;
      }

      const logins = resolved.roster;
      const rawCandidates = await deps.store.getCandidateHistory(repo, pr, logins);
      // In shadow mode fold the synthetic distribution load into openReviewLoad
      // so each pick steers away from reviewers already loaded up this batch.
      const candidates = doPost
        ? rawCandidates
        : rawCandidates.map((c) => ({
            ...c,
            openReviewLoad: c.openReviewLoad + (shadowLoad.get(c.login) ?? 0),
          }));
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
      if (!doPost && result.assignees.length > 0) {
        bumpShadowLoad(result.assignees);
      }

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
        if (doPost) {
          await deps.github.postComment(repo, pr.number, rationale);
          await deps.github.requestReviewers(repo, pr.number, result.assignees);
          if (deps.slack) {
            await deps.slack.postAssignment(undefined, rationale);
          }
        }
        // Dedup the log: in shadow mode a PR stays "new" every run (we never set
        // a reviewer on GitHub), so only append when the recommendation is new
        // or has changed since the last logged pick for this PR.
        const prevPick = suggestions.get(prKey(repo, pr.number));
        const pick = [...result.assignees].sort();
        if (!prevPick || !sameSet(prevPick, pick)) {
          await deps.store.appendAssignment(assignment);
          suggestions.set(prKey(repo, pr.number), pick);
        }
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

    // Review-latency report: for every assignment within the sync window, how
    // long each assigned reviewer took to first review (or how long they've been
    // outstanding on a still-open PR). Written to a git-tracked artifact so the
    // store-free dashboard can render responsiveness.
    const openKeys = new Set(snapshotPrs.map((p) => prKey(p.repo, p.pr)));
    const responses = await computeResponses(deps, nowIso, openKeys);
    await deps.store.writeResponseReport({ takenAt: nowIso, responses });
  }

  if (deps.slack && doPost && pendingForRepost.length > 0) {
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
