#!/usr/bin/env node
/**
 * Strategy comparison: re-score every open PR with all five strategies and
 * generate a side-by-side HTML report. Reads from cached SQLite (no sync).
 *
 * Usage:  node dist/compare.js [--out report.html]
 */
import { resolveConfig, type SiaraRepoConfig } from "./config.js";
import { loadConfig } from "./config-loader.js";
import { GhCliGitHubAdapter } from "./adapters/github.js";
import { LocalGitGitHubAdapter } from "./adapters/localGit.js";
import { pickReviewers, type PickResult, ALL_STRATEGIES, type StrategyName } from "./scoring/pickReviewers.js";
import type { PullRequest, DifficultyBand } from "./types.js";
import { computeGini } from "./dashboard/gini.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface PrRow {
  repo: string;
  pr: number;
  title: string;
  author: string;
  band: DifficultyBand;
  difficulty: number;
  picks: Record<StrategyName, string[]>;
  scores: Record<StrategyName, Record<string, number>>;
}

async function main(): Promise<void> {
  const outIdx = process.argv.indexOf("--out");
  const outPath = resolve(
    outIdx !== -1 && process.argv[outIdx + 1]
      ? process.argv[outIdx + 1]!
      : "./strategy-comparison.html",
  );

  const nowIso = new Date().toISOString();
  const { teamConfig, repoConfigs, repos } = loadConfig();

  const { openStore } = await import("./store/sqliteStore.js");
  const store = openStore({
    dbPath: process.env.SIARA_DB ?? "./siara.db",
    assignmentsPath: "./data/assignments.jsonl",
  });
  await store.init();

  const base = new GhCliGitHubAdapter({ dryLog: true });
  const localPaths: Record<string, string> = {};
  for (const rc of repoConfigs) {
    if (rc.localPath) localPaths[rc.repo] = rc.localPath;
  }
  const github =
    Object.keys(localPaths).length > 0
      ? new LocalGitGitHubAdapter(base, localPaths, teamConfig.identityMap)
      : base;

  const findRepoConfig = (repo: string): SiaraRepoConfig | undefined =>
    repoConfigs.find((r) => r.repo === repo);

  const rows: PrRow[] = [];

  for (const repo of repos) {
    const repoConfig = findRepoConfig(repo);
    const resolved = resolveConfig(teamConfig, repoConfig);
    const openPrs: PullRequest[] = await github.listOpenPullRequests(repo);

    for (const pr of openPrs) {
      const logins = resolved.roster;
      const candidates = await store.getCandidateHistory(repo, pr, logins);
      const jira = pr.jiraKey
        ? await store.getJira(pr.jiraKey)
        : undefined;

      const picks: Record<string, string[]> = {};
      const scores: Record<string, Record<string, number>> = {};
      let band: DifficultyBand = "simple";
      let difficulty = 0;

      for (const strategy of ALL_STRATEGIES) {
        const result: PickResult = pickReviewers({
          pr,
          config: resolved,
          candidates,
          jira,
          nowIso,
          strategy,
        });
        picks[strategy] = result.assignees;
        scores[strategy] = result.finalScoreByLogin;
        band = result.difficulty.band;
        difficulty = result.difficulty.score;
      }

      rows.push({
        repo,
        pr: pr.number,
        title: pr.title,
        author: pr.author,
        band,
        difficulty,
        picks: picks as Record<StrategyName, string[]>,
        scores: scores as Record<StrategyName, Record<string, number>>,
      });
    }
  }

  await store.close();

  // Compute aggregate metrics per strategy.
  const metrics = ALL_STRATEGIES.map((s) => {
    const loadByPerson: Record<string, number> = {};
    for (const row of rows) {
      for (const login of row.picks[s]) {
        loadByPerson[login] = (loadByPerson[login] ?? 0) + 1;
      }
    }
    const loads = Object.values(loadByPerson);
    const gini = computeGini(loads);
    const activeReviewers = loads.length;
    const maxLoad = Math.max(0, ...loads);
    const minLoad = loads.length > 0 ? Math.min(...loads) : 0;

    // Agreement with siara baseline.
    let agreesWithSiara = 0;
    for (const row of rows) {
      if (
        row.picks[s].length === row.picks.siara.length &&
        row.picks[s].every((l) => row.picks.siara.includes(l))
      ) {
        agreesWithSiara++;
      }
    }
    const agreementPct =
      rows.length > 0 ? Math.round((agreesWithSiara / rows.length) * 100) : 100;

    return {
      strategy: s,
      gini,
      activeReviewers,
      maxLoad,
      minLoad,
      loadByPerson,
      agreementPct,
    };
  });

  // Write JSON artifact for the dashboard to consume.
  const jsonPath = "./data/strategy-comparison.json";
  const comparison = {
    generatedAt: nowIso,
    totalPrs: rows.length,
    strategies: [...ALL_STRATEGIES],
    metrics,
    prs: rows.map((r) => ({
      repo: r.repo,
      pr: r.pr,
      title: r.title,
      band: r.band,
      difficulty: r.difficulty,
      picks: r.picks,
    })),
  };
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(comparison, null, 2), "utf8");

  // Render standalone HTML.
  const html = renderReport(rows, metrics, nowIso, teamConfig.reviewers);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf8");
  console.log(
    `Strategy comparison: ${rows.length} PRs × ${ALL_STRATEGIES.length} strategies → ${outPath}`,
  );
  console.log(`Dashboard artifact: ${jsonPath}`);
}

type ReviewerDir = Record<string, { name?: string }>;

function dn(login: string, dir: ReviewerDir): string {
  return dir[login]?.name?.trim() || login;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BAND_COLOR: Record<DifficultyBand, string> = {
  simple: "#4f9d69",
  moderate: "#d99b28",
  hard: "#d1495b",
};

const BAND_LABEL: Record<DifficultyBand, string> = {
  simple: "Simple",
  moderate: "Moderate",
  hard: "Hard",
};

interface StrategyMetrics {
  strategy: StrategyName;
  gini: number;
  activeReviewers: number;
  maxLoad: number;
  minLoad: number;
  loadByPerson: Record<string, number>;
  agreementPct: number;
}

function renderReport(
  rows: PrRow[],
  metrics: StrategyMetrics[],
  generatedAt: string,
  dir: ReviewerDir,
): string {
  const strategies = ALL_STRATEGIES;

  // KPI cards.
  const kpis = metrics
    .map(
      (m) => `
    <div class="kpi-card">
      <div class="kpi-strategy">${esc(m.strategy)}</div>
      <div class="kpi-row-inner">
        <div class="kpi"><span class="kpi-label">Gini</span><span class="kpi-value">${m.gini.toFixed(3)}</span></div>
        <div class="kpi"><span class="kpi-label">Reviewers</span><span class="kpi-value">${m.activeReviewers}</span></div>
        <div class="kpi"><span class="kpi-label">Max load</span><span class="kpi-value">${m.maxLoad}</span></div>
        <div class="kpi"><span class="kpi-label">Min load</span><span class="kpi-value">${m.minLoad}</span></div>
        <div class="kpi"><span class="kpi-label">Agrees w/ Siara</span><span class="kpi-value">${m.agreementPct}%</span></div>
      </div>
    </div>`,
    )
    .join("");

  // Load-by-person bar chart: all strategies side-by-side per reviewer.
  const allLogins = [
    ...new Set(metrics.flatMap((m) => Object.keys(m.loadByPerson))),
  ].sort();
  const maxLoad = Math.max(
    1,
    ...metrics.flatMap((m) => Object.values(m.loadByPerson)),
  );
  const barW = 400;
  const rowH = 24;
  const groupH = strategies.length * rowH + 12;
  const labelW = 140;
  const svgH = allLogins.length * groupH + 20;
  const stratColors: Record<string, string> = {
    siara: "#3b6df6",
    "siara-floor": "#e6833a",
    "siara-blend": "#4f9d69",
    "siara-load": "#9b59b6",
    "siara-v2": "#d1495b",
    "siara-noedu": "#16a085",
    whodo: "#f39c12",
    sofia: "#8e44ad",
    whoreview: "#e74c3c",
    meta: "#34495e",
  };

  const loadBars = allLogins
    .map((login, gi) => {
      const gy = gi * groupH;
      const label = `<text x="${labelW - 8}" y="${gy + (groupH - 12) / 2}" class="svg-label" text-anchor="end" dominant-baseline="central">${esc(dn(login, dir))}</text>`;
      const bars = strategies
        .map((s, si) => {
          const v = metrics[si]!.loadByPerson[login] ?? 0;
          const w = (v / maxLoad) * barW;
          const y = gy + si * rowH;
          const color = stratColors[s] ?? "#888";
          return (
            `<rect x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="${rowH - 4}" rx="3" fill="${color}" fill-opacity="0.75"><title>${esc(s)}: ${v}</title></rect>` +
            (v > 0
              ? `<text x="${(labelW + w + 4).toFixed(1)}" y="${y + (rowH - 4) / 2}" class="bar-num" dominant-baseline="central">${v}</text>`
              : "")
          );
        })
        .join("");
      return label + bars;
    })
    .join("");

  const legendItems = strategies
    .map(
      (s) =>
        `<li><span class="swatch" style="background:${stratColors[s] ?? "#888"}"></span>${esc(s)}</li>`,
    )
    .join("");

  // Per-PR comparison table.
  const headerCells = strategies
    .map((s) => `<th>${esc(s)}</th>`)
    .join("");
  const tableRows = rows
    .map((row) => {
      const prLabel = `${row.repo.split("/").pop()}/${row.pr}`;
      const bandBadge = `<span class="badge" style="background:${BAND_COLOR[row.band]}">${BAND_LABEL[row.band]}</span>`;
      const diffScore = row.difficulty.toFixed(2);
      const cells = strategies
        .map((s) => {
          const pick = row.picks[s];
          const isSame =
            pick.length === row.picks.siara.length &&
            pick.every((l) => row.picks.siara.includes(l));
          const cls = s === "siara" ? "" : isSame ? "same" : "diff";
          return `<td class="${cls}">${pick.map((l) => esc(dn(l, dir))).join(", ") || "—"}</td>`;
        })
        .join("");
      return `<tr>
        <td class="pr-cell" title="${esc(row.title)}">${esc(prLabel)}</td>
        <td>${bandBadge} <span class="score">${diffScore}</span></td>
        ${cells}
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Siara — Strategy Comparison</title>
  <style>
${STYLES}
  </style>
</head>
<body>
  <div class="page">
    <header>
      <h1>Siara — Strategy Comparison</h1>
      <p class="subtitle">Side-by-side evaluation of ${strategies.length} reviewer-selection strategies on ${rows.length} open PRs</p>
    </header>

    <section>
      <h2>Aggregate metrics</h2>
      <p class="hint">Lower Gini = more even workload distribution. Agreement = how often this strategy picks the same reviewer as Siara.</p>
      <div class="kpi-grid">${kpis}</div>
    </section>

    <section>
      <h2>Load distribution by reviewer</h2>
      <p class="hint">Bars show how many PRs each strategy would assign to each reviewer. Even bars = fair spread.</p>
      <ul class="legend">${legendItems}</ul>
      <div class="scroll-x">
        <svg class="chart" width="${labelW + barW + 40}" height="${svgH}" viewBox="0 0 ${labelW + barW + 40} ${svgH}" preserveAspectRatio="xMinYMin meet">
          ${loadBars}
        </svg>
      </div>
    </section>

    <section>
      <h2>Per-PR picks</h2>
      <p class="hint">Green = same as Siara, red = different pick. Hover PR for title.</p>
      <div class="scroll-x">
      <table>
        <thead>
          <tr><th>PR</th><th>Difficulty</th>${headerCells}</tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      </div>
    </section>

    <footer>Generated ${esc(generatedAt.slice(0, 19).replace("T", " "))} UTC — cached data (no sync)</footer>
  </div>
</body>
</html>`;
}

const STYLES = `
  :root {
    --bg: #f7f8fa;
    --surface: #ffffff;
    --text: #191c24;
    --muted: #5c6370;
    --border: #e4e7ec;
    --accent: #3b6df6;
  }
  * { box-sizing: border-box; }
  html { font-size: 14px; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text);
    line-height: 1.5; -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 1100px; margin: 0 auto; padding: 2.5rem 1.25rem 3rem; }
  header { margin-bottom: 2rem; }
  h1 { margin: 0; font-size: 1.6rem; font-weight: 650; letter-spacing: -0.02em; }
  h2 { margin: 0 0 0.35rem; font-size: 1.05rem; font-weight: 620; }
  .subtitle { margin: 0.4rem 0 0; color: var(--muted); font-size: 0.95rem; }
  .hint { margin: 0 0 1rem; font-size: 0.82rem; color: var(--muted); }
  section {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 1.25rem 1.4rem; margin-bottom: 1.5rem;
  }
  .kpi-grid { display: flex; gap: 1rem; flex-wrap: wrap; }
  .kpi-card {
    flex: 1 1 180px; min-width: 180px;
    border: 1px solid var(--border); border-radius: 10px;
    padding: 0.9rem 1rem;
  }
  .kpi-strategy {
    font-size: 0.9rem; font-weight: 650; margin-bottom: 0.5rem;
    text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent);
  }
  .kpi-row-inner { display: flex; flex-wrap: wrap; gap: 0.6rem 1.2rem; }
  .kpi { display: flex; flex-direction: column; }
  .kpi-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; color: var(--muted); letter-spacing: 0.04em; }
  .kpi-value { font-size: 1.1rem; font-weight: 680; font-variant-numeric: tabular-nums; }
  .legend { list-style: none; margin: 0 0 0.8rem; padding: 0; display: flex; gap: 1rem; font-size: 0.82rem; color: var(--muted); }
  .legend li { display: flex; align-items: center; gap: 0.4rem; }
  .swatch { width: 0.7rem; height: 0.7rem; border-radius: 3px; flex: none; }
  .chart { display: block; }
  .svg-label { fill: var(--text); font-size: 12px; }
  .bar-num { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .scroll-x { overflow-x: auto; padding-bottom: 0.3rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 0.5rem 0.5rem; text-align: left; border-bottom: 1px solid var(--border); vertical-align: middle; white-space: nowrap; }
  th { font-size: 0.72rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  tr:last-child td { border-bottom: none; }
  .pr-cell { font-weight: 500; max-width: 10rem; overflow: hidden; text-overflow: ellipsis; }
  .badge {
    display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px;
    font-size: 0.72rem; font-weight: 600; color: #fff;
  }
  .score { color: var(--muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; }
  td.same { background: #e8f5e9; }
  td.diff { background: #fce4ec; }
  footer { margin-top: 2rem; font-size: 0.82rem; color: var(--muted); text-align: center; }
`;

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
