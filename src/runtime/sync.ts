/**
 * Sync: fetch GitHub/Jira signals into the store. Cold-start on first run
 * (full sync window), incremental afterwards (since last sync timestamp).
 */
import type { GitHubAdapter } from "../adapters/index.js";
import type { PullRequest, RepoMaintainers } from "../types.js";
import { parseCodeowners, type CodeownersRule } from "../scoring/codeowners.js";
import { subtractDays, daysBetween } from "./dates.js";
import type { GiantPr, SiaraDeps, SyncResult } from "./index.js";

const MAINTAINERS_MAX_AGE_DAYS = 7;

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

/**
 * Collect the deduped set of file paths changed across open PRs, and flag any PR
 * whose file count exceeds `giantThreshold`. Giant PRs are reported, never
 * capped — every changed path still contributes to the commit-history fetch.
 */
async function gatherChangedPaths(
  github: GitHubAdapter,
  repo: string,
  prs: PullRequest[],
  giantThreshold: number,
): Promise<{ paths: string[]; giantPrs: GiantPr[] }> {
  const paths = new Set<string>();
  const giantPrs: GiantPr[] = [];
  for (const pr of prs) {
    let files = pr.files;
    if (files.length === 0) {
      files = await github.getPullRequestFiles(repo, pr.number);
    }
    for (const file of files) {
      paths.add(file.path);
    }
    if (files.length > giantThreshold) {
      giantPrs.push({ pr: pr.number, author: pr.author, fileCount: files.length });
    }
  }
  return { paths: [...paths], giantPrs };
}

/** Resolve raw CODEOWNERS owner tokens to GitHub logins. */
async function resolveCodeownersRules(
  github: GitHubAdapter,
  repo: string,
  rules: CodeownersRule[],
  teamCache: Map<string, string[]>,
): Promise<CodeownersRule[]> {
  const resolved: CodeownersRule[] = [];
  for (const rule of rules) {
    const owners: string[] = [];
    for (const token of rule.owners) {
      const raw = token.startsWith("@") ? token.slice(1) : token;
      if (raw.includes("/")) {
        const teamSlash = raw.indexOf("/");
        const org = raw.slice(0, teamSlash);
        const teamSlug = raw.slice(teamSlash + 1);
        const cacheKey = `${org}/${teamSlug}`;
        let members = teamCache.get(cacheKey);
        if (members === undefined) {
          members = await github.getTeamMembers(org, teamSlug);
          teamCache.set(cacheKey, members);
        }
        owners.push(...members);
      } else {
        owners.push(raw);
      }
    }
    resolved.push({ pattern: rule.pattern, owners: [...new Set(owners)] });
  }
  return resolved;
}

async function syncMaintainers(
  deps: SiaraDeps,
  repo: string,
  nowIso: string,
  teamCache: Map<string, string[]>,
): Promise<void> {
  try {
    const existing = await deps.store.getMaintainers(repo);
    if (
      existing !== undefined &&
      daysBetween(existing.fetchedAt, nowIso) < MAINTAINERS_MAX_AGE_DAYS
    ) {
      return;
    }

    const text = await deps.github.getCodeownersText(repo);
    const rawRules = text ? parseCodeowners(text) : [];
    const codeownersRules = await resolveCodeownersRules(
      deps.github,
      repo,
      rawRules,
      teamCache,
    );
    const collaborators = await deps.github.getMaintainCollaborators(repo);

    await deps.store.upsertMaintainers({
      repo,
      fetchedAt: nowIso,
      codeownersRules,
      collaborators,
    });
  } catch (err) {
    console.warn(
      `sync: failed to refresh maintainer data for ${repo} — ${String(err)}`,
    );
  }
}

export async function sync(
  deps: SiaraDeps,
  nowIso: string,
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const roster = deps.teamConfig.roster;
  const giantThreshold = deps.teamConfig.giantPrFileThreshold;

  // Open review load is per-login and global, not per-repo — fetch it once
  // (roster-many search calls) instead of redundantly inside the repo loop.
  const openLoad = await deps.github.getOpenReviewLoad(roster);
  await deps.store.upsertOpenLoad(openLoad);

  // "Heads-down" busy weight is also global. Manual `reviewerBusy` config is the
  // baseline; a real Jira workload query (stub {} for now) overrides per-login.
  const busyLoad: Record<string, number> = {};
  for (const login of roster) {
    // The editable `reviewers` map wins over the legacy `reviewerBusy` map.
    const manual =
      deps.teamConfig.reviewers[login]?.busy ?? deps.teamConfig.reviewerBusy[login];
    if (manual !== undefined) {
      busyLoad[login] = manual;
    }
  }
  const jiraWorkload = await deps.jira.getReviewerWorkload(roster);
  for (const [login, weight] of Object.entries(jiraWorkload)) {
    busyLoad[login] = weight;
  }
  await deps.store.upsertBusyLoad(busyLoad);

  const teamCache = new Map<string, string[]>();

  for (const repo of deps.repos) {
    const lastSyncAt = await deps.store.getLastSyncAt(repo);
    const coldStart = lastSyncAt === undefined;
    const sinceIso = coldStart
      ? subtractDays(nowIso, deps.teamConfig.syncWindowDays)
      : lastSyncAt;

    const openPrs = await deps.github.listOpenPullRequests(repo);
    const { paths, giantPrs } = await gatherChangedPaths(
      deps.github,
      repo,
      openPrs,
      giantThreshold,
    );

    const commitHistory = await deps.github.getCommitHistory(
      repo,
      paths,
      sinceIso,
    );
    await deps.store.upsertCommitHistory(
      repo,
      normalizeCommitHistory(commitHistory, paths),
    );

    // Review history is bounded by a PR-number watermark, not the sync clock:
    // pull only PRs above the last-seen number, always rescan the currently-open
    // set (a review can land on an old-but-active PR), and prune to the window.
    // windowStartIso is the full window regardless of cold/incremental — it
    // bounds the cold walk and the prune, never the incremental fetch.
    const windowStartIso = subtractDays(nowIso, deps.teamConfig.syncWindowDays);
    const sincePrNumber = await deps.store.getReviewWatermark(repo);
    const reviewPage = await deps.github.getReviewHistory(repo, {
      windowStartIso,
      sincePrNumber,
      openPrs: openPrs.map((pr) => ({ number: pr.number, branch: pr.branch })),
    });
    await deps.store.mergeReviewHistory(repo, reviewPage, windowStartIso);

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

    await syncMaintainers(deps, repo, nowIso, teamCache);

    await deps.store.setLastSyncAt(repo, nowIso);
    results.push({ repo, coldStart, syncedAtIso: nowIso, giantPrs });
  }

  return results;
}
