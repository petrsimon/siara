/**
 * Runtime contract: dependency bundle + top-level entrypoints (sync / daily /
 * dry-run). These signatures are LOCKED — sync.ts, daily.ts, and dryRun.ts
 * implement them; the CLI and the real adapters depend on them.
 */
import type { GitHubAdapter, JiraAdapter, SlackAdapter } from "../adapters/index.js";
import type { SiaraRepoConfig, SiaraTeamConfig } from "../config.js";
import type { SiaraStore } from "../store/index.js";
import type { StrategyName } from "../scoring/pickReviewers.js";
import type { Assignment, Override } from "../types.js";

/** Everything a runtime entrypoint needs, injected for testability. */
export interface SiaraDeps {
  store: SiaraStore;
  github: GitHubAdapter;
  jira: JiraAdapter;
  /** Optional — daily posts to Slack when present. */
  slack?: SlackAdapter;
  teamConfig: SiaraTeamConfig;
  /** Per-repo overrides; repos to operate on are the union of these + team scope. */
  repoConfigs: SiaraRepoConfig[];
  /** Repos to process (e.g. "org/name"). */
  repos: string[];
}

/** An open PR flagged for touching an unusually large number of files. */
export interface GiantPr {
  pr: number;
  author: string;
  fileCount: number;
}

export interface SyncResult {
  repo: string;
  /** True = full cold-start sync; false = incremental. */
  coldStart: boolean;
  syncedAtIso: string;
  /** Open PRs exceeding teamConfig.giantPrFileThreshold (reported, not capped). */
  giantPrs: GiantPr[];
}

export interface DailyOptions {
  /** When true, compute + print but perform NO side effects (no comments, no
   * review requests, no Slack posts, no JSONL append). */
  dryRun?: boolean;
  /** When true, skip the sync step and score from the cached store. Open PRs
   * are still listed fresh; commit/review/load signals come from the last sync.
   * Fast iteration on scoring/config without a full re-sync. */
  noSync?: boolean;
  /** When false, run "shadow mode": compute assignments and write the local
   * git-tracked artifacts (assignment log, snapshot, response-times) but post
   * NOTHING to GitHub or Slack. The log is deduped per PR so repeated runs don't
   * bloat it. Defaults to true (post). Ignored when dryRun is true. */
  post?: boolean;
  /** Scoring strategy override (default: "siara"). */
  strategy?: StrategyName;
}

export interface DailyPrResult {
  repo: string;
  pr: number;
  assignees: string[];
  band: Assignment["band"];
  rationale: string;
}

export interface DailyResult {
  synced: SyncResult[];
  assigned: DailyPrResult[];
  /** Manual reviewer changes detected this run (logged, never reverted). */
  overrides: Override[];
}

// --- entrypoints (implemented in sibling files) ------------------------------

export { sync } from "./sync.js";
export { daily } from "./daily.js";
export { dryRun } from "./dryRun.js";
export { backfill, type BackfillResult } from "./backfill.js";
