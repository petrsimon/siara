/**
 * Runtime contract: dependency bundle + top-level entrypoints (sync / daily /
 * dry-run). These signatures are LOCKED — sync.ts, daily.ts, and dryRun.ts
 * implement them; the CLI and the real adapters depend on them.
 */
import type { GitHubAdapter, JiraAdapter, SlackAdapter } from "../adapters/index.js";
import type { SiaraRepoConfig, SiaraTeamConfig } from "../config.js";
import type { SiaraStore } from "../store/index.js";
import type { Assignment } from "../types.js";

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
}

// --- entrypoints (implemented in sibling files) ------------------------------

export { sync } from "./sync.js";
export { daily } from "./daily.js";
export { dryRun } from "./dryRun.js";
