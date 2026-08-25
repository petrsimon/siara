#!/usr/bin/env node
/**
 * Siara CLI — composition root for sync, daily, dry-run, and dashboard.
 */
import type { JiraAdapter } from "./adapters/index.js";
import { GhCliGitHubAdapter } from "./adapters/github.js";
import { loadConfig } from "./config-loader.js";
import { generateDashboard } from "./dashboard/index.js";
import { daily, dryRun, sync } from "./runtime/index.js";
import { readAssignmentsFile } from "./store/assignmentsLog.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ASSIGNMENTS_PATH = "./data/assignments.jsonl";

const USAGE = `Siara — deterministic PR reviewer assigner

Usage:
  siara sync              Fetch GitHub/Jira signals into the local store
  siara daily             Assign reviewers for pending PRs
  siara dry-run           Score pending PRs without side effects
  siara dashboard [--out <file>]   Generate HTML dashboard (default: ./dashboard.html)
  siara --help            Show this help

Environment:
  SIARA_CONFIG   Path to config JSON (default: ./siara.config.json)
  SIARA_DB       Path to SQLite database (default: ./siara.db)
`;

const noopJira: JiraAdapter = {
  async getIssueData() {
    return {};
  },
};

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

  // Dashboard only reads the git-tracked JSONL log — no config, adapters, or
  // SQLite (avoids loading the better-sqlite3 native addon entirely).
  if (command === "dashboard") {
    const outPath = resolve(parseDashboardOut(process.argv));
    const assignments = readAssignmentsFile(ASSIGNMENTS_PATH);
    const html = generateDashboard({ assignments, generatedAtIso: nowIso });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, "utf8");
    console.log(`Dashboard written to ${outPath} (${assignments.length} assignment(s))`);
    return;
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
    const github = new GhCliGitHubAdapter({ dryLog: command === "dry-run" });
    const deps = {
      store,
      github,
      jira: noopJira,
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
      case "daily": {
        const result = await daily(deps, nowIso);
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
        break;
      }
      case "dry-run": {
        const result = await dryRun(deps, nowIso);
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
