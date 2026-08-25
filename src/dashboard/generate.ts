import type { DashboardInput } from "./index.js";
import { buildMetrics } from "./metrics.js";
import { escapeHtml } from "./html.js";

const BANDS = ["simple", "moderate", "hard"] as const;

export function renderDashboardHtml(input: DashboardInput): string {
  const metrics = buildMetrics(input.assignments);
  const maxReviews = Math.max(
    0,
    ...Object.values(metrics.reviewsPerPerson),
  );

  const reviewerRows = Object.entries(metrics.reviewsPerPerson)
    .sort(([loginA, countA], [loginB, countB]) => {
      if (countB !== countA) {
        return countB - countA;
      }
      return loginA.localeCompare(loginB);
    })
    .map(([login, count]) => {
      const barWidth =
        maxReviews > 0 ? Math.round((count / maxReviews) * 100) : 0;
      const safeLogin = escapeHtml(login);
      return `
        <tr>
          <td class="login">${safeLogin}</td>
          <td class="count">${count}</td>
          <td class="bar-cell">
            <div class="bar-track" role="presentation">
              <div class="bar-fill" style="width: ${barWidth}%"></div>
            </div>
          </td>
        </tr>`;
    })
    .join("");

  const bandRows = BANDS.map((band) => {
    const count = metrics.bandDistribution[band];
    return `
        <tr>
          <td class="band-label">${escapeHtml(band)}</td>
          <td class="count">${count}</td>
        </tr>`;
  }).join("");

  const generatedAt = escapeHtml(input.generatedAtIso);
  const giniFormatted = metrics.giniWork.toFixed(2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Siara — Review Fairness Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f8f9fb;
      --surface: #ffffff;
      --text: #1a1d26;
      --muted: #5c6370;
      --border: #d8dce3;
      --accent: #2563eb;
      --accent-soft: #dbeafe;
      --bar: #3b82f6;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }

    .page {
      max-width: 960px;
      margin: 0 auto;
      padding: 2rem 1.25rem 3rem;
    }

    header {
      margin-bottom: 2rem;
    }

    h1 {
      margin: 0;
      font-size: 1.75rem;
      font-weight: 700;
    }

    .subtitle {
      margin: 0.5rem 0 0;
      color: var(--muted);
      font-size: 0.95rem;
    }

    .kpi-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .kpi {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem 1.25rem;
    }

    .kpi-label {
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }

    .kpi-value {
      margin-top: 0.35rem;
      font-size: 2rem;
      font-weight: 700;
      line-height: 1.1;
    }

    .kpi-hint {
      margin-top: 0.35rem;
      font-size: 0.8rem;
      color: var(--muted);
    }

    section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      margin-bottom: 1.5rem;
    }

    h2 {
      margin: 0 0 1rem;
      font-size: 1.1rem;
      font-weight: 600;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 0.55rem 0.5rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }

    th {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    tr:last-child td {
      border-bottom: none;
    }

    .login {
      font-weight: 500;
      min-width: 8rem;
    }

    .count {
      width: 4rem;
      font-variant-numeric: tabular-nums;
    }

    .bar-cell {
      width: 55%;
    }

    .bar-track {
      height: 0.65rem;
      background: var(--accent-soft);
      border-radius: 999px;
      overflow: hidden;
    }

    .bar-fill {
      height: 100%;
      background: var(--bar);
      border-radius: 999px;
      min-width: 0;
    }

    .band-label {
      font-weight: 500;
    }

    footer {
      margin-top: 2rem;
      font-size: 0.85rem;
      color: var(--muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <h1>Siara — Review Fairness Dashboard</h1>
      <p class="subtitle">Fairness and engagement metrics from the assignment log</p>
    </header>

    <div class="kpi-row">
      <div class="kpi">
        <div class="kpi-label">Total assignments</div>
        <div class="kpi-value">${metrics.totalAssignments}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Active reviewers</div>
        <div class="kpi-value">${metrics.activeReviewers}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Gini (workload)</div>
        <div class="kpi-value">${giniFormatted}</div>
        <div class="kpi-hint">0 = even, 1 = one person does everything</div>
      </div>
    </div>

    <section>
      <h2>Reviews per person</h2>
      <table>
        <thead>
          <tr>
            <th>Reviewer</th>
            <th>Reviews</th>
            <th>Load</th>
          </tr>
        </thead>
        <tbody>
          ${reviewerRows || "<tr><td colspan=\"3\">No reviewers yet</td></tr>"}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Difficulty band distribution</h2>
      <table>
        <thead>
          <tr>
            <th>Band</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          ${bandRows}
        </tbody>
      </table>
    </section>

    <footer>Generated at ${generatedAt}</footer>
  </div>
</body>
</html>`;
}
