/**
 * Daily run: sync → assign new PRs (comment + request review + Slack post +
 * JSONL append) → repost pending with age + assignee + staleness marker →
 * completed PRs dropped. Honors DailyOptions.dryRun (no side effects).
 */
import { resolveConfig } from "../config.js";
import { pickReviewers } from "../scoring/pickReviewers.js";
import { formatRationale, toAssignment } from "../rationale.js";
import type { PullRequest } from "../types.js";
import { sync } from "./sync.js";
import { buildStalenessRepostText } from "./staleness.js";
import type { DailyOptions, DailyPrResult, DailyResult, SiaraDeps } from "./index.js";

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
  const synced = await sync(deps, nowIso);
  const assigned: DailyPrResult[] = [];
  const assigneesByPr = new Map<string, string[]>();
  const pendingForRepost: PullRequest[] = [];

  for (const repo of deps.repos) {
    const resolved = findRepoConfig(deps, repo);
    const openPrs = await deps.github.listOpenPullRequests(repo);

    for (const pr of openPrs) {
      // A PR that already has a requested reviewer is "pending", not "new":
      // repost it with its existing assignee + staleness, never reassign.
      if (pr.requestedReviewers.length > 0) {
        if (pr.postedAt) {
          pendingForRepost.push(pr);
        }
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
    }
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

  return { synced, assigned };
}
