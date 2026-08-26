/**
 * Daily run: sync → assign new PRs (comment + request review + Slack post +
 * JSONL append) → repost pending with age + assignee + staleness marker →
 * completed PRs dropped. Honors DailyOptions.dryRun (no side effects).
 */
import { resolveConfig } from "../config.js";
import { pickReviewers } from "../scoring/pickReviewers.js";
import { scoreDifficulty } from "../scoring/difficulty.js";
import { formatRationale, toAssignment } from "../rationale.js";
import type {
  Assignment,
  DifficultyBand,
  OpenPrSnapshot,
  Override,
  PullRequest,
  ReviewResponse,
} from "../types.js";
import { firstRequestedAt, openRequestStartedAt } from "../adapters/github.js";
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
 * Build the review-latency report. Outstanding waits are measured from the
 * GitHub `review_requested` timestamp for whoever is currently requested on
 * an open PR. Completed reviews still come from the in-window assignment log
 * (with GitHub request time overlaid when known).
 */
async function computeResponses(
  deps: SiaraDeps,
  nowIso: string,
  openPrs: PullRequest[],
): Promise<ReviewResponse[]> {
  const sinceIso = subtractDays(nowIso, deps.teamConfig.syncWindowDays);
  const windowStartDate = sinceIso.slice(0, 10);
  const latest = latestAssignmentsInWindow(
    await deps.store.readAssignments(),
    windowStartDate,
  );

  const repos = new Set<string>(deps.repos);
  for (const pr of openPrs) repos.add(pr.repo);
  for (const a of latest.values()) repos.add(a.repo);

  // Recently-merged PRs power the reviewer time-to-merge distribution.
  const mergedByRepo = new Map<string, Awaited<ReturnType<typeof deps.github.listRecentlyMergedPullRequests>>>();
  for (const repo of repos) {
    mergedByRepo.set(repo, await deps.github.listRecentlyMergedPullRequests(repo, sinceIso));
  }

  const prNumbersByRepo = new Map<string, number[]>();
  const addPr = (repo: string, pr: number): void => {
    repos.add(repo);
    const list = prNumbersByRepo.get(repo) ?? [];
    if (!list.includes(pr)) list.push(pr);
    prNumbersByRepo.set(repo, list);
  };
  for (const pr of openPrs) addPr(pr.repo, pr.number);
  for (const a of latest.values()) addPr(a.repo, a.pr);
  for (const [repo, merged] of mergedByRepo) {
    for (const m of merged) addPr(repo, m.number);
  }

  const firstReviewAt = new Map<string, string>();
  const openStartsByRepo = new Map<string, Map<string, string>>();
  const firstReqByRepo = new Map<string, Map<string, string>>();
  for (const [repo, prNumbers] of prNumbersByRepo) {
    const events = await deps.store.getReviewEvents(repo, prNumbers);
    for (const ev of events) {
      const key = `${prKey(repo, ev.pr)}\0${ev.login}`;
      const prev = firstReviewAt.get(key);
      if (prev === undefined || ev.reviewedAt < prev) {
        firstReviewAt.set(key, ev.reviewedAt);
      }
    }
    const requestEvents = await deps.github.getReviewRequestEvents(repo, prNumbers);
    openStartsByRepo.set(repo, openRequestStartedAt(requestEvents));
    firstReqByRepo.set(repo, firstRequestedAt(requestEvents));
  }

  const responses: ReviewResponse[] = [];
  const emitted = new Set<string>();

  // Outstanding (and still-requested reviewers who already reviewed) from GitHub.
  for (const pr of openPrs) {
    const starts = openStartsByRepo.get(pr.repo) ?? new Map();
    for (const reviewer of pr.requestedReviewers) {
      const start = starts.get(`${pr.number}\0${reviewer}`);
      if (start === undefined) continue;
      const pair = `${prKey(pr.repo, pr.number)}\0${reviewer}`;
      const reviewedAt = firstReviewAt.get(pair);
      if (reviewedAt !== undefined && reviewedAt >= start) {
        responses.push({
          repo: pr.repo,
          pr: pr.number,
          reviewer,
          assignedAt: start,
          firstReviewAt: reviewedAt,
          latencyHours: hoursBetween(start, reviewedAt),
          outstanding: false,
        });
      } else {
        responses.push({
          repo: pr.repo,
          pr: pr.number,
          reviewer,
          assignedAt: start,
          outstanding: true,
          waitingHours: hoursBetween(start, nowIso),
        });
      }
      emitted.add(pair);
    }
  }

  // Completed reviews on PRs no longer requesting that reviewer (often closed).
  for (const a of latest.values()) {
    const key = prKey(a.repo, a.pr);
    const assignedAt = `${a.date}T00:00:00.000Z`;
    for (const reviewer of a.assignees) {
      const pair = `${key}\0${reviewer}`;
      if (emitted.has(pair)) continue;
      const reviewedAt = firstReviewAt.get(pair);
      if (reviewedAt === undefined || reviewedAt < assignedAt) continue;
      responses.push({
        repo: a.repo,
        pr: a.pr,
        reviewer,
        assignedAt,
        firstReviewAt: reviewedAt,
        latencyHours: hoursBetween(assignedAt, reviewedAt),
        outstanding: false,
      });
    }
  }

  // Time-to-merge: measured strictly from GitHub's `review_requested` time —
  // never the Siara assignment-log date. A reviewer with no GitHub request
  // event on a since-merged PR gets no merge stat. When a request time exists
  // we re-anchor the whole record to it (recomputing latency) so one response
  // carries one real assignment time.
  const byPair = new Map<string, ReviewResponse>();
  for (const r of responses) byPair.set(`${prKey(r.repo, r.pr)}\0${r.reviewer}`, r);
  for (const [repo, merged] of mergedByRepo) {
    const firstReq = firstReqByRepo.get(repo) ?? new Map<string, string>();
    for (const m of merged) {
      const key = prKey(repo, m.number);
      const reviewers = new Set<string>();
      for (const reqKey of firstReq.keys()) {
        const sep = reqKey.indexOf("\0");
        if (Number(reqKey.slice(0, sep)) === m.number) reviewers.add(reqKey.slice(sep + 1));
      }

      for (const reviewer of reviewers) {
        const pair = `${key}\0${reviewer}`;
        const assignedAt = firstReq.get(`${m.number}\0${reviewer}`);
        if (assignedAt === undefined || m.mergedAt < assignedAt) continue;
        const mergeHours = hoursBetween(assignedAt, m.mergedAt);
        const existing = byPair.get(pair);
        if (existing) {
          existing.assignedAt = assignedAt;
          existing.mergedAt = m.mergedAt;
          existing.mergeHours = mergeHours;
          // Re-anchor latency to the real request time; drop it if the review
          // predates the request (e.g. a later re-request).
          if (existing.firstReviewAt !== undefined) {
            existing.latencyHours =
              existing.firstReviewAt >= assignedAt
                ? hoursBetween(assignedAt, existing.firstReviewAt)
                : undefined;
          }
        } else {
          const resp: ReviewResponse = {
            repo,
            pr: m.number,
            reviewer,
            assignedAt,
            outstanding: false,
            mergedAt: m.mergedAt,
            mergeHours,
          };
          responses.push(resp);
          byPair.set(pair, resp);
        }
      }
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
    // Prefer the GitHub open date (real PR age); fall back to the Slack post
    // time for older data. Shadow runs never post, so createdAt is the only age.
    const ageAnchor = pr.createdAt ?? pr.postedAt;
    const ageDays = ageAnchor ? daysBetween(ageAnchor, nowIso) : undefined;
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

  // Hard-WIP tracking (both modes): how many concurrent HARD reviews each person
  // already holds. Seed from still-open hard PRs — live from their requested
  // reviewers, shadow from Siara's standing suggestion — then increment as new
  // hard PRs are distributed this batch. Feeds the hard-WIP overflow cap so one
  // expert isn't bombarded with hard reviews.
  const hardLoad = new Map<string, number>();
  for (const [repo, prs] of openPrsByRepo) {
    for (const pr of prs) {
      const key = prKey(repo, pr.number);
      if (bands.get(key) !== "hard") continue;
      const who =
        pr.requestedReviewers.length > 0
          ? pr.requestedReviewers
          : suggestions.get(key) ?? [];
      for (const r of who) hardLoad.set(r, (hardLoad.get(r) ?? 0) + 1);
    }
  }
  const bumpHardLoad = (logins: string[]): void => {
    for (const r of logins) hardLoad.set(r, (hardLoad.get(r) ?? 0) + 1);
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

        // Score the PR even if it already has reviewers - ensures complete difficulty data
        let band = bands.get(key);
        if (!band) {
          const files = await deps.github.getPullRequestFiles(repo, pr.number);
          const diffResult = scoreDifficulty(files, resolved);
          band = diffResult.band;
          // Record the band for future reference
          if (!dry) {
            const assignment: Assignment = {
              date: nowIso.slice(0, 10),
              repo,
              pr: pr.number,
              assignees: [...pr.requestedReviewers].sort(),
              band: diffResult.band,
              difficulty: diffResult.score,
              rationale: `[AUTO-SCORED] Existing PR scored for load tracking: difficulty ${diffResult.score.toFixed(2)} → ${diffResult.band}`,
              candidates: [],
            };
            await deps.store.appendAssignment(assignment);
          }
        }

        snapshotPrs.push(
          snapshotRow(pr, [...pr.requestedReviewers].sort(), band),
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
        // Score if band is missing - ensures complete difficulty data
        let band = bands.get(prKeyStr);
        if (!band) {
          const files = await deps.github.getPullRequestFiles(repo, pr.number);
          const diffResult = scoreDifficulty(files, resolved);
          band = diffResult.band;
          if (!dry) {
            const assignment: Assignment = {
              date: nowIso.slice(0, 10),
              repo,
              pr: pr.number,
              assignees: standing,
              band: diffResult.band,
              difficulty: diffResult.score,
              rationale: `[AUTO-SCORED] Shadow PR scored for load tracking: difficulty ${diffResult.score.toFixed(2)} → ${diffResult.band}`,
              candidates: [],
            };
            await deps.store.appendAssignment(assignment);
          }
        }
        assigned.push({
          repo,
          pr: pr.number,
          assignees: standing,
          band,
          rationale: `Standing recommendation (unchanged): @${standing.join(", @")}`,
        });
        snapshotPrs.push(snapshotRow(pr, standing, band));
        continue;
      }

      const logins = resolved.roster;
      const rawCandidates = await deps.store.getCandidateHistory(repo, pr, logins);
      // In shadow mode fold the synthetic distribution load into openReviewLoad
      // so each pick steers away from reviewers already loaded up this batch.
      const candidates = rawCandidates.map((c) => ({
        ...c,
        // Shadow folds the synthetic batch load into openReviewLoad; live uses
        // GitHub's load as-is. Both get Siara's hard-band load for the WIP cap.
        openReviewLoad: doPost
          ? c.openReviewLoad
          : c.openReviewLoad + (shadowLoad.get(c.login) ?? 0),
        hardReviewLoad: hardLoad.get(c.login) ?? 0,
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
        strategy: opts.strategy,
      });
      if (!doPost && result.assignees.length > 0) {
        bumpShadowLoad(result.assignees);
      }
      // Hard-WIP load accrues in both modes so later hard PRs in the batch see
      // this pick and overflow past the cap to the next expert.
      if (result.difficulty.band === "hard" && result.assignees.length > 0) {
        bumpHardLoad(result.assignees);
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

    // Review-latency report: outstanding waits from GitHub review-requested
    // time; completed reviews from the in-window assignment log.
    const allOpenPrs = [...openPrsByRepo.values()].flat();
    const responses = await computeResponses(deps, nowIso, allOpenPrs);
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
