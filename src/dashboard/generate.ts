import type { DifficultyBand, OpenPrSnapshot, ReviewResponse } from "../types.js";
import type { DashboardInput, DashboardMetrics } from "./index.js";
import { buildMetrics } from "./metrics.js";
import { escapeHtml } from "./html.js";

const BANDS = ["simple", "moderate", "hard"] as const;
const BAND_LABEL: Record<DifficultyBand, string> = {
  simple: "Simple",
  moderate: "Moderate",
  hard: "Hard",
};

export function renderDashboardHtml(input: DashboardInput): string {
  const overrides = input.overrides ?? [];
  const metrics = buildMetrics(input.assignments, overrides);

  const perPersonChart = renderPerPersonChart(metrics);
  const rosterSection = renderRosterSection(metrics);
  const difficultyChart = renderDifficultyDonut(metrics);
  const trendChart = renderTrendChart(metrics);
  const heatmap = renderHeatmap(metrics);
  const openPrs = input.openPrs?.prs ?? [];
  const waitingSection = renderWaitingSection(openPrs);
  const responseSection = renderResponseSection(input.responseTimes?.responses ?? []);
  const openPrsSection = renderOpenPrsSection(input.openPrs);
  const overridesSection = renderOverridesSection(input, overrides);

  const generatedAt = escapeHtml(input.generatedAtIso);
  const giniFormatted = metrics.giniWork.toFixed(2);
  const acceptancePct = `${Math.round(metrics.acceptanceRate * 100)}%`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Siara — Review Fairness Dashboard</title>
  <script>
    // Set the theme before first paint to avoid a flash. Persisted choice wins,
    // else follow the OS preference.
    (function () {
      try {
        var saved = localStorage.getItem("siara-theme");
        var theme = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        document.documentElement.setAttribute("data-theme", theme);
      } catch (e) {
        document.documentElement.setAttribute("data-theme", "light");
      }
    })();
  </script>
  <style>
${STYLES}
  </style>
</head>
<body>
  <div class="page">
    <header>
      <div class="header-text">
        <h1>Siara — Review Fairness Dashboard</h1>
        <p class="subtitle">Fairness and engagement metrics from the assignment log</p>
      </div>
      <button id="theme-btn" class="theme-btn" type="button" aria-label="Toggle theme" onclick="__toggleTheme()">☾</button>
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
      <div class="kpi">
        <div class="kpi-label">Suggestion acceptance</div>
        <div class="kpi-value">${acceptancePct}</div>
        <div class="kpi-hint">${metrics.overriddenPrs} of ${metrics.assignedPrs} assigned PRs manually changed</div>
      </div>
    </div>

    <section>
      <h2>Reviews per person</h2>
      <p class="section-hint">Volume and difficulty mix per reviewer — height of the hard band shows who carries the risk, not just the count.</p>
      ${renderLegend()}
      ${perPersonChart}
    </section>

    ${rosterSection}

    <div class="grid-2">
      <section>
        <h2>Difficulty mix</h2>
        ${difficultyChart}
      </section>
      <section>
        <h2>Assignments per week</h2>
        <p class="section-hint">Full history — scroll left to page back through earlier weeks.</p>
        ${trendChart}
      </section>
    </div>

    <section>
      <h2>Activity heatmap</h2>
      <p class="section-hint">Reviews per reviewer per week — darker = busier. Scroll left to page back.</p>
      ${heatmap}
    </section>

    ${openPrsSection}

    ${waitingSection}

    ${responseSection}

    ${overridesSection}

    <footer>Generated at ${generatedAt}</footer>
  </div>
  <script>
    function __toggleTheme() {
      var cur = document.documentElement.getAttribute("data-theme");
      var next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("siara-theme", next); } catch (e) {}
      document.getElementById("theme-btn").textContent = next === "dark" ? "☀" : "☾";
    }
    // Initialise the toggle glyph to match the resolved theme.
    document.getElementById("theme-btn").textContent =
      document.documentElement.getAttribute("data-theme") === "dark" ? "☀" : "☾";
    // Scroll full-history charts to the latest (rightmost) week on load.
    for (var el of document.querySelectorAll(".scroll-latest")) {
      el.scrollLeft = el.scrollWidth;
    }
</script>
</body>
</html>`;
}

/** Horizontal stacked bars: one row per reviewer, segments per difficulty band. */
function renderPerPersonChart(metrics: DashboardMetrics): string {
  const rows = Object.entries(metrics.reviewsPerPerson).sort(
    ([la, ca], [lb, cb]) => (cb !== ca ? cb - ca : la.localeCompare(lb)),
  );
  if (rows.length === 0) {
    return `<p class="empty">No reviewers yet.</p>`;
  }

  const maxTotal = Math.max(1, ...rows.map(([, c]) => c));
  const W = 640;
  const labelW = 150;
  const countW = 34;
  const rowH = 30;
  const barH = 16;
  const gap = 8;
  const barMax = W - labelW - countW;
  const height = rows.length * rowH;

  const body = rows
    .map(([login, total], i) => {
      const y = i * rowH + (rowH - barH) / 2;
      const byBand = metrics.bandByPerson[login] ?? { simple: 0, moderate: 0, hard: 0 };
      let x = labelW;
      const segs = BANDS.map((band) => {
        const n = byBand[band];
        if (n <= 0) return "";
        const w = (n / maxTotal) * barMax;
        const rect = `<rect x="${fmt(x)}" y="${y}" width="${fmt(w)}" height="${barH}" fill="var(--band-${band})"><title>${escapeHtml(login)} — ${BAND_LABEL[band]}: ${n}</title></rect>`;
        x += w;
        return rect;
      }).join("");
      const label = `<text x="${labelW - 10}" y="${y + barH / 2}" class="svg-label" text-anchor="end" dominant-baseline="central">${escapeHtml(login)}</text>`;
      const count = `<text x="${x + 6}" y="${y + barH / 2}" class="svg-count" dominant-baseline="central">${total}</text>`;
      return label + segs + count;
    })
    .join("");

  void gap;
  return svg(W, height, body, "Reviews per person, stacked by difficulty band");
}

/** Donut chart of the overall difficulty band distribution. */
function renderDifficultyDonut(metrics: DashboardMetrics): string {
  const total = BANDS.reduce((s, b) => s + metrics.bandDistribution[b], 0);
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const r = 80;
  const stroke = 30;

  if (total === 0) {
    return `<p class="empty">No assignments yet.</p>`;
  }

  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const arcs = BANDS.map((band) => {
    const n = metrics.bandDistribution[band];
    if (n <= 0) return "";
    const frac = n / total;
    const len = frac * circumference;
    const dash = `${fmt(len)} ${fmt(circumference - len)}`;
    const arc = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--band-${band})" stroke-width="${stroke}" stroke-dasharray="${dash}" stroke-dashoffset="${fmt(-offset)}" transform="rotate(-90 ${cx} ${cy})"><title>${BAND_LABEL[band]}: ${n}</title></circle>`;
    offset += len;
    return arc;
  }).join("");

  const center = `<text x="${cx}" y="${cy - 6}" class="donut-total" text-anchor="middle">${total}</text><text x="${cx}" y="${cy + 14}" class="donut-sub" text-anchor="middle">reviews</text>`;
  const chart = svg(size, size, arcs + center, "Difficulty band distribution");

  const legendRows = BANDS.map((band) => {
    const n = metrics.bandDistribution[band];
    const pct = total > 0 ? Math.round((n / total) * 100) : 0;
    return `<li><span class="swatch" style="background: var(--band-${band})"></span>${BAND_LABEL[band]}<span class="legend-num">${n} · ${pct}%</span></li>`;
  }).join("");

  return `<div class="donut-wrap">${chart}<ul class="donut-legend">${legendRows}</ul></div>`;
}

/**
 * Column chart of assignment volume per ISO week — full history, no truncation.
 * Weeks have a fixed slot width and the chart scrolls horizontally (latest on
 * the right), so an arbitrarily long history stays legible and pageable by
 * scroll rather than silently dropping old weeks.
 */
function renderTrendChart(metrics: DashboardMetrics): string {
  const weeks = metrics.weeklyTrend;
  if (weeks.length === 0) {
    return `<p class="empty">No assignments yet.</p>`;
  }

  const H = 180;
  const padB = 28;
  const padT = 10;
  const slot = 46;
  const barW = 26;
  const maxCount = Math.max(1, ...weeks.map((w) => w.count));
  const n = weeks.length;
  const W = n * slot;
  const plotH = H - padB - padT;

  const bars = weeks
    .map((w, i) => {
      const h = (w.count / maxCount) * plotH;
      const x = i * slot + (slot - barW) / 2;
      const y = padT + (plotH - h);
      const label = `<text x="${fmt(x + barW / 2)}" y="${H - 10}" class="svg-tick" text-anchor="middle">${escapeHtml(w.week.slice(5))}</text>`;
      const value =
        w.count > 0
          ? `<text x="${fmt(x + barW / 2)}" y="${fmt(y - 4)}" class="svg-tick" text-anchor="middle">${w.count}</text>`
          : "";
      return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(barW)}" height="${fmt(h)}" rx="2" fill="var(--accent)"><title>Week of ${escapeHtml(w.week)}: ${w.count}</title></rect>${value}${label}`;
    })
    .join("");

  // Fixed intrinsic width + scroll container = full history, scroll to page back.
  const chart = `<svg class="chart chart-fixed" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Assignments per week" preserveAspectRatio="xMinYMin meet">${bars}</svg>`;
  return `<div class="scroll-x scroll-latest">${chart}</div>`;
}

/**
 * Reviewer × week activity heatmap — who reviewed when. Cell intensity scales
 * with that reviewer's assignment count in the week. Scrolls horizontally with
 * the same full-history semantics as the weekly trend.
 */
function renderHeatmap(metrics: DashboardMetrics): string {
  const weeks = metrics.weeklyTrend.map((w) => w.week);
  const reviewers = Object.entries(metrics.reviewsPerPerson)
    .sort(([la, ca], [lb, cb]) => (cb !== ca ? cb - ca : la.localeCompare(lb)))
    .map(([login]) => login);

  if (weeks.length === 0 || reviewers.length === 0) {
    return `<p class="empty">No assignments yet.</p>`;
  }

  let maxCell = 1;
  for (const login of reviewers) {
    for (const wk of weeks) {
      const v = metrics.weekByPerson[login]?.[wk] ?? 0;
      if (v > maxCell) maxCell = v;
    }
  }

  const labelW = 130;
  const cell = 28;
  const cgap = 10;
  const rowH = cell + cgap;
  const W = labelW + weeks.length * rowH;
  const H = reviewers.length * rowH + 22; // + week tick row

  const rows = reviewers
    .map((login, r) => {
      const y = r * rowH;
      const label = `<text x="${labelW - 10}" y="${y + cell / 2}" class="svg-label" text-anchor="end" dominant-baseline="central">${escapeHtml(login)}</text>`;
      const cells = weeks
        .map((wk, c) => {
          const v = metrics.weekByPerson[login]?.[wk] ?? 0;
          const x = labelW + c * rowH;
          // 0 → faint track; >0 → accent at opacity scaled by intensity.
          const op = v === 0 ? 0 : 0.2 + 0.8 * (v / maxCell);
          const fill = v === 0 ? "var(--border)" : "var(--accent)";
          return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="4" fill="${fill}" fill-opacity="${fmt(op)}"><title>${escapeHtml(login)} · week of ${escapeHtml(wk)}: ${v}</title></rect>`;
        })
        .join("");
      return label + cells;
    })
    .join("");

  const ticks = weeks
    .map((wk, c) => {
      const x = labelW + c * rowH + cell / 2;
      return `<text x="${fmt(x)}" y="${reviewers.length * rowH + 14}" class="svg-tick" text-anchor="middle">${escapeHtml(wk.slice(5))}</text>`;
    })
    .join("");

  const chart = `<svg class="chart chart-fixed" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Reviewer activity heatmap" preserveAspectRatio="xMinYMin meet">${rows}${ticks}</svg>`;
  return `<div class="scroll-x scroll-latest">${chart}</div>`;
}

/** Full reviewer roster (log-derived) with per-band counts — the list, not just
 *  the count. Sorted by total desc. */
function renderRosterSection(metrics: DashboardMetrics): string {
  const rows = Object.entries(metrics.reviewsPerPerson).sort(
    ([la, ca], [lb, cb]) => (cb !== ca ? cb - ca : la.localeCompare(lb)),
  );
  if (rows.length === 0) {
    return `<section><h2>Reviewers</h2><p class="empty">No reviewers yet.</p></section>`;
  }
  const body = rows
    .map(([login, total]) => {
      const b = metrics.bandByPerson[login] ?? { simple: 0, moderate: 0, hard: 0 };
      return `
        <tr>
          <td class="login">${escapeHtml(login)}</td>
          <td class="count">${total}</td>
          <td class="count">${b.simple}</td>
          <td class="count">${b.moderate}</td>
          <td class="count">${b.hard}</td>
        </tr>`;
    })
    .join("");
  return `<section>
      <h2>Reviewers</h2>
      <p class="section-hint">Every reviewer who has received an assignment, with their difficulty mix.</p>
      <table>
        <thead>
          <tr><th>Reviewer</th><th>Total</th><th>Simple</th><th>Moderate</th><th>Hard</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </section>`;
}

/** Per-reviewer waiting stats: how long they leave open PRs waiting (count, avg,
 *  max age in days) — derived from the point-in-time open-PRs snapshot. */
function renderWaitingSection(openPrs: OpenPrSnapshot[]): string {
  const byReviewer = new Map<string, number[]>();
  for (const pr of openPrs) {
    if (pr.ageDays === undefined) continue;
    for (const login of pr.assignees) {
      const list = byReviewer.get(login) ?? [];
      list.push(pr.ageDays);
      byReviewer.set(login, list);
    }
  }
  if (byReviewer.size === 0) {
    return `<section><h2>Waiting on reviewers</h2><p class="empty">No open PRs with a known age.</p></section>`;
  }
  const rows = [...byReviewer.entries()]
    .map(([login, ages]) => {
      const max = Math.max(...ages);
      const avg = ages.reduce((s, a) => s + a, 0) / ages.length;
      return { login, open: ages.length, avg, max };
    })
    .sort((a, b) => (b.max !== a.max ? b.max - a.max : b.open - a.open));

  const body = rows
    .map(
      (r) => `
        <tr>
          <td class="login">${escapeHtml(r.login)}</td>
          <td class="count">${r.open}</td>
          <td class="count">${r.avg.toFixed(1)}d</td>
          <td class="count">${r.max}d</td>
        </tr>`,
    )
    .join("");
  return `<section>
      <h2>Waiting on reviewers</h2>
      <p class="section-hint">Open PRs currently assigned to each reviewer and how long they've been waiting (point-in-time snapshot).</p>
      <table>
        <thead>
          <tr><th>Reviewer</th><th>Open PRs</th><th>Avg age</th><th>Oldest</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </section>`;
}

/** Median of a non-empty numeric list. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

/**
 * Per-reviewer responsiveness: time from assignment to first review, plus how
 * many assignments are still outstanding (open, no review yet) and the oldest.
 * Outstanding reviewers sort first — they're the ones holding PRs up now.
 */
function renderResponseSection(responses: ReviewResponse[]): string {
  if (responses.length === 0) {
    return `<section><h2>Response time</h2><p class="empty">No review-latency data yet.</p></section>`;
  }
  const byReviewer = new Map<
    string,
    { latencies: number[]; waits: number[] }
  >();
  for (const r of responses) {
    const agg = byReviewer.get(r.reviewer) ?? { latencies: [], waits: [] };
    if (!r.outstanding && r.latencyHours !== undefined) {
      agg.latencies.push(r.latencyHours);
    } else if (r.outstanding && r.waitingHours !== undefined) {
      agg.waits.push(r.waitingHours);
    }
    byReviewer.set(r.reviewer, agg);
  }

  const days = (hours: number): string => `${(hours / 24).toFixed(1)}d`;
  const rows = [...byReviewer.entries()]
    .map(([login, { latencies, waits }]) => ({
      login,
      reviewed: latencies.length,
      medianH: latencies.length > 0 ? median(latencies) : undefined,
      slowestH: latencies.length > 0 ? Math.max(...latencies) : undefined,
      outstanding: waits.length,
      oldestWaitH: waits.length > 0 ? Math.max(...waits) : undefined,
    }))
    .sort((a, b) =>
      b.outstanding !== a.outstanding
        ? b.outstanding - a.outstanding
        : (b.oldestWaitH ?? b.medianH ?? 0) - (a.oldestWaitH ?? a.medianH ?? 0),
    );

  const body = rows
    .map(
      (r) => `
        <tr>
          <td class="login">${escapeHtml(r.login)}</td>
          <td class="count">${r.reviewed}</td>
          <td class="count">${r.medianH === undefined ? "—" : days(r.medianH)}</td>
          <td class="count">${r.slowestH === undefined ? "—" : days(r.slowestH)}</td>
          <td class="count">${r.outstanding || "—"}</td>
          <td class="count">${r.oldestWaitH === undefined ? "—" : days(r.oldestWaitH)}</td>
        </tr>`,
    )
    .join("");
  return `<section>
      <h2>Response time</h2>
      <p class="section-hint">Time from assignment to a reviewer's first review. Outstanding = assigned on a still-open PR with no review yet (sorted to the top).</p>
      <table>
        <thead>
          <tr><th>Reviewer</th><th>Reviewed</th><th>Median</th><th>Slowest</th><th>Outstanding</th><th>Oldest waiting</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </section>`;
}

const STALENESS_BADGE: Record<OpenPrSnapshot["staleness"], { label: string; color: string }> = {
  normal: { label: "ok", color: "var(--band-simple)" },
  warning: { label: "waiting", color: "var(--band-moderate)" },
  overdue: { label: "overdue", color: "var(--band-hard)" },
};

/** Open-PRs age overview from the snapshot — oldest first, with staleness. */
function renderOpenPrsSection(snapshot: DashboardInput["openPrs"]): string {
  const prs = snapshot?.prs ?? [];
  if (prs.length === 0) {
    return `<section><h2>Open PRs</h2><p class="empty">No open PRs in the latest snapshot.</p></section>`;
  }
  const sorted = [...prs].sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  const body = sorted
    .map((pr) => {
      const badge = STALENESS_BADGE[pr.staleness];
      const age = pr.ageDays === undefined ? "—" : `${pr.ageDays}d`;
      const band = pr.band
        ? `<span class="badge" style="background: var(--band-${pr.band})">${BAND_LABEL[pr.band]}</span>`
        : "—";
      const assignees = escapeHtml(pr.assignees.join(", ") || "—");
      return `
        <tr>
          <td class="login">${escapeHtml(pr.repo)}#${pr.pr}</td>
          <td>${escapeHtml(pr.title)}</td>
          <td>${band}</td>
          <td>${assignees}</td>
          <td class="count">${age}</td>
          <td><span class="badge" style="background: ${badge.color}">${badge.label}</span></td>
        </tr>`;
    })
    .join("");
  const takenAt = snapshot?.takenAt ? escapeHtml(snapshot.takenAt.slice(0, 10)) : "";
  return `<section>
      <h2>Open PRs</h2>
      <p class="section-hint">Point-in-time snapshot${takenAt ? ` from ${takenAt}` : ""} — oldest first.</p>
      <table>
        <thead>
          <tr><th>PR</th><th>Title</th><th>Difficulty</th><th>Assignees</th><th>Age</th><th>Status</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </section>`;
}

function renderLegend(): string {
  const items = BANDS.map(
    (band) =>
      `<li><span class="swatch" style="background: var(--band-${band})"></span>${BAND_LABEL[band]}</li>`,
  ).join("");
  return `<ul class="legend">${items}</ul>`;
}

function renderOverridesSection(input: DashboardInput, overrides: DashboardInput["overrides"]): string {
  const list = overrides ?? [];
  // Join each override to its assignment for PR metadata (band + difficulty).
  const metaByKey = new Map<string, { band: DifficultyBand; difficulty: number }>();
  for (const a of input.assignments) {
    metaByKey.set(`${a.repo}#${a.pr}`, { band: a.band, difficulty: a.difficulty });
  }
  const overrideRows = [...list]
    .filter((o) => metaByKey.has(`${o.repo}#${o.pr}`))
    .sort((a, b) => b.seenAt.localeCompare(a.seenAt))
    .map((o) => {
      const key = `${o.repo}#${o.pr}`;
      const pr = `${escapeHtml(o.repo)}#${o.pr}`;
      const suggested = escapeHtml(o.suggested.join(", ") || "—");
      const actual = escapeHtml(o.actual.join(", ") || "—");
      const when = escapeHtml(o.seenAt.slice(0, 10));
      const meta = metaByKey.get(key);
      const difficulty = meta
        ? `<span class="badge" style="background: var(--band-${meta.band})">${BAND_LABEL[meta.band]}</span> <span class="count">${meta.difficulty.toFixed(2)}</span>`
        : "—";
      return `
        <tr>
          <td class="login">${pr}</td>
          <td>${difficulty}</td>
          <td>${suggested}</td>
          <td>${actual}</td>
          <td class="count">${when}</td>
        </tr>`;
    })
    .join("");

  return `<section>
      <h2>Manual overrides</h2>
      <table>
        <thead>
          <tr>
            <th>PR</th>
            <th>Difficulty</th>
            <th>Suggested</th>
            <th>Actual</th>
            <th>Seen</th>
          </tr>
        </thead>
        <tbody>
          ${overrideRows || "<tr><td colspan=\"5\">No manual overrides — every suggestion stuck</td></tr>"}
        </tbody>
      </table>
    </section>`;
}

/** Wrap chart body in a responsive, accessible SVG. */
function svg(w: number, h: number, body: string, title: string): string {
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMinYMin meet">${body}</svg>`;
}

/** Trim float noise from SVG coordinates. */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

const STYLES = `
    :root {
      --bg: #f7f8fa;
      --surface: #ffffff;
      --text: #191c24;
      --muted: #5c6370;
      --border: #e4e7ec;
      --accent: #3b6df6;
      --band-simple: #4f9d69;
      --band-moderate: #d99b28;
      --band-hard: #d1495b;
    }

    [data-theme="dark"] {
      --bg: #0f1115;
      --surface: #171a21;
      --text: #e6e8ee;
      --muted: #9aa1ad;
      --border: #262a33;
      --accent: #6f95ff;
      --band-simple: #56b877;
      --band-moderate: #e6ac3e;
      --band-hard: #e05c6e;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    .page { max-width: 960px; margin: 0 auto; padding: 2.5rem 1.25rem 3rem; }

    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 2rem;
    }

    h1 { margin: 0; font-size: 1.6rem; font-weight: 650; letter-spacing: -0.02em; }
    .subtitle { margin: 0.4rem 0 0; color: var(--muted); font-size: 0.95rem; }

    .theme-btn {
      flex: none;
      width: 2.25rem; height: 2.25rem;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-size: 1rem;
      cursor: pointer;
      transition: border-color 0.15s ease, transform 0.15s ease;
    }
    .theme-btn:hover { border-color: var(--accent); transform: translateY(-1px); }

    .kpi-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .kpi {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1rem 1.25rem;
    }
    .kpi-label {
      font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.05em; color: var(--muted);
    }
    .kpi-value { margin-top: 0.35rem; font-size: 1.9rem; font-weight: 680; line-height: 1.1; letter-spacing: -0.02em; }
    .kpi-hint { margin-top: 0.35rem; font-size: 0.78rem; color: var(--muted); }

    section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem 1.4rem;
      margin-bottom: 1.5rem;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
    }
    .grid-2 section { margin-bottom: 0; }

    h2 { margin: 0 0 0.35rem; font-size: 1.05rem; font-weight: 620; letter-spacing: -0.01em; }
    .section-hint { margin: 0 0 1rem; font-size: 0.82rem; color: var(--muted); }

    .chart { width: 100%; height: auto; display: block; }
    .chart-fixed { width: auto; max-width: none; }

    .scroll-x { overflow-x: auto; overflow-y: hidden; padding-bottom: 0.35rem; }
    .scroll-x::-webkit-scrollbar { height: 8px; }
    .scroll-x::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; }

    .badge {
      display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px;
      font-size: 0.72rem; font-weight: 600; color: #fff; letter-spacing: 0.02em;
    }

    .svg-label { fill: var(--text); font-size: 12px; }
    .svg-count { fill: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .svg-tick { fill: var(--muted); font-size: 10px; }
    .donut-total { fill: var(--text); font-size: 28px; font-weight: 680; }
    .donut-sub { fill: var(--muted); font-size: 12px; }

    .legend, .donut-legend {
      list-style: none; margin: 0 0 1rem; padding: 0;
      display: flex; flex-wrap: wrap; gap: 0.35rem 1rem;
      font-size: 0.82rem; color: var(--muted);
    }
    .donut-legend { flex-direction: column; margin: 0; gap: 0.5rem; }
    .legend li, .donut-legend li { display: flex; align-items: center; gap: 0.45rem; }
    .legend-num { color: var(--text); font-variant-numeric: tabular-nums; margin-left: auto; }
    .swatch { width: 0.7rem; height: 0.7rem; border-radius: 3px; flex: none; }

    .donut-wrap { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; }
    .donut-wrap .chart { max-width: 220px; }
    .donut-legend { min-width: 140px; }

    .empty { color: var(--muted); font-size: 0.9rem; margin: 0.5rem 0; }

    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 0.55rem 0.5rem; text-align: left;
      border-bottom: 1px solid var(--border); vertical-align: middle;
    }
    th {
      font-size: 0.75rem; font-weight: 600; color: var(--muted);
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    tr:last-child td { border-bottom: none; }
    .login { font-weight: 500; min-width: 8rem; }
    .count { width: 5rem; font-variant-numeric: tabular-nums; color: var(--muted); }

    footer { margin-top: 2rem; font-size: 0.82rem; color: var(--muted); text-align: center; }`;
