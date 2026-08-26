/**
 * Fill missing PR-author fields on the response-time report so author×reviewer
 * charts work even when the on-disk artifact predates author capture in `daily`.
 */
import { GhCliGitHubAdapter } from "../adapters/github.js";
import { subtractDays } from "../runtime/dates.js";
import type { OpenPrsSnapshot, ResponseTimeReport } from "../types.js";

const prKey = (repo: string, pr: number): string => `${repo}#${pr}`;

function seedAuthors(
  authorByPr: Map<string, string>,
  openPrs?: OpenPrsSnapshot,
): void {
  for (const pr of openPrs?.prs ?? []) {
    authorByPr.set(prKey(pr.repo, pr.pr), pr.author);
  }
}

function applyAuthors(
  report: ResponseTimeReport,
  authorByPr: Map<string, string>,
): ResponseTimeReport {
  return {
    ...report,
    responses: report.responses.map((r) => ({
      ...r,
      author: r.author ?? authorByPr.get(prKey(r.repo, r.pr)),
    })),
  };
}

function missingAuthorCount(
  report: ResponseTimeReport,
  authorByPr: Map<string, string>,
): number {
  let n = 0;
  for (const r of report.responses) {
    if (r.mergeHours === undefined) continue;
    if (!(r.author ?? authorByPr.get(prKey(r.repo, r.pr)))) n++;
  }
  return n;
}

/** Attach authors from the open-PR snapshot and recently-merged GitHub PRs. */
export async function enrichResponseAuthors(
  report: ResponseTimeReport | undefined,
  repos: string[],
  windowDays: number,
  openPrs?: OpenPrsSnapshot,
  nowIso = new Date().toISOString(),
): Promise<ResponseTimeReport | undefined> {
  if (!report) return undefined;

  const authorByPr = new Map<string, string>();
  seedAuthors(authorByPr, openPrs);

  if (missingAuthorCount(report, authorByPr) === 0) {
    return applyAuthors(report, authorByPr);
  }

  const sinceIso = subtractDays(nowIso, windowDays);
  const github = new GhCliGitHubAdapter({ dryLog: true });
  for (const repo of repos) {
    const merged = await github.listRecentlyMergedPullRequests(repo, sinceIso);
    for (const m of merged) {
      authorByPr.set(prKey(repo, m.number), m.author);
    }
  }

  return applyAuthors(report, authorByPr);
}
