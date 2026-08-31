/**
 * Backfill: score open PRs and historical merged PRs to populate difficulty bands.
 *
 * Open PRs come from GitHub listing. Historical candidates come from the
 * response-time report (merged lifecycle rows). Both write Assignment records
 * so the dashboard can join difficulty by repo#PR.
 */
import type { SiaraDeps } from "./index.js";
import type { ReviewResponse } from "../types.js";
import { resolveConfig } from "../config.js";
import { scoreDifficulty } from "../scoring/difficulty.js";

function findRepoConfig(
  deps: SiaraDeps,
  repo: string,
): ReturnType<typeof resolveConfig> {
  const repoConfig = deps.repoConfigs.find((config) => config.repo === repo);
  return resolveConfig(deps.teamConfig, repoConfig);
}

function prKey(repo: string, pr: number): string {
  return `${repo}#${pr}`;
}

function isValidIso(value: string | undefined): value is string {
  return value !== undefined && Number.isFinite(Date.parse(value));
}

/** Earliest valid assignedAt as YYYY-MM-DD; falls back to `fallbackDate`. */
function earliestAssignedDate(
  rows: ReviewResponse[],
  fallbackDate: string,
): string {
  let earliest: number | undefined;
  for (const row of rows) {
    const at = Date.parse(row.assignedAt);
    if (!Number.isFinite(at)) continue;
    if (earliest === undefined || at < earliest) earliest = at;
  }
  return earliest === undefined
    ? fallbackDate
    : new Date(earliest).toISOString().slice(0, 10);
}

export interface BackfillCounts {
  total: number;
  scored: number;
  skipped: number;
  failed: number;
}

export interface BackfillResult {
  open: BackfillCounts;
  historical: BackfillCounts;
}

export async function backfill(
  deps: SiaraDeps,
  nowIso: string,
): Promise<BackfillResult> {
  const open: BackfillCounts = { total: 0, scored: 0, skipped: 0, failed: 0 };
  const historical: BackfillCounts = { total: 0, scored: 0, skipped: 0, failed: 0 };
  const nowDate = nowIso.slice(0, 10);

  const priorAssignments = await deps.store.readAssignments();
  const existingBands = new Map<string, string>();
  for (const a of priorAssignments) {
    if (a.band) {
      existingBands.set(prKey(a.repo, a.pr), a.band);
    }
  }

  const openKeys = new Set<string>();

  for (const repo of deps.repos) {
    const resolved = findRepoConfig(deps, repo);
    const openPrs = await deps.github.listOpenPullRequests(repo);

    for (const pr of openPrs) {
      open.total++;
      const key = prKey(repo, pr.number);
      openKeys.add(key);

      if (existingBands.has(key)) {
        open.skipped++;
        continue;
      }

      try {
        const files = await deps.github.getPullRequestFiles(repo, pr.number);
        if (files.length === 0) throw new Error("GitHub returned no changed files");
        const diffResult = scoreDifficulty(files, resolved);

        await deps.store.appendAssignment({
          date: nowDate,
          repo,
          pr: pr.number,
          assignees: pr.requestedReviewers.length > 0
            ? pr.requestedReviewers
            : [],
          band: diffResult.band,
          difficulty: diffResult.score,
          rationale: `[BACKFILL] Scored existing PR: difficulty ${diffResult.score.toFixed(2)} → ${diffResult.band}`,
          candidates: [],
        });
        existingBands.set(key, diffResult.band);
        open.scored++;
      } catch (error) {
        open.failed++;
        console.warn(`backfill: failed to score ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const report = await deps.store.readResponseReport();
  if (report) {
    const configuredRepos = new Set(deps.repos);
    const rowsByKey = new Map<string, ReviewResponse[]>();

    for (const row of report.responses) {
      if (!configuredRepos.has(row.repo)) continue;
      const key = prKey(row.repo, row.pr);
      const rows = rowsByKey.get(key) ?? [];
      rows.push(row);
      rowsByKey.set(key, rows);
    }

    for (const [key, rows] of rowsByKey) {
      if (
        !rows.some((row) => isValidIso(row.mergedAt)) ||
        !rows.some((row) => isValidIso(row.assignedAt))
      ) continue;

      historical.total++;

      if (existingBands.has(key) || openKeys.has(key)) {
        historical.skipped++;
        continue;
      }

      const repo = rows[0]!.repo;
      const pr = rows[0]!.pr;
      const resolved = findRepoConfig(deps, repo);
      try {
        const files = await deps.github.getPullRequestFiles(repo, pr);
        if (files.length === 0) throw new Error("GitHub returned no changed files");
        const diffResult = scoreDifficulty(files, resolved);
        const reviewers = [...new Set(rows.map((row) => row.reviewer))].sort();

        await deps.store.appendAssignment({
          date: earliestAssignedDate(rows, nowDate),
          repo,
          pr,
          assignees: reviewers,
          band: diffResult.band,
          difficulty: diffResult.score,
          rationale: `[BACKFILL:HISTORICAL] Scored merged PR: difficulty ${diffResult.score.toFixed(2)} → ${diffResult.band}`,
          candidates: [],
          origin: "historical-difficulty-backfill",
        });
        existingBands.set(key, diffResult.band);
        historical.scored++;
      } catch (error) {
        historical.failed++;
        console.warn(`backfill: failed to score ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { open, historical };
}
