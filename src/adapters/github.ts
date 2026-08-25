/**
 * GitHub adapter backed by the authenticated `gh` CLI.
 */
import { execFile as execFileCb } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitHubAdapter } from "./index.js";
import type { FileChange, PullRequest, RecentReview } from "../types.js";

const execFile = promisify(execFileCb);

const JIRA_KEY_RE = /[A-Z]+-\d+/;
const REVIEW_HISTORY_PR_CAP = 100;

let tempBodyCounter = 0;

export interface GhCliOptions {
  /** When true, log write commands instead of executing them. */
  dryLog?: boolean;
}

interface GhPrListItem {
  number: number;
  headRefName: string;
  title: string;
  author?: { login?: string | null } | null;
  files?: GhFileItem[];
  reviewRequests?: Array<{ login?: string | null } | null>;
}

interface GhFileItem {
  path: string;
  additions: number;
  deletions: number;
}

interface GhPullItem {
  number: number;
  head?: { ref?: string };
}

interface GhReviewItem {
  user?: { login?: string | null } | null;
  submitted_at?: string | null;
  state?: string;
}

/** Extract a Jira ticket key from branch name or title, if present. */
export function parseJiraKey(text: string): string | undefined {
  const match = text.match(JIRA_KEY_RE);
  return match?.[0];
}

/** Map `gh pr list --json` output to PullRequest[]. */
export function parsePullRequests(repo: string, json: unknown): PullRequest[] {
  if (!Array.isArray(json)) {
    return [];
  }

  const result: PullRequest[] = [];
  for (const item of json) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as GhPrListItem;
    if (typeof raw.number !== "number") {
      continue;
    }

    const branch = raw.headRefName ?? "";
    const title = raw.title ?? "";
    const jiraFromBranch = parseJiraKey(branch);
    const jiraFromTitle = parseJiraKey(title);

    const requestedReviewers: string[] = [];
    for (const req of raw.reviewRequests ?? []) {
      const login = req?.login;
      if (typeof login === "string" && login.length > 0) {
        requestedReviewers.push(login);
      }
    }

    result.push({
      number: raw.number,
      repo,
      author: raw.author?.login ?? "unknown",
      branch,
      title,
      files: parseFiles(raw.files ?? []),
      requestedReviewers,
      jiraKey: jiraFromBranch ?? jiraFromTitle,
    });
  }
  return result;
}

/** Map `gh pr view --json files` (or a raw file array) to FileChange[]. */
export function parseFiles(json: unknown): FileChange[] {
  const items: unknown[] = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { files?: unknown }).files)
      ? ((json as { files: unknown[] }).files)
      : [];

  const result: FileChange[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as GhFileItem;
    if (typeof raw.path !== "string") {
      continue;
    }
    result.push({
      path: raw.path,
      additions: typeof raw.additions === "number" ? raw.additions : 0,
      deletions: typeof raw.deletions === "number" ? raw.deletions : 0,
    });
  }
  return result;
}

/** Tally author logins from paginated commit API output into login → path counts. */
export function tallyCommitsByLogin(
  path: string,
  logins: string[],
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const login of logins) {
    if (!login) {
      continue;
    }
    const paths = result[login] ?? {};
    paths[path] = (paths[path] ?? 0) + 1;
    result[login] = paths;
  }
  return result;
}

function mergeCommitMaps(
  target: Record<string, Record<string, number>>,
  source: Record<string, Record<string, number>>,
): void {
  for (const [login, paths] of Object.entries(source)) {
    const existing = target[login] ?? {};
    for (const [path, count] of Object.entries(paths)) {
      existing[path] = (existing[path] ?? 0) + count;
    }
    target[login] = existing;
  }
}

/** Group raw review API rows into login → RecentReview[]. */
export function parseReviewHistory(
  pulls: GhPullItem[],
  reviewsByPr: Map<number, GhReviewItem[]>,
  sinceIso: string,
): Record<string, RecentReview[]> {
  const sinceMs = Date.parse(sinceIso);
  const result: Record<string, RecentReview[]> = {};

  for (const pull of pulls) {
    const prNumber = pull.number;
    const branch = pull.head?.ref ?? "";
    const reviews = reviewsByPr.get(prNumber) ?? [];

    for (const review of reviews) {
      const submittedAt = review.submitted_at;
      if (!submittedAt) {
        continue;
      }
      if (!Number.isNaN(sinceMs) && Date.parse(submittedAt) < sinceMs) {
        continue;
      }

      const login = review.user?.login;
      if (!login) {
        continue;
      }

      const list = result[login] ?? [];
      list.push({
        prNumber,
        branch,
        reviewedAt: submittedAt,
      });
      result[login] = list;
    }
  }

  return result;
}

async function runGh(args: string[]): Promise<string> {
  const { stdout } = await execFile("gh", args, {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

function writeTempBody(body: string): string {
  tempBodyCounter += 1;
  const path = join(tmpdir(), `siara-pr-comment-${process.pid}-${tempBodyCounter}.txt`);
  writeFileSync(path, body, "utf8");
  return path;
}

export class GhCliGitHubAdapter implements GitHubAdapter {
  constructor(private readonly options: GhCliOptions = {}) {}

  async listOpenPullRequests(repo: string): Promise<PullRequest[]> {
    const stdout = await runGh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,headRefName,author,title,files,reviewRequests",
    ]);
    return parsePullRequests(repo, JSON.parse(stdout) as unknown);
  }

  async getPullRequestFiles(
    repo: string,
    prNumber: number,
  ): Promise<PullRequest["files"]> {
    const stdout = await runGh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "files",
    ]);
    return parseFiles(JSON.parse(stdout) as unknown);
  }

  async getCommitHistory(
    repo: string,
    paths: string[],
    sinceIso: string,
  ): Promise<Record<string, Record<string, number>>> {
    const merged: Record<string, Record<string, number>> = {};

    for (const path of paths) {
      try {
        const endpoint = `repos/${repo}/commits?path=${encodeURIComponent(path)}&since=${encodeURIComponent(sinceIso)}`;
        const stdout = await runGh([
          "api",
          endpoint,
          "--paginate",
          "--jq",
          ".[].author.login",
        ]);
        const logins = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && line !== "null");
        mergeCommitMaps(merged, tallyCommitsByLogin(path, logins));
      } catch {
        // Skip paths that error (deleted, renamed, permissions, etc.).
      }
    }

    return merged;
  }

  async getReviewHistory(
    repo: string,
    sinceIso: string,
  ): Promise<Record<string, RecentReview[]>> {
    const pullsStdout = await runGh([
      "api",
      `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${REVIEW_HISTORY_PR_CAP}`,
    ]);
    const pulls = JSON.parse(pullsStdout) as GhPullItem[];

    if (pulls.length >= REVIEW_HISTORY_PR_CAP) {
      console.warn(
        `getReviewHistory: capped PR scan at ${REVIEW_HISTORY_PR_CAP} for ${repo}`,
      );
    }

    const reviewsByPr = new Map<number, GhReviewItem[]>();
    for (const pull of pulls) {
      try {
        const reviewsStdout = await runGh([
          "api",
          `repos/${repo}/pulls/${pull.number}/reviews`,
        ]);
        reviewsByPr.set(pull.number, JSON.parse(reviewsStdout) as GhReviewItem[]);
      } catch {
        // Skip PRs we cannot read.
      }
    }

    return parseReviewHistory(pulls, reviewsByPr, sinceIso);
  }

  async getOpenReviewLoad(logins: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const login of logins) {
      try {
        const stdout = await runGh([
          "search",
          "prs",
          `--review-requested=${login}`,
          "--state=open",
          "--json",
          "number",
        ]);
        const parsed = JSON.parse(stdout) as unknown;
        result[login] = Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        result[login] = 0;
      }
    }
    return result;
  }

  async postComment(
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<void> {
    const args = [
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body-file",
    ];

    if (this.options.dryLog) {
      console.log(`[dry-log] gh ${[...args, "<body-file>"].join(" ")}`);
      return;
    }

    const bodyPath = writeTempBody(body);
    try {
      await runGh([...args, bodyPath]);
    } finally {
      try {
        unlinkSync(bodyPath);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  async requestReviewers(
    repo: string,
    prNumber: number,
    logins: string[],
  ): Promise<void> {
    if (logins.length === 0) {
      return;
    }

    const args = [
      "pr",
      "edit",
      String(prNumber),
      "--repo",
      repo,
      "--add-reviewer",
      logins.join(","),
    ];

    if (this.options.dryLog) {
      console.log(`[dry-log] gh ${args.join(" ")}`);
      return;
    }

    await runGh(args);
  }
}
