/**
 * SQLite-backed SiaraStore. Caches GitHub/Jira sync signals; assignments live in JSONL.
 */
import Database from "better-sqlite3";
import type {
  Assignment,
  CandidateHistory,
  Decline,
  JiraData,
  OpenPrsSnapshot,
  Override,
  PullRequest,
  RecentReview,
  RepoMaintainers,
  ResponseTimeReport,
  ReviewHistoryPage,
} from "../types.js";
import { pathsForPr } from "../util/paths.js";
import { appendAssignmentFile, readAssignmentsFile } from "./assignmentsLog.js";
import {
  appendOverrideFile,
  overridesPathFor,
  readOverridesFile,
} from "./overridesLog.js";
import {
  readOpenPrsSnapshot,
  snapshotPathFor,
  writeOpenPrsSnapshot,
} from "./snapshotLog.js";
import {
  readResponseReport,
  responsePathFor,
  writeResponseReport,
} from "./responseLog.js";
import type { ReviewEvent, SiaraStore, StoreOptions } from "./index.js";

/** Cached signals + sync bookkeeping. Assignments are stored separately in JSONL. */
export class SqliteStore implements SiaraStore {
  private readonly db: Database.Database;
  private readonly assignmentsPath: string;
  private readonly overridesPath: string;
  private readonly snapshotPath: string;
  private readonly responsePath: string;

  constructor(opts: StoreOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.assignmentsPath = opts.assignmentsPath;
    this.overridesPath =
      opts.overridesPath ?? overridesPathFor(opts.assignmentsPath);
    this.snapshotPath = snapshotPathFor(opts.assignmentsPath);
    this.responsePath = responsePathFor(opts.assignmentsPath);
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

      -- review_history: recent reviews per author on a repo. Merged incrementally
      -- by PR (rows for rescanned PRs are replaced), pruned to the sync window.
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
      CREATE INDEX IF NOT EXISTS idx_review_history_repo_pr
        ON review_history (repo, pr_number);

      -- review_watermark: highest PR number whose reviews are already ingested,
      -- so the next sync only pulls PRs above it (plus always-rescanned open PRs).
      CREATE TABLE IF NOT EXISTS review_watermark (
        repo TEXT PRIMARY KEY,
        max_pr_number INTEGER NOT NULL
      );

      -- open_load: current open review assignments per login.
      CREATE TABLE IF NOT EXISTS open_load (
        login TEXT PRIMARY KEY,
        load INTEGER NOT NULL
      );

      -- busy_load: per-login "heads-down" weight (jira/manual) reducing review capacity.
      CREATE TABLE IF NOT EXISTS busy_load (
        login TEXT PRIMARY KEY,
        busy REAL NOT NULL
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

      -- maintainers: cached CODEOWNERS + maintain/admin collaborators per repo.
      CREATE TABLE IF NOT EXISTS maintainers (
        repo TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      -- declines: reviewers removed after Siara assigned them.
      CREATE TABLE IF NOT EXISTS declines (
        repo TEXT NOT NULL,
        pr INTEGER NOT NULL,
        login TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (repo, pr, login)
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

  async mergeReviewHistory(
    repo: string,
    page: ReviewHistoryPage,
    windowStartIso: string,
  ): Promise<void> {
    const deleteForPr = this.db.prepare(
      `DELETE FROM review_history WHERE repo = ? AND pr_number = ?`,
    );
    const insert = this.db.prepare(`
      INSERT INTO review_history (repo, login, pr_number, branch, jira_epic, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const prune = this.db.prepare(
      `DELETE FROM review_history WHERE repo = ? AND reviewed_at < ?`,
    );
    const setWatermark = this.db.prepare(`
      INSERT INTO review_watermark (repo, max_pr_number)
      VALUES (?, ?)
      ON CONFLICT (repo) DO UPDATE SET
        max_pr_number = MAX(max_pr_number, excluded.max_pr_number)
    `);

    const tx = this.db.transaction((r: string, p: ReviewHistoryPage) => {
      // Replace rows for exactly the PRs we rescanned — old PRs untouched.
      for (const prNumber of p.scannedPrNumbers) {
        deleteForPr.run(r, prNumber);
      }
      for (const [login, reviewList] of Object.entries(p.reviews)) {
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
      // Drop anything that has aged out of the window.
      prune.run(r, windowStartIso);
      setWatermark.run(r, p.maxPrNumber);
    });

    tx(repo, page);
  }

  async getReviewWatermark(repo: string): Promise<number | undefined> {
    const row = this.db
      .prepare(`SELECT max_pr_number FROM review_watermark WHERE repo = ?`)
      .get(repo) as { max_pr_number: number } | undefined;
    return row?.max_pr_number;
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

  async upsertBusyLoad(busy: Record<string, number>): Promise<void> {
    const upsert = this.db.prepare(`
      INSERT INTO busy_load (login, busy)
      VALUES (?, ?)
      ON CONFLICT (login) DO UPDATE SET busy = excluded.busy
    `);

    const tx = this.db.transaction((data: Record<string, number>) => {
      for (const [login, busyWeight] of Object.entries(data)) {
        upsert.run(login, busyWeight);
      }
    });

    tx(busy);
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
    const relevantPaths = new Set(pathsForPr(pr));

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
    const busyStmt = this.db.prepare(
      `SELECT busy FROM busy_load WHERE login = ?`,
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

      const busyRow = busyStmt.get(login) as { busy: number } | undefined;
      const jiraBusy = busyRow?.busy ?? 0;

      return {
        login,
        commitsByPath,
        repoReviewCount,
        openReviewLoad,
        jiraBusy,
        recentReviews,
      };
    });
  }

  async appendAssignment(a: Assignment): Promise<void> {
    appendAssignmentFile(this.assignmentsPath, a);
  }

  async readAssignments(): Promise<Assignment[]> {
    return readAssignmentsFile(this.assignmentsPath);
  }

  async appendOverride(o: Override): Promise<void> {
    appendOverrideFile(this.overridesPath, o);
  }

  async readOverrides(): Promise<Override[]> {
    return readOverridesFile(this.overridesPath);
  }

  async writeOpenPrsSnapshot(snapshot: OpenPrsSnapshot): Promise<void> {
    writeOpenPrsSnapshot(this.snapshotPath, snapshot);
  }

  async readOpenPrsSnapshot(): Promise<OpenPrsSnapshot | undefined> {
    return readOpenPrsSnapshot(this.snapshotPath);
  }

  async getReviewEvents(repo: string, prNumbers: number[]): Promise<ReviewEvent[]> {
    if (prNumbers.length === 0) return [];
    const placeholders = prNumbers.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT pr_number, login, reviewed_at
         FROM review_history
         WHERE repo = ? AND pr_number IN (${placeholders})`,
      )
      .all(repo, ...prNumbers) as Array<{
      pr_number: number;
      login: string;
      reviewed_at: string;
    }>;
    return rows.map((r) => ({
      pr: r.pr_number,
      login: r.login,
      reviewedAt: r.reviewed_at,
    }));
  }

  async writeResponseReport(report: ResponseTimeReport): Promise<void> {
    writeResponseReport(this.responsePath, report);
  }

  async readResponseReport(): Promise<ResponseTimeReport | undefined> {
    return readResponseReport(this.responsePath);
  }

  async upsertMaintainers(data: RepoMaintainers): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO maintainers (repo, data, fetched_at)
         VALUES (?, ?, ?)
         ON CONFLICT (repo) DO UPDATE SET
           data = excluded.data,
           fetched_at = excluded.fetched_at`,
      )
      .run(data.repo, JSON.stringify(data), data.fetchedAt);
  }

  async getMaintainers(repo: string): Promise<RepoMaintainers | undefined> {
    const row = this.db
      .prepare(`SELECT data FROM maintainers WHERE repo = ?`)
      .get(repo) as { data: string } | undefined;
    if (!row) {
      return undefined;
    }
    return JSON.parse(row.data) as RepoMaintainers;
  }

  async recordDecline(d: Decline): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO declines (repo, pr, login, at) VALUES (?, ?, ?, ?)`,
      )
      .run(d.repo, d.pr, d.login, d.at);
  }

  async getDeclines(repo: string, pr: number): Promise<string[]> {
    const rows = this.db
      .prepare(`SELECT login FROM declines WHERE repo = ? AND pr = ?`)
      .all(repo, pr) as Array<{ login: string }>;
    return rows.map((r) => r.login);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Open a store at the given paths. Caller must call init() before use. */
export function openStore(opts: StoreOptions): SqliteStore {
  return new SqliteStore(opts);
}
