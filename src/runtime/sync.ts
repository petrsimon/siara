/**
 * Sync: fetch GitHub/Jira signals into the store. Cold-start on first run
 * (full sync window), incremental afterwards (since last sync timestamp).
 */
import type { GitHubAdapter } from "../adapters/index.js";
import type { PullRequest } from "../types.js";
import { subtractDays } from "./dates.js";
import type { SiaraDeps, SyncResult } from "./index.js";

/** GitHub may return path→login or login→path; store expects login→path. */
function normalizeCommitHistory(
  raw: Record<string, Record<string, number>>,
  paths: string[],
): Record<string, Record<string, number>> {
  const pathSet = new Set(paths);
  const outerKeys = Object.keys(raw);
  const pathKeyed =
    outerKeys.length > 0 && outerKeys.every((key) => pathSet.has(key));
  if (!pathKeyed) {
    return raw;
  }

  const byLogin: Record<string, Record<string, number>> = {};
  for (const [path, authors] of Object.entries(raw)) {
    for (const [login, count] of Object.entries(authors)) {
      byLogin[login] ??= {};
      byLogin[login][path] = count;
    }
  }
  return byLogin;
}

async function gatherChangedPaths(
  github: GitHubAdapter,
  repo: string,
  prs: PullRequest[],
): Promise<string[]> {
  const paths = new Set<string>();
  for (const pr of prs) {
    let files = pr.files;
    if (files.length === 0) {
      files = await github.getPullRequestFiles(repo, pr.number);
    }
    for (const file of files) {
      paths.add(file.path);
    }
  }
  return [...paths];
}

export async function sync(
  deps: SiaraDeps,
  nowIso: string,
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const roster = deps.teamConfig.roster;

  for (const repo of deps.repos) {
    const lastSyncAt = await deps.store.getLastSyncAt(repo);
    const coldStart = lastSyncAt === undefined;
    const sinceIso = coldStart
      ? subtractDays(nowIso, deps.teamConfig.syncWindowDays)
      : lastSyncAt;

    const openPrs = await deps.github.listOpenPullRequests(repo);
    const paths = await gatherChangedPaths(deps.github, repo, openPrs);

    const commitHistory = await deps.github.getCommitHistory(
      repo,
      paths,
      sinceIso,
    );
    await deps.store.upsertCommitHistory(
      repo,
      normalizeCommitHistory(commitHistory, paths),
    );

    const reviewHistory = await deps.github.getReviewHistory(repo, sinceIso);
    await deps.store.upsertReviewHistory(repo, reviewHistory);

    const openLoad = await deps.github.getOpenReviewLoad(roster);
    await deps.store.upsertOpenLoad(openLoad);

    const jiraKeys = new Set<string>();
    for (const pr of openPrs) {
      if (pr.jiraKey) {
        jiraKeys.add(pr.jiraKey);
      }
    }
    for (const key of jiraKeys) {
      const data = await deps.jira.getIssueData(key);
      await deps.store.upsertJira(key, data);
    }

    await deps.store.setLastSyncAt(repo, nowIso);
    results.push({ repo, coldStart, syncedAtIso: nowIso });
  }

  return results;
}
