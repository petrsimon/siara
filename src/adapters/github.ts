/**
 * GitHub adapter backed by the authenticated `gh` CLI.
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GitHubAdapter,
  MergedPullRequest,
  PullRequestLifecycleEvents,
  ReadyForReviewEvent,
  ReviewRequestEvent,
} from "./index.js";
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
/** PRs per GraphQL timeline query — keeps the document under GitHub's cost cap. */
const REVIEW_REQUEST_BATCH = 20;
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

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

interface GqlRequestedReviewer {
  __typename?: string;
  login?: string | null;
}

interface GqlReviewRequestNode {
  __typename?: string;
  createdAt?: string;
  requestedReviewer?: GqlRequestedReviewer | null;
}

interface GqlPullRequestTimeline {
  timelineItems?: { nodes?: Array<GqlReviewRequestNode | null> | null } | null;
}

/** Map a GraphQL pullRequest timeline payload to user review-request events. */
export function parseReviewRequestTimeline(
  pr: number,
  payload: unknown,
): ReviewRequestEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const nodes = (payload as GqlPullRequestTimeline).timelineItems?.nodes;
  if (!Array.isArray(nodes)) return [];

  const out: ReviewRequestEvent[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const login = node.requestedReviewer?.login;
    const at = node.createdAt;
    if (typeof login !== "string" || login.length === 0) continue;
    if (typeof at !== "string" || at.length === 0) continue;
    const kind =
      node.__typename === "ReviewRequestRemovedEvent" ? "removed" : "requested";
    if (
      node.__typename !== "ReviewRequestedEvent" &&
      node.__typename !== "ReviewRequestRemovedEvent"
    ) {
      continue;
    }
    out.push({ pr, login, at, kind });
  }
  return out;
}

/** Map a GitHub timeline payload to ready-for-review transitions. */
export function parseReadyForReviewTimeline(
  pr: number,
  payload: unknown,
): ReadyForReviewEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const nodes = (payload as GqlPullRequestTimeline).timelineItems?.nodes;
  if (!Array.isArray(nodes)) return [];

  const out: ReadyForReviewEvent[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if (node.__typename !== "ReadyForReviewEvent") continue;
    if (typeof node.createdAt !== "string" || node.createdAt.length === 0) continue;
    out.push({ pr, at: node.createdAt });
  }
  return out;
}

/**
 * Latest still-open GitHub review request per PR+login.
 * Key is `${pr}\0${login}` → ISO timestamp of the current request.
 */
export function openRequestStartedAt(
  events: ReviewRequestEvent[],
): Map<string, string> {
  const byKey = new Map<string, ReviewRequestEvent[]>();
  for (const ev of events) {
    const key = `${ev.pr}\0${ev.login}`;
    const list = byKey.get(key) ?? [];
    list.push(ev);
    byKey.set(key, list);
  }
  const out = new Map<string, string>();
  for (const [key, list] of byKey) {
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let openAt: string | undefined;
    for (const ev of list) {
      openAt = ev.kind === "requested" ? ev.at : undefined;
    }
    if (openAt !== undefined) out.set(key, openAt);
  }
  return out;
}

/**
 * Earliest `requested` timestamp per `${pr}\0${login}`. Unlike
 * `openRequestStartedAt` (which tracks the currently-open request), this keeps
 * the first time a reviewer was ever requested — the assignment point for a PR
 * that has since merged.
 */
export function firstRequestedAt(
  events: ReviewRequestEvent[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const ev of events) {
    if (ev.kind !== "requested") continue;
    const key = `${ev.pr}\0${ev.login}`;
    const prev = out.get(key);
    if (prev === undefined || ev.at < prev) out.set(key, ev.at);
  }
  return out;
}

/** Parse `gh pr list --state merged --json number,author,mergedAt`. */
export function parseMergedPullRequests(json: unknown): MergedPullRequest[] {
  if (!Array.isArray(json)) return [];
  const out: MergedPullRequest[] = [];
  for (const item of json) {
    if (!item || typeof item !== "object") continue;
    const raw = item as {
      number?: unknown;
      author?: { login?: string | null } | null;
      mergedAt?: unknown;
    };
    if (typeof raw.number !== "number") continue;
    if (typeof raw.mergedAt !== "string" || raw.mergedAt.length === 0) continue;
    out.push({
      number: raw.number,
      author: raw.author?.login ?? "unknown",
      mergedAt: raw.mergedAt,
    });
  }
  return out;
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

  async listRecentlyMergedPullRequests(
    repo: string,
    sinceIso: string,
  ): Promise<MergedPullRequest[]> {
    const since = sinceIso.slice(0, 10);
    const stdout = await runGh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--search",
      `merged:>=${since}`,
      "--limit",
      "500",
      "--json",
      "number,author,mergedAt",
    ]);
    return parseMergedPullRequests(JSON.parse(stdout) as unknown);
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

  async getPullRequestLifecycleEvents(
    repo: string,
    prNumbers: number[],
  ): Promise<PullRequestLifecycleEvents> {
    const slash = repo.indexOf("/");
    if (slash <= 0 || prNumbers.length === 0) {
      return { reviewRequests: [], readyForReview: [] };
    }
    const owner = repo.slice(0, slash);
    const name = repo.slice(slash + 1);
    const unique = [...new Set(prNumbers)].filter((n) => Number.isInteger(n) && n > 0);
    if (unique.length === 0) {
      return { reviewRequests: [], readyForReview: [] };
    }

    const reviewRequests: ReviewRequestEvent[] = [];
    const readyForReview: ReadyForReviewEvent[] = [];
    const fragment = `
            timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, READY_FOR_REVIEW_EVENT], first: 100) {
              nodes {
                __typename
                ... on ReviewRequestedEvent {
                  createdAt
                  requestedReviewer { __typename ... on User { login } }
                }
                ... on ReviewRequestRemovedEvent {
                  createdAt
                  requestedReviewer { __typename ... on User { login } }
                }
                ... on ReadyForReviewEvent {
                  createdAt
                }
              }
            }`;

    for (let i = 0; i < unique.length; i += REVIEW_REQUEST_BATCH) {
      const batch = unique.slice(i, i + REVIEW_REQUEST_BATCH);
      const fields = batch
        .map((n, idx) => `p${idx}: pullRequest(number: ${n}) { ${fragment} }`)
        .join("\n");
      const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
      try {
        const stdout = await runGh(["api", "graphql", "-f", `query=${query}`]);
        const json = JSON.parse(stdout) as {
          data?: { repository?: Record<string, GqlPullRequestTimeline | null> };
        };
        const repoPayload = json.data?.repository;
        if (!repoPayload) continue;
        for (let j = 0; j < batch.length; j++) {
          const pr = batch[j];
          if (pr === undefined) continue;
          const payload = repoPayload[`p${j}`];
          if (!payload) continue;
          reviewRequests.push(...parseReviewRequestTimeline(pr, payload));
          readyForReview.push(...parseReadyForReviewTimeline(pr, payload));
        }
      } catch {
        // Skip a failed batch rather than aborting the whole report.
      }
    }
    return { reviewRequests, readyForReview };
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

  async getCodeownersText(repo: string): Promise<string | undefined> {
    for (const path of CODEOWNERS_PATHS) {
      try {
        const stdout = await runGh([
          "api",
          `repos/${repo}/contents/${path}`,
          "--jq",
          ".content",
        ]);
        if (!stdout || stdout === "null") {
          continue;
        }
        return Buffer.from(stdout, "base64").toString("utf8");
      } catch {
        // Missing or unreadable path — try the next candidate.
      }
    }
    return undefined;
  }

  async getTeamMembers(org: string, teamSlug: string): Promise<string[]> {
    try {
      const stdout = await runGh([
        "api",
        `orgs/${org}/teams/${teamSlug}/members`,
        "--paginate",
        "--jq",
        ".[].login",
      ]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== "null");
    } catch {
      return [];
    }
  }

  async getMaintainCollaborators(repo: string): Promise<string[]> {
    try {
      const stdout = await runGh([
        "api",
        `repos/${repo}/collaborators?per_page=100`,
        "--paginate",
        "--jq",
        ".[] | select(.permissions.maintain == true or .permissions.admin == true) | .login",
      ]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== "null");
    } catch {
      return [];
    }
  }
}
