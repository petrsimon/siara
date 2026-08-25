/**
 * SQLite-backed SiaraStore. Caches GitHub/Jira sync signals; assignments live in JSONL.
 */
import Database from "better-sqlite3";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Assignment, CandidateHistory, JiraData, PullRequest, RecentReview } from "../types.js";
import { dirOf } from "../util/paths.js";
import type { SiaraStore, StoreOptions } from "./index.js";

/** Cached signals + sync bookkeeping. Assignments are stored separately in JSONL. */
export class SqliteStore implements SiaraStore {
  private readonly db: Database.Database;
  private readonly assignmentsPath: string;

  constructor(opts: StoreOptions) {
    this.db = new Database(opts.dbPath);
    this.assignmentsPath = opts.assignmentsPath;
  }

  async init(): Promise<void> {
    // commit_history: per-author file touch counts within the sync window.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commit_history (
        repo TEXT NOT NULL,
        login TEXT NOT NULL,
        path TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (repo, login, path)
      );
      CREATE INDEX IF NOT EXISTS idx_commit_history_repo_login
        ON commit_history (repo, login);

      -- review_history: recent reviews per author on a repo (replaced wholesale per login on sync).
      CREATE TABLE IF NOT EXISTS review_history (
        repo TEXT NOT NULL,
        login TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        branch TEXT NOT NULL,
        jira_epic TEXT,
        reviewed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_history_repo_login
        ON review_history (repo, login);

      -- open_load: current open review assignments per login.
      CREATE TABLE IF NOT EXISTS open_load (
        login TEXT PRIMARY KEY,
        load INTEGER NOT NULL
      );

      -- jira_cache: ticket signals fetched from Jira.
      CREATE TABLE IF NOT EXISTS jira_cache (
        key TEXT PRIMARY KEY,
        estimate REAL,
        priority TEXT,
        epic TEXT
      );

      -- sync_state: last successful sync timestamp per repo.
      CREATE TABLE IF NOT EXISTS sync_state (
        repo TEXT PRIMARY KEY,
        last_sync_at TEXT NOT NULL
      );
    `);
  }

  async upsertCommitHistory(
    repo: string,
    commits: Record<string, Record<string, number>>,
  ): Promise<void> {
    const upsert = this.db.prepare(`
      INSERT INTO commit_history (repo, login, path, count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (repo, login, path) DO UPDATE SET count = excluded.count
    `);

    const tx = this.db.transaction(
      (r: string, data: Record<string, Record<string, number>>) => {
        for (const [login, paths] of Object.entries(data)) {
          for (const [path, count] of Object.entries(paths)) {
            upsert.run(r, login, path, count);
          }
        }
      },
    );

    tx(repo, commits);
  }

  async upsertReviewHistory(
    repo: string,
    reviews: Record<string, RecentReview[]>,
  ): Promise<void> {
    const deleteForLogin = this.db.prepare(
      `DELETE FROM review_history WHERE repo = ? AND login = ?`,
    );
    const insert = this.db.prepare(`
      INSERT INTO review_history (repo, login, pr_number, branch, jira_epic, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(
      (r: string, data: Record<string, RecentReview[]>) => {
        for (const [login, reviewList] of Object.entries(data)) {
          deleteForLogin.run(r, login);
          for (const review of reviewList) {
            insert.run(
              r,
              login,
              review.prNumber,
              review.branch,
              review.jiraEpic ?? null,
              review.reviewedAt,
            );
          }
        }
      },
    );

    tx(repo, reviews);
  }

  async upsertOpenLoad(loads: Record<string, number>): Promise<void> {
    const upsert = this.db.prepare(`
      INSERT INTO open_load (login, load)
      VALUES (?, ?)
      ON CONFLICT (login) DO UPDATE SET load = excluded.load
    `);

    const tx = this.db.transaction((data: Record<string, number>) => {
      for (const [login, load] of Object.entries(data)) {
        upsert.run(login, load);
      }
    });

    tx(loads);
  }

  async upsertJira(key: string, data: JiraData): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO jira_cache (key, estimate, priority, epic)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET
          estimate = excluded.estimate,
          priority = excluded.priority,
          epic = excluded.epic
      `)
      .run(
        key,
        data.estimate ?? null,
        data.priority ?? null,
        data.epic ?? null,
      );
  }

  async getJira(key: string): Promise<JiraData | undefined> {
    const row = this.db
      .prepare(`SELECT estimate, priority, epic FROM jira_cache WHERE key = ?`)
      .get(key) as
      | { estimate: number | null; priority: string | null; epic: string | null }
      | undefined;

    if (!row) {
      return undefined;
    }

    const data: JiraData = {};
    if (row.estimate != null) {
      data.estimate = row.estimate;
    }
    if (row.priority != null && row.priority !== "") {
      data.priority = row.priority as JiraData["priority"];
    }
    if (row.epic != null && row.epic !== "") {
      data.epic = row.epic;
    }

    return Object.keys(data).length > 0 ? data : {};
  }

  async getLastSyncAt(repo: string): Promise<string | undefined> {
    const row = this.db
      .prepare(`SELECT last_sync_at FROM sync_state WHERE repo = ?`)
      .get(repo) as { last_sync_at: string } | undefined;
    return row?.last_sync_at;
  }

  async setLastSyncAt(repo: string, iso: string): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO sync_state (repo, last_sync_at)
        VALUES (?, ?)
        ON CONFLICT (repo) DO UPDATE SET last_sync_at = excluded.last_sync_at
      `)
      .run(repo, iso);
  }

  async getCandidateHistory(
    repo: string,
    pr: PullRequest,
    logins: string[],
  ): Promise<CandidateHistory[]> {
    const relevantPaths = pathsForPr(pr);

    const commitsStmt = this.db.prepare(
      `SELECT path, count FROM commit_history WHERE repo = ? AND login = ?`,
    );
    const reviewCountStmt = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM review_history WHERE repo = ? AND login = ?`,
    );
    const reviewsStmt = this.db.prepare(
      `SELECT pr_number, branch, jira_epic, reviewed_at
       FROM review_history WHERE repo = ? AND login = ?`,
    );
    const loadStmt = this.db.prepare(
      `SELECT load FROM open_load WHERE login = ?`,
    );

    return logins.map((login) => {
      const commitRows = commitsStmt.all(repo, login) as Array<{
        path: string;
        count: number;
      }>;

      const commitsByPath: Record<string, number> = {};
      for (const row of commitRows) {
        if (relevantPaths.has(row.path)) {
          commitsByPath[row.path] = row.count;
        }
      }

      const reviewCountRow = reviewCountStmt.get(repo, login) as { cnt: number };
      const repoReviewCount = reviewCountRow.cnt;

      const reviewRows = reviewsStmt.all(repo, login) as Array<{
        pr_number: number;
        branch: string;
        jira_epic: string | null;
        reviewed_at: string;
      }>;

      const recentReviews: RecentReview[] = reviewRows.map((row) => {
        const review: RecentReview = {
          prNumber: row.pr_number,
          branch: row.branch,
          reviewedAt: row.reviewed_at,
        };
        if (row.jira_epic != null && row.jira_epic !== "") {
          review.jiraEpic = row.jira_epic;
        }
        return review;
      });

      const loadRow = loadStmt.get(login) as { load: number } | undefined;
      const openReviewLoad = loadRow?.load ?? 0;

      return {
        login,
        commitsByPath,
        repoReviewCount,
        openReviewLoad,
        recentReviews,
      };
    });
  }

  async appendAssignment(a: Assignment): Promise<void> {
    const parent = dirname(this.assignmentsPath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    appendFileSync(this.assignmentsPath, `${JSON.stringify(a)}\n`);
  }

  async readAssignments(): Promise<Assignment[]> {
    if (!existsSync(this.assignmentsPath)) {
      return [];
    }

    const content = readFileSync(this.assignmentsPath, "utf-8");
    const out: Assignment[] = [];
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as Assignment);
      } catch {
        // Skip a corrupt/partial line (e.g. from a crashed append) rather than
        // failing the whole dashboard/log read.
        console.warn(`readAssignments: skipping malformed line in ${this.assignmentsPath}`);
      }
    }
    return out;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Open a store at the given paths. Caller must call init() before use. */
export function openStore(opts: StoreOptions): SqliteStore {
  return new SqliteStore(opts);
}

/** File paths and parent dirs touched by a PR — used to filter commit history. */
function pathsForPr(pr: PullRequest): Set<string> {
  const paths = new Set<string>();
  for (const file of pr.files) {
    paths.add(file.path);
    paths.add(dirOf(file.path));
  }
  return paths;
}
