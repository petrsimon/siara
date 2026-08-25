/**
 * GitHub adapter backed by the authenticated `gh` CLI.
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitHubAdapter } from "./index.js";
import type {
  FileChange,
  PullRequest,
  RecentReview,
  ReviewHistoryPage,
  ReviewHistoryQuery,
} from "../types.js";

const execFile = promisify(execFileCb);

const JIRA_KEY_RE = /[A-Z]+-\d+/;
/** Hard ceiling on paginated PR pages per sync — backstop against a runaway walk. */
const REVIEW_HISTORY_PAGE_CAP = 50;
const REVIEW_HISTORY_PAGE_SIZE = 100;

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
  createdAt?: string;
}

interface GhFileItem {
  path: string;
  additions: number;
  deletions: number;
}

interface GhPullItem {
  number: number;
  head?: { ref?: string };
  created_at?: string;
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
      ...(raw.createdAt ? { createdAt: raw.createdAt } : {}),
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
  // Object.create(null): keys are API-derived logins/paths, so a literal
  // "__proto__" must not touch a real prototype.
  const result: Record<string, Record<string, number>> = Object.create(null);
  for (const login of logins) {
    if (!login) {
      continue;
    }
    const paths = result[login] ?? Object.create(null);
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
    const existing = target[login] ?? Object.create(null);
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
  const result: Record<string, RecentReview[]> = Object.create(null);

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

/**
 * Write the comment body to a fresh private temp dir (0700 via mkdtemp) so the
 * filename is unpredictable and never a pre-planted symlink. Returns both the
 * file path and its dir for recursive cleanup.
 */
function writeTempBody(body: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "siara-"));
  const path = join(dir, "body.txt");
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { dir, path };
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
      "number,headRefName,author,title,files,reviewRequests,createdAt",
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
    query: ReviewHistoryQuery,
  ): Promise<ReviewHistoryPage> {
    const { windowStartIso, sincePrNumber, openPrs } = query;
    const windowStartMs = Date.parse(windowStartIso);

    // Walk newest-first, page by page. Two stop conditions:
    //  - incremental (sincePrNumber set): stop once we reach a PR we've already
    //    ingested (number <= watermark) — only genuinely new PRs are pulled.
    //  - cold start (undefined): stop once PRs fall before the window — bounds
    //    the initial walk without a fixed PR cap.
    // Union with openPrs so reviews landing on old-but-active PRs are caught.
    const walked = new Map<number, GhPullItem>();
    let maxPrNumber = sincePrNumber ?? 0;
    let stop = false;

    for (let page = 1; page <= REVIEW_HISTORY_PAGE_CAP && !stop; page += 1) {
      const pageStdout = await runGh([
        "api",
        `repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=${REVIEW_HISTORY_PAGE_SIZE}&page=${page}`,
      ]);
      const pagePulls = JSON.parse(pageStdout) as GhPullItem[];
      if (pagePulls.length === 0) {
        break;
      }

      for (const pull of pagePulls) {
        if (pull.number > maxPrNumber) {
          maxPrNumber = pull.number;
        }
        if (sincePrNumber !== undefined && pull.number <= sincePrNumber) {
          stop = true;
          break;
        }
        if (
          sincePrNumber === undefined &&
          !Number.isNaN(windowStartMs) &&
          pull.created_at &&
          Date.parse(pull.created_at) < windowStartMs
        ) {
          stop = true;
          break;
        }
        walked.set(pull.number, pull);
      }

      if (pagePulls.length < REVIEW_HISTORY_PAGE_SIZE) {
        break;
      }
      if (page === REVIEW_HISTORY_PAGE_CAP) {
        console.warn(
          `getReviewHistory: hit page cap (${REVIEW_HISTORY_PAGE_CAP}) for ${repo} — older history skipped this sync`,
        );
      }
    }

    // Always rescan open PRs even if below the watermark — a new review can land
    // on a PR opened long ago. Fetch their head/created only if not already walked.
    for (const open of openPrs) {
      if (open.number > maxPrNumber) {
        maxPrNumber = open.number;
      }
      if (!walked.has(open.number)) {
        walked.set(open.number, {
          number: open.number,
          head: { ref: open.branch },
        });
      }
    }

    const scannedPrNumbers = [...walked.keys()];
    const reviewsByPr = new Map<number, GhReviewItem[]>();
    for (const prNumber of scannedPrNumbers) {
      try {
        const reviewsStdout = await runGh([
          "api",
          `repos/${repo}/pulls/${prNumber}/reviews`,
        ]);
        reviewsByPr.set(prNumber, JSON.parse(reviewsStdout) as GhReviewItem[]);
      } catch {
        // Skip PRs we cannot read.
      }
    }

    const reviews = parseReviewHistory(
      [...walked.values()],
      reviewsByPr,
      windowStartIso,
    );

    return { reviews, scannedPrNumbers, maxPrNumber };
  }

  async getOpenReviewLoad(logins: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const login of logins) {
      try {
        // total_count, not page length: `gh search prs` returns only 30 results,
        // so array length caps every reviewer at 30 and flattens the signal.
        //
        // user-review-requested (NOT review-requested): the latter also counts
        // PRs requested from any CODEOWNERS *team* the login belongs to, which
        // inflates load ~15x and measures team membership, not personal queue.
        // user-review-requested counts only direct individual requests. Org-wide
        // (unscoped) on purpose — total human review burden is the load signal.
        // login is pre-validated (LOGIN_RE).
        const stdout = await runGh([
          "api",
          "-X",
          "GET",
          "search/issues",
          "--raw-field",
          `q=is:pr is:open user-review-requested:${login}`,
          "--jq",
          ".total_count",
        ]);
        const count = Number.parseInt(stdout.trim(), 10);
        result[login] = Number.isFinite(count) ? count : 0;
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

    const { dir, path: bodyPath } = writeTempBody(body);
    try {
      await runGh([...args, bodyPath]);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
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
