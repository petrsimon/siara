#!/usr/bin/env node
/**
 * Siara CLI — composition root for sync, daily, dry-run, and dashboard.
 */
import type { JiraAdapter } from "./adapters/index.js";
import { GhCliGitHubAdapter } from "./adapters/github.js";
import { JiraCloudAdapter } from "./adapters/jira.js";
import { LocalGitGitHubAdapter } from "./adapters/localGit.js";
import { SlackHttpAdapter } from "./adapters/slack.js";
import type { SlackAdapter } from "./adapters/index.js";
import type { SiaraTeamConfig } from "./config.js";
import { loadConfig } from "./config-loader.js";
import { generateDashboard } from "./dashboard/index.js";
import { daily, dryRun, sync } from "./runtime/index.js";
import { readAssignmentsFile } from "./store/assignmentsLog.js";
import { overridesPathFor, readOverridesFile } from "./store/overridesLog.js";
import { readOpenPrsSnapshot, snapshotPathFor } from "./store/snapshotLog.js";
import { readResponseReport, responsePathFor } from "./store/responseLog.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ASSIGNMENTS_PATH = "./data/assignments.jsonl";

const USAGE = `Siara — deterministic PR reviewer assigner

Usage:
  siara sync              Fetch GitHub/Jira signals into the local store
  siara daily [--no-sync] [--no-post]   Assign reviewers for pending PRs
  siara shadow [--no-sync]    Compute + log recommendations; post nothing (shadow mode)
  siara dry-run [--no-sync]   Score pending PRs without side effects
  siara dashboard [--out <file>]   Generate HTML dashboard (default: ./dashboard.html)
  siara admin [--port <n>]    Local editable reviewer admin page (default: 4319)
  siara --help            Show this help

Flags:
  --no-sync   Skip the sync step; score from the cached store (fast iteration)
  --no-post   Compute + write local artifacts but post nothing to GitHub/Slack

Environment:
  SIARA_CONFIG   Path to config JSON (default: ./siara.config.json)
  SIARA_DB       Path to SQLite database (default: ./siara.db)
`;

const noopJira: JiraAdapter = {
  async getIssueData() {
    return {};
  },
  // No real Jira yet — reviewer busyness comes from the manual `reviewerBusy`
  // config map, merged in by sync. Wire a real query here later.
  async getReviewerWorkload() {
    return {};
  },
};

/**
 * Real Jira Cloud adapter when config.jira + JIRA_USER/JIRA_ACCESS_TOKEN are all
 * present; otherwise the noop (busyness falls back to the manual reviewerBusy
 * map). Credentials come from the environment, never from config.
 */
function makeJira(teamConfig: SiaraTeamConfig): JiraAdapter {
  const email = process.env.JIRA_USER;
  const token = process.env.JIRA_ACCESS_TOKEN;
  if (teamConfig.jira && email && token) {
    return new JiraCloudAdapter({ email, token, config: teamConfig.jira });
  }
  if (teamConfig.jira && (!email || !token)) {
    console.warn(
      "Jira configured but JIRA_USER / JIRA_ACCESS_TOKEN not set — using manual reviewerBusy only.",
    );
  }
  return noopJira;
}

/**
 * Real Slack adapter when config.slack + SLACK_TOKEN are both present; otherwise
 * undefined (daily skips Slack posts). The token comes from the environment,
 * never from config; per RH policy it must target the sandbox workspace.
 */
function makeSlack(teamConfig: SiaraTeamConfig): SlackAdapter | undefined {
  const token = process.env.SLACK_TOKEN;
  if (teamConfig.slack && token) {
    return new SlackHttpAdapter({ token, channel: teamConfig.slack.channel });
  }
  if (teamConfig.slack && !token) {
    console.warn("Slack configured but SLACK_TOKEN not set — skipping Slack posts.");
  }
  return undefined;
}

function parseDashboardOut(argv: string[]): string {
  const outIdx = argv.indexOf("--out");
  if (outIdx !== -1 && argv[outIdx + 1]) {
    return argv[outIdx + 1]!;
  }
  return "./dashboard.html";
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE.trim());
    return;
  }

  const nowIso = new Date().toISOString();
  const noSync = process.argv.includes("--no-sync");
  const noPost = process.argv.includes("--no-post");

  // Dashboard only reads the git-tracked JSONL log — no config, adapters, or
  // SQLite (avoids loading the better-sqlite3 native addon entirely).
  if (command === "dashboard") {
    const outPath = resolve(parseDashboardOut(process.argv));
    const assignments = readAssignmentsFile(ASSIGNMENTS_PATH);
    const overrides = readOverridesFile(overridesPathFor(ASSIGNMENTS_PATH));
    const openPrs = readOpenPrsSnapshot(snapshotPathFor(ASSIGNMENTS_PATH));
    const responseTimes = readResponseReport(responsePathFor(ASSIGNMENTS_PATH));
    // Optional: pull real names / emails / age thresholds from config. The
    // dashboard must render without a config (public repo, gitignored config),
    // so a missing/invalid config degrades to logins + default thresholds.
    let reviewers: Record<string, { name?: string; email?: string }> | undefined;
    let staleness: { warningDays: number; overdueDays: number } | undefined;
    try {
      const { teamConfig } = loadConfig();
      reviewers = teamConfig.reviewers;
      staleness = teamConfig.staleness;
    } catch {
      // No config available — fall back to defaults inside the renderer.
    }
    const html = generateDashboard({
      assignments,
      overrides,
      openPrs,
      responseTimes,
      reviewers,
      staleness,
      generatedAtIso: nowIso,
    });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, "utf8");
    console.log(`Dashboard written to ${outPath} (${assignments.length} assignment(s))`);
    return;
  }

  // Local admin page — reads/writes config only, no store or adapters.
  if (command === "admin") {
    const { startAdminServer } = await import("./admin/index.js");
    const { teamConfig } = loadConfig();
    const portIdx = process.argv.indexOf("--port");
    const port =
      portIdx !== -1 && process.argv[portIdx + 1]
        ? Number(process.argv[portIdx + 1])
        : 4319;
    const configPath = process.env.SIARA_CONFIG ?? "./siara.config.json";
    startAdminServer({ configPath, port, roster: teamConfig.roster });
    console.log(`Siara admin page: http://127.0.0.1:${port}  (Ctrl-C to stop)`);
    console.log(`Editing ${resolve(configPath)}`);
    return; // keep the process alive on the listening server
  }

  // sync / daily / dry-run need the SQLite store — load it lazily so `dashboard`
  // never pulls in the native addon.
  const { openStore } = await import("./store/sqliteStore.js");
  const store = openStore({
    dbPath: process.env.SIARA_DB ?? "./siara.db",
    assignmentsPath: ASSIGNMENTS_PATH,
  });

  try {
    await store.init();

    const { teamConfig, repoConfigs, repos } = loadConfig();
    const base = new GhCliGitHubAdapter({ dryLog: command === "dry-run" });

    // Read commit history from local clones where configured (much cheaper than
    // the commits API); everything else still goes through gh.
    const localPaths: Record<string, string> = {};
    for (const rc of repoConfigs) {
      if (rc.localPath) {
        localPaths[rc.repo] = rc.localPath;
      }
    }
    const github =
      Object.keys(localPaths).length > 0
        ? new LocalGitGitHubAdapter(base, localPaths, teamConfig.identityMap)
        : base;
    const deps = {
      store,
      github,
      jira: makeJira(teamConfig),
      slack: makeSlack(teamConfig),
      teamConfig,
      repoConfigs,
      repos,
    };

    switch (command) {
      case "sync": {
        const results = await sync(deps, nowIso);
        if (results.length === 0) {
          console.log("No repos synced.");
        } else {
          console.log(`Synced ${results.length} repo(s):`);
          for (const r of results) {
            const mode = r.coldStart ? "cold start" : "incremental";
            console.log(`  ${r.repo} (${mode}) @ ${r.syncedAtIso}`);
            for (const g of r.giantPrs) {
              console.warn(
                `    ⚠ giant PR #${g.pr} by ${g.author} — ${g.fileCount} files (heavy commit-history cost; consider splitting)`,
              );
            }
          }
        }
        break;
      }
      case "shadow":
      case "daily": {
        // `shadow` = daily that posts nothing (also via `daily --no-post`).
        const post = command === "shadow" ? false : !noPost;
        const result = await daily(deps, nowIso, { noSync, post });
        if (!post) {
          console.log("[SHADOW] Computing recommendations — no GitHub or Slack posts.");
        }
        for (const s of result.synced) {
          const mode = s.coldStart ? "cold start" : "incremental";
          console.log(`Synced ${s.repo} (${mode})`);
          for (const g of s.giantPrs) {
            console.warn(
              `  ⚠ giant PR #${g.pr} by ${g.author} — ${g.fileCount} files`,
            );
          }
        }
        if (result.assigned.length === 0) {
          console.log("No PRs assigned.");
        } else {
          console.log(`Assigned ${result.assigned.length} PR(s):`);
          for (const a of result.assigned) {
            console.log(`  ${a.repo}#${a.pr} → ${a.assignees.join(", ")} [${a.band}]`);
          }
        }
        if (result.overrides.length > 0) {
          console.log(`Detected ${result.overrides.length} manual override(s):`);
          for (const o of result.overrides) {
            console.log(
              `  ${o.repo}#${o.pr} suggested [${o.suggested.join(", ")}] → actual [${o.actual.join(", ")}]`,
            );
          }
        }
        break;
      }
      case "dry-run": {
        const result = await dryRun(deps, nowIso, { noSync });
        if (result.assigned.length === 0) {
          console.log("[DRY RUN] No pending PRs to score.");
        } else {
          for (const a of result.assigned) {
            console.log(
              `[DRY RUN] ${a.repo}#${a.pr} → ${a.assignees.join(", ")} [${a.band}]`,
            );
            console.log(`  ${a.rationale}`);
          }
        }
        break;
      }
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE.trim());
        process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
