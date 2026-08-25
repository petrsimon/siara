/**
 * Local-git commit-history provider.
 *
 * Reads authorship from a local clone's `git log` instead of the GitHub commits
 * API. The API costs one request per changed path (the dominant sync cost); a
 * single `git log` covers every path in one process. The tradeoff: git records
 * author *emails*, not GitHub logins, so an identity map (email/name → login)
 * plus GitHub-noreply decoding turns authorship into roster logins.
 *
 * Only getCommitHistory is overridden; open PRs, reviews, and load still come
 * from the wrapped GitHub adapter (they don't exist in a clone).
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubAdapter } from "./index.js";
import type { PullRequest, RecentReview } from "../types.js";

const execFile = promisify(execFileCb);

/** "ID+login@users.noreply.github.com" → login (GitHub's privacy email). */
const NOREPLY_RE = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;

/**
 * Resolve a git author (email, falling back to name) to a roster login.
 * Order: explicit map → GitHub noreply decode → unmapped (undefined).
 */
export function resolveLogin(
  email: string,
  name: string,
  identityMap: Record<string, string>,
): string | undefined {
  const mapped = identityMap[email] ?? identityMap[name];
  if (mapped) {
    return mapped;
  }
  const noreply = NOREPLY_RE.exec(email);
  if (noreply?.[1]) {
    return noreply[1];
  }
  return undefined;
}

/**
 * Parse `git log --format=%x00%ae%x00%an --name-only` output into
 * login → path → count, restricted to `wantedPaths`. A NUL delimits each commit
 * record and its two author fields, so no author string can be confused for a
 * file path.
 */
export function parseGitLog(
  stdout: string,
  wantedPaths: Set<string>,
  identityMap: Record<string, string>,
): Record<string, Record<string, number>> {
  // Object.create(null): keys are git-derived logins/paths — a literal
  // "__proto__" must never reach a real prototype.
  const result: Record<string, Record<string, number>> = Object.create(null);

  // Each commit's header is "\0\0<email>\0<name>"; splitting on "\0\0" yields one
  // record per commit (parts[0] is empty text before the first commit).
  for (const record of stdout.split("\0\0")) {
    // record: "<email>\0<name>\n<file>\n<file>\n...". No author string can
    // contain NUL, so the first \0 cleanly ends the email.
    const nulIdx = record.indexOf("\0");
    if (nulIdx === -1) {
      continue;
    }
    const email = record.slice(0, nulIdx).trim();
    const rest = record.slice(nulIdx + 1);
    const lines = rest.split("\n");
    const name = (lines[0] ?? "").trim();
    if (!email && !name) {
      continue;
    }
    const login = resolveLogin(email, name, identityMap);
    if (!login) {
      continue;
    }
    for (const line of lines.slice(1)) {
      const path = line.trim();
      if (!path || !wantedPaths.has(path)) {
        continue;
      }
      const paths = result[login] ?? Object.create(null);
      paths[path] = (paths[path] ?? 0) + 1;
      result[login] = paths;
    }
  }

  return result;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Read commit history for `paths` since `sinceIso` from a local clone.
 * Returns login → path → count, matching the GitHub adapter's contract.
 */
export async function getLocalCommitHistory(
  localPath: string,
  paths: string[],
  sinceIso: string,
  identityMap: Record<string, string>,
): Promise<Record<string, Record<string, number>>> {
  if (paths.length === 0) {
    return {};
  }
  // %x00 between and around the author fields makes them unambiguous vs paths.
  const out = await git(localPath, [
    "log",
    `--since=${sinceIso}`,
    "--no-merges",
    "--format=%x00%x00%ae%x00%an",
    "--name-only",
    "--",
    ...paths,
  ]);
  return parseGitLog(out, new Set(paths), identityMap);
}

/**
 * GitHubAdapter that reads commit history from local clones where configured
 * and delegates everything else to a wrapped adapter.
 */
export class LocalGitGitHubAdapter implements GitHubAdapter {
  constructor(
    private readonly base: GitHubAdapter,
    /** repo slug → absolute local clone path. */
    private readonly localPaths: Record<string, string>,
    private readonly identityMap: Record<string, string>,
  ) {}

  async getCommitHistory(
    repo: string,
    paths: string[],
    sinceIso: string,
  ): Promise<Record<string, Record<string, number>>> {
    const localPath = this.localPaths[repo];
    if (!localPath) {
      return this.base.getCommitHistory(repo, paths, sinceIso);
    }
    try {
      const head = (await git(localPath, ["log", "-1", "--format=%cr %h"])).trim();
      console.log(`[local-git] ${repo}: reading commit history from ${localPath} (HEAD ${head}; fetch if stale)`);
      return await getLocalCommitHistory(localPath, paths, sinceIso, this.identityMap);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[local-git] ${repo}: falling back to GitHub API (${message})`);
      return this.base.getCommitHistory(repo, paths, sinceIso);
    }
  }

  // --- everything else delegates to the wrapped adapter ----------------------

  listOpenPullRequests(repo: string): Promise<PullRequest[]> {
    return this.base.listOpenPullRequests(repo);
  }

  getPullRequestFiles(repo: string, prNumber: number): Promise<PullRequest["files"]> {
    return this.base.getPullRequestFiles(repo, prNumber);
  }

  getReviewHistory(repo: string, sinceIso: string): Promise<Record<string, RecentReview[]>> {
    return this.base.getReviewHistory(repo, sinceIso);
  }

  getOpenReviewLoad(logins: string[]): Promise<Record<string, number>> {
    return this.base.getOpenReviewLoad(logins);
  }

  postComment(repo: string, prNumber: number, body: string): Promise<void> {
    return this.base.postComment(repo, prNumber, body);
  }

  requestReviewers(repo: string, prNumber: number, logins: string[]): Promise<void> {
    return this.base.requestReviewers(repo, prNumber, logins);
  }
}
