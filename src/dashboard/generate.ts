import type { Assignment, DifficultyBand, OpenPrSnapshot } from "../types.js";
import type { DashboardInput, DashboardMetrics, StrategyComparison, StrategyComparisonMetrics } from "./index.js";
import type { StrategyName } from "../scoring/pickReviewers.js";
import { DEFAULT_TEAM_CONFIG } from "../config.js";
import { buildMetrics, buildReviewAgePoints, historyAssignments } from "./metrics.js";
import { isHistoricalDifficultyAssignment } from "../assignments.js";
import { escapeHtml } from "./html.js";
import {
  renderAgeDistribution,
  renderDifficultyAgeScatter,
  renderRepoAgeDistribution,
  renderRepoOpenedToAssignmentDistribution,
  CHART_STYLES,
} from "./charts.js";

const BANDS = ["simple", "moderate", "hard"] as const;
const BAND_LABEL: Record<DifficultyBand, string> = {
  simple: "Simple",
  moderate: "Moderate",
  hard: "Hard",
};

type Directory = Record<string, { name?: string; email?: string }>;

/** Display label for a reviewer: real name if known, else the login. */
function displayName(login: string, dir: Directory): string {
  return dir[login]?.name?.trim() || login;
}

/** Tooltip text for a reviewer: login (nick) plus email when known. */
function personTitle(login: string, dir: Directory): string {
  const email = dir[login]?.email?.trim();
  return email ? `${login} · ${email}` : login;
}

/** A reviewer name for an HTML table cell: real name + nick/email tooltip. */
function personCell(login: string, dir: Directory): string {
  return `<span title="${escapeHtml(personTitle(login, dir))}">${escapeHtml(displayName(login, dir))}</span>`;
}

export function renderDashboardHtml(input: DashboardInput): string {
  const overrides = input.overrides ?? [];
  const operationalAssignments = input.assignments.filter(
    (assignment) => !isHistoricalDifficultyAssignment(assignment),
  );
  const metrics = buildMetrics(operationalAssignments, overrides);
  const historyMetrics = buildMetrics(
    historyAssignments(input.assignments, input.responseTimes?.responses ?? []),
    overrides,
  );

  const dir: Directory = input.reviewers ?? {};
  const staleness = input.staleness ?? { warningDays: 3, overdueDays: 5 };
  const difficultyChart = renderDifficultyDonut(metrics);
  const trendChart = renderTrendChart(metrics);
  const heatmap = renderHeatmap(operationalAssignments, dir);
  const sankeySection = renderSankey(metrics, dir);
  const openPrs = input.openPrs?.prs ?? [];
  const reviewAges = buildReviewAgePoints(
    openPrs,
    input.responseTimes,
    input.assignments,
  );
  const openPrsSection = renderOpenPrsSection(input.openPrs, dir, staleness);
  const overridesSection = renderOverridesSection(input, overrides);
  const algorithmSection = renderAlgorithmSection(
    input.algorithm,
  );
  const ageDistSection = renderAgeDistribution(reviewAges);
  const repoAgeSection = renderRepoAgeDistribution(reviewAges);
  const openedToAssignmentSection = renderRepoOpenedToAssignmentDistribution(
    input.responseTimes?.openedToAssignment ?? [],
  );
  const diffAgeScatter = renderDifficultyAgeScatter(reviewAges);
  const assignmentsSection = renderAssignmentsSection(
    openPrs,
    input.openPrs?.takenAt.slice(0, 10) ?? input.generatedAtIso.slice(0, 10),
    operationalAssignments,
    historyMetrics,
    dir,
  );

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

    <nav class="tabs" role="tablist">
      <button class="tab active" type="button" data-tab="overview">Dashboard</button>
      <button class="tab" type="button" data-tab="open-prs">Open PRs</button>
      <button class="tab" type="button" data-tab="how">How it works</button>
    </nav>

    <div class="tab-panel" id="tab-overview">
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

    ${assignmentsSection}

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
      <h2>Reviewer × repo</h2>
      <p class="section-hint">Assignments per reviewer per repository — darker = more. Scroll right for more repos.</p>
      ${heatmap}
    </section>

    ${sankeySection}

    ${ageDistSection}

    ${repoAgeSection}

    ${openedToAssignmentSection}

    ${diffAgeScatter}

    ${overridesSection}
    </div>

    <div class="tab-panel hidden" id="tab-open-prs">
    ${openPrsSection}
    </div>

    <div class="tab-panel hidden" id="tab-how">
    ${algorithmSection}
    </div>

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
    // Tabs: show one panel at a time.
    for (var tab of document.querySelectorAll(".tab")) {
      (function (tab) {
        tab.addEventListener("click", function () {
          var name = tab.getAttribute("data-tab");
          for (var t of document.querySelectorAll(".tab")) {
            t.classList.toggle("active", t === tab);
          }
          for (var p of document.querySelectorAll(".tab-panel")) {
            p.classList.toggle("hidden", p.id !== "tab-" + name);
          }
        });
      })(tab);
    }
    // Sub-tabs inside a section (e.g. Current vs History assignments).
    for (var sub of document.querySelectorAll(".sub-tab")) {
      (function (sub) {
        sub.addEventListener("click", function () {
          var group = sub.closest("[data-subtab-group]");
          if (!group) return;
          var name = sub.getAttribute("data-subtab");
          for (var t of group.querySelectorAll(".sub-tab")) {
            t.classList.toggle("active", t === sub);
          }
          for (var p of group.querySelectorAll(".sub-panel")) {
            p.classList.toggle("hidden", p.id !== name);
          }
        });
      })(sub);
    }
    // Sortable tables: click a header to sort (toggles asc/desc). Numeric columns
    // sort on a data-val attribute when the display text differs from the value.
    for (var table of document.querySelectorAll("table.sortable")) {
      (function (table) {
        var ths = table.tHead.rows[0].cells;
        var dir = 1;
        var active = -1;
        for (var i = 0; i < ths.length; i++) {
          (function (idx, th) {
            th.style.cursor = "pointer";
            th.addEventListener("click", function () {
              dir = active === idx ? -dir : 1;
              active = idx;
              var type = th.getAttribute("data-sort") || "text";
              var rows = Array.prototype.slice.call(table.tBodies[0].rows);
              rows.sort(function (a, b) {
                var ca = a.cells[idx], cb = b.cells[idx];
                var va = ca.getAttribute("data-val");
                if (va === null) va = ca.textContent.trim();
                var vb = cb.getAttribute("data-val");
                if (vb === null) vb = cb.textContent.trim();
                if (type === "num") return (parseFloat(va) - parseFloat(vb)) * dir;
                return va.localeCompare(vb) * dir;
              });
              for (var r of rows) table.tBodies[0].appendChild(r);
              for (var k = 0; k < ths.length; k++) ths[k].removeAttribute("data-dir");
              th.setAttribute("data-dir", dir > 0 ? "asc" : "desc");
            });
          })(i, ths[i]);
        }
      })(table);
    }
    // Table search: live-filter rows of the targeted table by substring.
    for (var inp of document.querySelectorAll(".table-search")) {
      (function (input) {
        var t = document.getElementById(input.getAttribute("data-target"));
        if (!t) return;
        input.addEventListener("input", function () {
          var q = input.value.toLowerCase();
          for (var row of t.tBodies[0].rows) {
            var hay =
              (row.textContent + " " + (row.getAttribute("data-logins") || "")).toLowerCase();
            row.style.display = hay.indexOf(q) >= 0 ? "" : "none";
          }
        });
      })(inp);
    }
    // Reviewer name → jump to the Open PRs tab, pre-filtered to that reviewer.
    for (var link of document.querySelectorAll("[data-filter-login]")) {
      (function (el) {
        el.addEventListener("click", function () {
          var login = el.getAttribute("data-filter-login");
          for (var t of document.querySelectorAll(".tab")) {
            t.classList.toggle("active", t.getAttribute("data-tab") === "open-prs");
          }
          for (var p of document.querySelectorAll(".tab-panel")) {
            p.classList.toggle("hidden", p.id !== "tab-open-prs");
          }
          var search = document.querySelector('.table-search[data-target="open-prs-table"]');
          if (search) {
            search.value = login;
            search.dispatchEvent(new Event("input"));
            search.scrollIntoView({ block: "nearest" });
          }
        });
      })(link);
    }
</script>
</body>
</html>`;
}

/**
 * Horizontal stacked bars: one row per reviewer, segments per difficulty band,
 * with the per-band count printed inside each colour when it fits. This is the
 * single reviewer summary (replaces the old roster table). Labels are real
 * names (login + email on hover) and click through to that reviewer's open PRs.
 */
function renderPerPersonChart(metrics: DashboardMetrics, dir: Directory): string {
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
  const rowH = 28;
  const barH = 18;
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
        const rect = `<rect x="${fmt(x)}" y="${y}" width="${fmt(w)}" height="${barH}" fill="var(--band-${band})"><title>${escapeHtml(personTitle(login, dir))} — ${BAND_LABEL[band]}: ${n}</title></rect>`;
        // Print the count inside the segment when there's room for it.
        const num =
          w >= 16
            ? `<text x="${fmt(x + w / 2)}" y="${y + barH / 2}" class="seg-num" text-anchor="middle" dominant-baseline="central">${n}</text>`
            : "";
        x += w;
        return rect + num;
      }).join("");
      const label = `<text x="${labelW - 10}" y="${y + barH / 2}" class="svg-label svg-link" data-filter-login="${escapeHtml(login)}" text-anchor="end" dominant-baseline="central">${escapeHtml(displayName(login, dir))}<title>${escapeHtml(personTitle(login, dir))}</title></text>`;
      const count = `<text x="${x + 6}" y="${y + barH / 2}" class="svg-count" dominant-baseline="central">${total}</text>`;
      return label + segs + count;
    })
    .join("");

  return svg(W, height, body, "Assignment history per person, stacked by difficulty band");
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
 * Reviewer × repo heatmap — who covers which repository. Cell intensity (and the
 * inline count) scales with that reviewer's assignment count in the repo. Repos
 * are columns (short name), reviewers rows sorted by total volume.
 */
function renderHeatmap(assignments: Assignment[], dir: Directory): string {
  const count = new Map<string, Map<string, number>>();
  const repos = new Set<string>();
  for (const a of assignments) {
    for (const login of a.assignees) {
      repos.add(a.repo);
      const m = count.get(login) ?? new Map<string, number>();
      m.set(a.repo, (m.get(a.repo) ?? 0) + 1);
      count.set(login, m);
    }
  }
  const repoList = [...repos].sort();
  const reviewers = [...count.entries()]
    .map(([login, m]) => [login, [...m.values()].reduce((s, v) => s + v, 0)] as const)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([login]) => login);

  if (repoList.length === 0 || reviewers.length === 0) {
    return `<p class="empty">No assignments yet.</p>`;
  }

  let maxCell = 1;
  for (const m of count.values()) {
    for (const v of m.values()) if (v > maxCell) maxCell = v;
  }

  const labelW = 140;
  const cell = 28;
  const cgap = 10;
  const rowH = cell + cgap;
  const labelH = 96; // rotated repo labels below the grid
  const W = labelW + repoList.length * rowH;
  const H = reviewers.length * rowH + labelH;
  const short = (r: string): string => r.split("/").pop() ?? r;

  const rows = reviewers
    .map((login, rI) => {
      const y = rI * rowH;
      const m = count.get(login);
      const label = `<text x="${labelW - 10}" y="${y + cell / 2}" class="svg-label" text-anchor="end" dominant-baseline="central">${escapeHtml(displayName(login, dir))}<title>${escapeHtml(personTitle(login, dir))}</title></text>`;
      const cells = repoList
        .map((repo, cI) => {
          const v = m?.get(repo) ?? 0;
          const x = labelW + cI * rowH;
          const intensity = v / maxCell;
          const op = v === 0 ? 0 : 0.2 + 0.8 * intensity;
          const fill = v === 0 ? "var(--border)" : "var(--accent)";
          const num =
            v > 0
              ? `<text x="${x + cell / 2}" y="${y + cell / 2}" class="heat-num" fill="${intensity > 0.55 ? "#fff" : "var(--text)"}" text-anchor="middle" dominant-baseline="central">${v}</text>`
              : "";
          return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="4" fill="${fill}" fill-opacity="${fmt(op)}"><title>${escapeHtml(login)} · ${escapeHtml(repo)}: ${v}</title></rect>${num}`;
        })
        .join("");
      return label + cells;
    })
    .join("");

  const ticks = repoList
    .map((repo, cI) => {
      const x = labelW + cI * rowH + cell / 2;
      const y = reviewers.length * rowH + 14;
      return `<text x="${fmt(x)}" y="${y}" class="svg-tick" text-anchor="end" transform="rotate(-40 ${fmt(x)} ${y})">${escapeHtml(short(repo))}</text>`;
    })
    .join("");

  const chart = `<svg class="chart chart-fixed" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Reviewer by repository heatmap" preserveAspectRatio="xMinYMin meet">${rows}${ticks}</svg>`;
  return `<div class="scroll-x">${chart}</div>`;
}

/**
 * Sankey: difficulty band (left) → reviewer (right). Ribbon thickness ∝ the
 * number of PRs of that band assigned to that reviewer; node height ∝ total.
 * Counts sit on every node so it reads as numbers, not just proportions.
 */
function renderSankey(metrics: DashboardMetrics, dir: Directory): string {
  const reviewers = Object.entries(metrics.reviewsPerPerson)
    .sort(([la, ca], [lb, cb]) => (cb !== ca ? cb - ca : la.localeCompare(lb)))
    .map(([login]) => login);
  const activeBands = BANDS.filter((b) => metrics.bandDistribution[b] > 0);
  const total = reviewers.reduce((s, l) => s + (metrics.reviewsPerPerson[l] ?? 0), 0);
  if (total === 0 || reviewers.length === 0) {
    return `<section><h2>Assignment flow</h2><p class="empty">No assignments yet.</p></section>`;
  }

  const nodeW = 14;
  const gap = 6;
  const leftLabelW = 104;
  const leftX = leftLabelW;
  const plotW = 400;
  // Reserve enough viewBox width for the longest reviewer label plus count.
  // Previously the fixed 640px canvas clipped the final reviewer name.
  const rightLabelW = Math.max(
    160,
    ...reviewers.map((login) => (displayName(login, dir).length + 8) * 7 + 10),
  );
  const rightX = leftX + nodeW + plotW;
  const W = rightX + nodeW + rightLabelW;

  const maxGaps = Math.max(activeBands.length - 1, reviewers.length - 1) * gap;
  const plotH = Math.max(200, reviewers.length * 30);
  const unit = (plotH - maxGaps) / total;

  // Left band nodes (BAND order, top→bottom) and their outgoing-link cursor.
  const bandTop = new Map<DifficultyBand, number>();
  const bandCursor = new Map<DifficultyBand, number>();
  let ly = 0;
  for (const b of activeBands) {
    bandTop.set(b, ly);
    bandCursor.set(b, ly);
    ly += metrics.bandDistribution[b] * unit + gap;
  }
  // Right reviewer nodes (volume desc) and their incoming-link cursor.
  const revTop = new Map<string, number>();
  const revCursor = new Map<string, number>();
  let ry = 0;
  for (const login of reviewers) {
    revTop.set(login, ry);
    revCursor.set(login, ry);
    ry += (metrics.reviewsPerPerson[login] ?? 0) * unit + gap;
  }
  const H = Math.ceil(Math.max(ly, ry) - gap);

  // Links: outer loop = band keeps right-side stacking in band order.
  const links: string[] = [];
  for (const b of activeBands) {
    for (const login of reviewers) {
      const c = metrics.bandByPerson[login]?.[b] ?? 0;
      if (c <= 0) continue;
      const t = c * unit;
      const y1 = (bandCursor.get(b) ?? 0) + t / 2;
      bandCursor.set(b, (bandCursor.get(b) ?? 0) + t);
      const y2 = (revCursor.get(login) ?? 0) + t / 2;
      revCursor.set(login, (revCursor.get(login) ?? 0) + t);
      const x1 = leftX + nodeW;
      const mx = (x1 + rightX) / 2;
      const d = `M${fmt(x1)} ${fmt(y1)} C${fmt(mx)} ${fmt(y1)} ${fmt(mx)} ${fmt(y2)} ${fmt(rightX)} ${fmt(y2)}`;
      links.push(
        `<path d="${d}" fill="none" stroke="var(--band-${b})" stroke-width="${fmt(Math.max(1, t))}" stroke-opacity="0.4"><title>${BAND_LABEL[b]} → ${escapeHtml(displayName(login, dir))}: ${c}</title></path>`,
      );
    }
  }

  const leftNodes = activeBands
    .map((b) => {
      const y = bandTop.get(b) ?? 0;
      const h = metrics.bandDistribution[b] * unit;
      const cy = y + h / 2;
      return (
        `<rect x="${leftX}" y="${fmt(y)}" width="${nodeW}" height="${fmt(Math.max(1, h))}" rx="2" fill="var(--band-${b})"><title>${BAND_LABEL[b]}: ${metrics.bandDistribution[b]}</title></rect>` +
        `<text x="${leftX - 8}" y="${fmt(cy)}" class="svg-label" text-anchor="end" dominant-baseline="central">${BAND_LABEL[b]} <tspan class="svg-count">${metrics.bandDistribution[b]}</tspan></text>`
      );
    })
    .join("");

  const rightNodes = reviewers
    .map((login) => {
      const y = revTop.get(login) ?? 0;
      const h = (metrics.reviewsPerPerson[login] ?? 0) * unit;
      const cy = y + h / 2;
      return (
        `<rect x="${rightX}" y="${fmt(y)}" width="${nodeW}" height="${fmt(Math.max(1, h))}" rx="2" fill="var(--accent)"><title>${escapeHtml(personTitle(login, dir))}: ${metrics.reviewsPerPerson[login]}</title></rect>` +
        `<text x="${rightX + nodeW + 8}" y="${fmt(cy)}" class="svg-label" dominant-baseline="central">${escapeHtml(displayName(login, dir))} <tspan class="svg-count">${metrics.reviewsPerPerson[login]}</tspan><title>${escapeHtml(personTitle(login, dir))}</title></text>`
      );
    })
    .join("");

  const chart = svg(
    W,
    H,
    links.join("") + leftNodes + rightNodes,
    "Assignment flow from difficulty band to reviewer",
  );
  return `<section>
      <h2>Assignment flow</h2>
      <p class="section-hint">Difficulty band → reviewer. Ribbon thickness = PRs of that band assigned to that reviewer.</p>
      ${chart}
    </section>`;
}


/** Age → colour by staleness thresholds (green / yellow / red). */
function ageColor(
  ageDays: number,
  staleness: { warningDays: number; overdueDays: number },
): string {
  if (ageDays >= staleness.overdueDays) return "var(--band-hard)";
  if (ageDays >= staleness.warningDays) return "var(--band-moderate)";
  return "var(--band-simple)";
}
/** Level word for the age pill's tooltip. */
function ageLevel(
  ageDays: number,
  staleness: { warningDays: number; overdueDays: number },
): string {
  if (ageDays >= staleness.overdueDays) return "overdue";
  if (ageDays >= staleness.warningDays) return "warning";
  return "ok";
}

/** Open-PRs age overview from the snapshot — oldest first, age colour-coded. */
function renderOpenPrsSection(
  snapshot: DashboardInput["openPrs"],
  dir: Directory,
  staleness: { warningDays: number; overdueDays: number },
): string {
  const prs = snapshot?.prs ?? [];
  if (prs.length === 0) {
    return `<section><h2>Open PRs</h2><p class="empty">No open PRs in the latest snapshot.</p></section>`;
  }
  const bandRank: Record<DifficultyBand, number> = { simple: 0, moderate: 1, hard: 2 };
  const sorted = [...prs].sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  const body = sorted
    .map((pr) => {
      const band = pr.band
        ? `<span class="badge" style="background: var(--band-${pr.band})">${BAND_LABEL[pr.band]}</span>`
        : "—";
      const bandVal = pr.band ? bandRank[pr.band] : -1;
      const age =
        pr.ageDays === undefined
          ? `<span class="count">—</span>`
          : `<span class="badge" style="background: ${ageColor(pr.ageDays, staleness)}" title="${ageLevel(pr.ageDays, staleness)}">${pr.ageDays}d</span>`;
      const assignees =
        pr.assignees.length > 0
          ? pr.assignees.map((login) => personCell(login, dir)).join(", ")
          : "—";
      const slash = pr.repo.indexOf("/");
      const org = slash >= 0 ? pr.repo.slice(0, slash) : "";
      const name = slash >= 0 ? pr.repo.slice(slash + 1) : pr.repo;
      // data-logins keeps the reviewer logins searchable even though the cell
      // shows real names — so a reviewer-name click (which seeds the login)
      // still filters this table.
      return `
        <tr data-logins="${escapeHtml(pr.assignees.join(" "))}">
          <td class="pr-cell">
            <a class="pr-main" href="https://github.com/${escapeHtml(pr.repo)}/pull/${pr.pr}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}/${pr.pr}</a>
            ${org ? `<span class="pr-org">${escapeHtml(org)}</span>` : ""}
          </td>
          <td>${escapeHtml(pr.title)}</td>
          <td data-val="${bandVal}">${band}</td>
          <td>${assignees}</td>
          <td class="count" data-val="${pr.ageDays ?? -1}">${age}</td>
        </tr>`;
    })
    .join("");
  const takenAt = snapshot?.takenAt ? escapeHtml(snapshot.takenAt.slice(0, 10)) : "";
  return `<section>
      <h2>Open PRs</h2>
      <p class="section-hint">Point-in-time snapshot${takenAt ? ` from ${takenAt}` : ""} — click a column to sort; search filters rows. Age is colour-coded: green &lt; ${staleness.warningDays}d, yellow &lt; ${staleness.overdueDays}d, red older.</p>
      <input type="search" class="table-search" data-target="open-prs-table" placeholder="Search open PRs…" aria-label="Search open PRs">
      <table id="open-prs-table" class="sortable">
        <thead>
          <tr><th data-sort="text">PR</th><th data-sort="text">Title</th><th data-sort="num">Difficulty</th><th data-sort="text">Assignees</th><th data-sort="num">Age</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </section>`;
}

// ---------------------------------------------------------------------------
// Strategy comparison tab
// ---------------------------------------------------------------------------

/** Primary Siara strategy — the live scorer and comparison baseline. */
const MAIN_STRATEGY = "siara-v2";

function strategyBaseline(strategies: StrategyName[]): StrategyName {
  if ((strategies as readonly string[]).includes(MAIN_STRATEGY)) {
    return MAIN_STRATEGY as StrategyName;
  }
  return strategies.includes("siara") ? "siara" : strategies[0]!;
}

const STRAT_COLORS: Record<string, string> = {
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

const STRAT_LABELS: Record<string, string> = {
  siara: "siara",
  "siara-floor": "siara-floor",
  "siara-blend": "siara-blend",
  "siara-load": "siara-load",
  "siara-v2": "siara-v2",
  "siara-noedu": "siara-noedu",
  whodo: "whodo",
  sofia: "sofia",
  whoreview: "whoreview",
  meta: "meta",
};

function renderStrategySection(
  data: StrategyComparison | undefined,
  dir: Directory,
): string {
  if (!data || data.prs.length === 0) {
    return `<section>
      <h2>Strategy comparison</h2>
      <p class="empty">No comparison data. Run <code>siara compare</code> first to generate it.</p>
    </section>`;
  }

  const strategies = data.strategies as StrategyName[];
  const baseline = strategyBaseline(strategies);
  const orderedStrategies = [
    baseline,
    ...strategies.filter((s) => s !== baseline),
  ];
  const baselineLabel = STRAT_LABELS[baseline] ?? baseline;

  // --- KPI cards (primary strategy first, highlighted) ---
  const metricsByStrategy = new Map(data.metrics.map((m) => [m.strategy, m]));
  const kpis = orderedStrategies
    .map((strategy) => {
      const m = metricsByStrategy.get(strategy);
      if (!m) return "";
      const isMain = strategy === baseline;
      return `
    <div class="strat-card${isMain ? " strat-card-main" : ""}">
      <div class="strat-name" style="color:${STRAT_COLORS[m.strategy] ?? "var(--accent)"}">${escapeHtml(STRAT_LABELS[m.strategy] ?? m.strategy)}${isMain ? " · live" : ""}</div>
      <div class="strat-kpis">
        <div class="strat-kpi"><span class="kpi-label">Gini</span><span class="kpi-value">${m.gini.toFixed(3)}</span></div>
        <div class="strat-kpi"><span class="kpi-label">Reviewers</span><span class="kpi-value">${m.activeReviewers}</span></div>
        <div class="strat-kpi"><span class="kpi-label">Max</span><span class="kpi-value">${m.maxLoad}</span></div>
        <div class="strat-kpi"><span class="kpi-label">Min</span><span class="kpi-value">${m.minLoad}</span></div>
        <div class="strat-kpi"><span class="kpi-label">Match</span><span class="kpi-value">${isMain ? "—" : `${m.agreementPct}%`}</span></div>
      </div>
    </div>`;
    })
    .join("");

  // --- Load distribution bar chart ---
  const allLogins = [
    ...new Set(data.metrics.flatMap((m) => Object.keys(m.loadByPerson))),
  ].sort();
  const maxLoad = Math.max(
    1,
    ...data.metrics.flatMap((m: StrategyComparisonMetrics) => Object.values(m.loadByPerson)),
  );

  const barW = 480;
  const rowH = 22;
  const groupGap = 10;
  const labelW = 140;
  const groupH = orderedStrategies.length * rowH + groupGap;
  const svgH = allLogins.length * groupH + 20;

  const loadBars = allLogins
    .map((login, gi) => {
      const gy = gi * groupH;
      const label = `<text x="${labelW - 8}" y="${gy + (groupH - groupGap) / 2}" class="svg-label" text-anchor="end" dominant-baseline="central">${escapeHtml(displayName(login, dir))}<title>${escapeHtml(personTitle(login, dir))}</title></text>`;
      const bars = orderedStrategies
        .map((s, si) => {
          const m = data.metrics.find((x) => x.strategy === s);
          const v = m?.loadByPerson[login] ?? 0;
          const w = (v / maxLoad) * barW;
          const y = gy + si * rowH;
          const color = STRAT_COLORS[s] ?? "#888";
          const num =
            v > 0
              ? `<text x="${fmt(labelW + w + 4)}" y="${y + (rowH - 3) / 2}" class="svg-count" dominant-baseline="central">${v}</text>`
              : "";
          return (
            `<rect x="${labelW}" y="${y}" width="${fmt(w)}" height="${rowH - 3}" rx="3" fill="${color}" fill-opacity="0.75"><title>${escapeHtml(STRAT_LABELS[s] ?? s)}: ${v}</title></rect>` +
            num
          );
        })
        .join("");
      return label + bars;
    })
    .join("");

  const legendItems = orderedStrategies
    .map(
      (s) =>
        `<li><span class="swatch" style="background:${STRAT_COLORS[s]}"></span>${escapeHtml(STRAT_LABELS[s] ?? s)}</li>`,
    )
    .join("");

  const loadChart = svg(
    labelW + barW + 50,
    svgH,
    loadBars,
    "Load distribution per strategy",
  );

  // --- Per-PR comparison table ---
  const headerCells = orderedStrategies
    .map((s) => `<th>${escapeHtml(STRAT_LABELS[s] ?? s)}</th>`)
    .join("");

  const prRows = data.prs
    .map((row) => {
      const short = row.repo.split("/").pop() ?? row.repo;
      const bandBadge = `<span class="badge" style="background:var(--band-${row.band})">${BAND_LABEL[row.band]}</span>`;
      const cells = orderedStrategies
        .map((s) => {
          const pick = row.picks[s] ?? [];
          const ref = row.picks[baseline] ?? row.picks.siara ?? [];
          const same =
            s === baseline ||
            (pick.length === ref.length && pick.every((l) => ref.includes(l)));
          const cls = s === baseline ? "" : same ? "strat-same" : "strat-diff";
          return `<td class="${cls}">${pick.map((l) => escapeHtml(displayName(l, dir))).join(", ") || "—"}</td>`;
        })
        .join("");
      return `<tr>
        <td class="pr-cell" title="${escapeHtml(row.title)}">
          <a class="pr-main" href="https://github.com/${escapeHtml(row.repo)}/pull/${row.pr}" target="_blank" rel="noopener noreferrer">${escapeHtml(short)}/${row.pr}</a>
        </td>
        <td>${bandBadge} <span class="count">${row.difficulty.toFixed(2)}</span></td>
        ${cells}
      </tr>`;
    })
    .join("");

  const genAt = data.generatedAt?.slice(0, 10) ?? "";

  return `<section>
      <h2>Strategy comparison</h2>
      <p class="section-hint">Side-by-side evaluation of ${orderedStrategies.length} reviewer-selection strategies on ${data.totalPrs} open PRs${genAt ? ` (${genAt})` : ""}. <strong>${escapeHtml(baselineLabel)}</strong> is the live strategy — lower Gini = more even workload. Match = agreement with ${escapeHtml(baselineLabel)}.</p>
      <div class="strat-grid">${kpis}</div>
    </section>

    <section>
      <h2>Load per strategy</h2>
      <p class="section-hint">How many PRs each strategy would assign to each reviewer. Even bars = fair spread.</p>
      <ul class="legend">${legendItems}</ul>
      <div class="scroll-x">${loadChart}</div>
    </section>

    <section>
      <h2>Per-PR picks</h2>
      <p class="section-hint">Who each strategy would assign. <span class="strat-same-dot">Green</span> = same as ${escapeHtml(baselineLabel)}, <span class="strat-diff-dot">red</span> = different. Click PR to open on GitHub.</p>
      <div class="scroll-x">
      <table>
        <thead><tr><th>PR</th><th>Difficulty</th>${headerCells}</tr></thead>
        <tbody>${prRows}</tbody>
      </table>
      </div>
    </section>`;
}

/** Shipped defaults, so the doc renders truthfully even without a config. */
const DEFAULT_ALGO: NonNullable<DashboardInput["algorithm"]> = {
  reviewersPerPr: 1,
  bands: { simple: 0.3, hard: 0.6 },
  availability: {
    loadWeight: 0.12,
    busyWeight: 0.15,
    bandWeight: { simple: 0.6, moderate: 0.7, hard: 1.0 },
    hardWipLimit: 3,
    hardWipPenalty: 0.5,
    maxPenaltyFraction: 0.9,
  },
};

/** One labelled box in the pipeline diagram. */
function stageBox(
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
  sub: string,
): string {
  const cx = x + w / 2;
  return (
    `<rect x="${fmt(x)}" y="${y}" width="${fmt(w)}" height="${h}" rx="8" fill="var(--surface)" stroke="var(--border)"/>` +
    `<text x="${fmt(cx)}" y="${y + h / 2 - 6}" class="svg-label" text-anchor="middle" dominant-baseline="central" style="font-weight:600">${escapeHtml(title)}</text>` +
    `<text x="${fmt(cx)}" y="${y + h / 2 + 11}" class="svg-tick" text-anchor="middle" dominant-baseline="central">${escapeHtml(sub)}</text>`
  );
}

/**
 * "How it works" — the scoring pipeline as a left→right diagram plus a prose
 * explanation of the fairness policy, with the LIVE knob values so the doc can't
 * drift from the running config.
 */
function renderAlgorithmSection(
  algo: DashboardInput["algorithm"],
): string {
  const a = algo ?? DEFAULT_ALGO;
  const av = a.availability;
  const fu = a.followUpAffinity ?? DEFAULT_TEAM_CONFIG.followUpAffinity;
  const far = a.filesAtRisk ?? DEFAULT_TEAM_CONFIG.filesAtRisk;
  const soft = a.soft ?? DEFAULT_TEAM_CONFIG.soft;
  const pathRisk = a.pathRisk ?? {
    labels: [...new Set(
      DEFAULT_TEAM_CONFIG.pathRisk.rules
        .filter((rule) => rule.multiplier > 1)
        .map((rule) => rule.label ?? rule.pattern),
    )],
    bandFloorMultiplier: DEFAULT_TEAM_CONFIG.pathRisk.bandFloorMultiplier,
    bandFloor: DEFAULT_TEAM_CONFIG.pathRisk.bandFloor,
  };
  const riskLabels = pathRisk.labels.length > 0 ? pathRisk.labels.join(", ") : "configured high-risk paths";
  const liveLabel = "siara";

  const stages: Array<[string, string]> = [
    ["PR", "diff + paths"],
    ["Eligible", "roster + owners"],
    ["Difficulty", "size × risk"],
    ["Band", "simple/mod/hard"],
    ["Route", "by band"],
    ["Boosts", "continuity + FaR"],
    ["Penalty", "load (decoupled)"],
    ["Top-K", "pick from top 5"],
  ];
  // Two-row serpentine layout keeps labels readable on normal laptop/mobile
  // widths. Row two runs right-to-left so the arrows preserve pipeline order.
  const W = 640;
  const boxH = 58;
  const boxW = 132;
  const columns = 4;
  const columnGap = (W - columns * boxW) / (columns - 1);
  const rowGap = 28;
  const positions = stages.map((_, i) => {
    const row = Math.floor(i / columns);
    const positionInRow = i % columns;
    const column = row % 2 === 0 ? positionInRow : columns - 1 - positionInRow;
    return {
      x: column * (boxW + columnGap),
      y: 8 + row * (boxH + rowGap),
    };
  });
  const boxes = stages
    .map(([title, sub], i) => {
      const position = positions[i]!;
      return stageBox(position.x, position.y, boxW, boxH, title, sub);
    })
    .join("");
  const arrows: string[] = [];
  for (let i = 0; i < positions.length - 1; i += 1) {
    const from = positions[i]!;
    const to = positions[i + 1]!;
    const sameRow = from.y === to.y;
    if (sameRow) {
      const forward = to.x > from.x;
      arrows.push(
        `<line x1="${fmt((forward ? from.x + boxW : from.x) + (forward ? 2 : -2))}" y1="${fmt(from.y + boxH / 2)}" x2="${fmt((forward ? to.x : to.x + boxW) + (forward ? -2 : 2))}" y2="${fmt(to.y + boxH / 2)}" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#arw)"/>`,
      );
    } else {
      arrows.push(
        `<line x1="${fmt(from.x + boxW / 2)}" y1="${fmt(from.y + boxH + 2)}" x2="${fmt(to.x + boxW / 2)}" y2="${fmt(to.y - 2)}" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#arw)"/>`,
      );
    }
  }
  const defs = `<defs><marker id="arw" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--muted)"/></marker></defs>`;
  const diagram = svg(W, 2 * boxH + rowGap + 16, defs + arrows.join("") + boxes, "Scoring pipeline");

  const routing = `
    <table>
      <thead><tr><th>Band</th><th>Boundary</th><th>Who wins</th><th>Why</th></tr></thead>
      <tbody>
        <tr><td><span class="badge" style="background:var(--band-simple)">Simple</span></td><td class="count">&lt; ${a.bands.simple}</td><td><strong>Lowest</strong> familiarity</td><td>education — spread knowledge to newcomers</td></tr>
        <tr><td><span class="badge" style="background:var(--band-moderate)">Moderate</span></td><td class="count">${a.bands.simple}–${a.bands.hard}</td><td>Familiarity + knowledge blend</td><td>balance learning and safety</td></tr>
        <tr><td><span class="badge" style="background:var(--band-hard)">Hard</span></td><td class="count">≥ ${a.bands.hard}</td><td><strong>Highest</strong> knowledge (expert)</td><td>quality — route risk to who knows the code</td></tr>
      </tbody>
    </table>`;

  return `<section>
      <h2>How it works</h2>
      <p class="section-hint">Deterministic, no LLM: identical inputs always produce identical assignments (ties broken by a seeded dice). The live strategy is <strong>${escapeHtml(liveLabel)}</strong> — score floor, decoupled load penalty, and top-5 spread (the CLI runs it as <code>siara</code>). Knobs below reflect the team-level config loaded when this dashboard was generated; repo-specific overrides may differ.</p>
      ${diagram}
      <h3 class="algo-h3">0 · Eligibility and decline handling</h3>
      <p class="algo-p">Before scoring, candidates must be on the roster, not blocklisted, not the PR author, and not already requested. When CODEOWNERS/maintainer data is available, a matching roster owner or maintainer gate narrows the pool; if no roster candidate matches, the normal pool remains. If GitHub removes a reviewer previously suggested by Siara, the next daily run records the decline and reassigns while excluding declined reviewers. Manual reviewer changes are respected; if every candidate declines, the first configured team lead is used as fallback.</p>
      <h3 class="algo-h3">1 · Difficulty → band</h3>
      <p class="algo-p">Each PR gets a 0–1 difficulty from churn, file count, and directory spread, then multiplied up for configured risky paths (${escapeHtml(riskLabels)}). A matching rule at or above <code>${pathRisk.bandFloorMultiplier}</code> floors the result at <code>${pathRisk.bandFloor}</code>. The score falls into a band that decides <em>how</em> to route:</p>
      ${routing}
      <h3 class="algo-h3">2 · Score floor (simple band)</h3>
      <p class="algo-p">On simple PRs, the education path scores <code>max(0.35, 1 − familiarity)</code>. Without the floor, experts score 0 on familiar code, which makes the availability penalty irrelevant and piles all simple work on the same few newcomers. The floor keeps experts scoreable so load pressure can redistribute simple PRs across the team.</p>
      <h3 class="algo-h3">3 · Continuity boosts</h3>
      <p class="algo-p">Small additive nudges — never gates — applied after band routing:</p>
      <ul class="algo-list">
        <li><strong>Follow-up affinity</strong> — reviewers who recently touched the same branch family or Jira epic within ${fu.windowDays}d get up to <code>+${fu.branchFamilyBoost}</code> / <code>+${fu.epicBoost}</code> (diminishing with each hit).</li>
        <li><strong>Files at risk</strong> — spreads ownership: non-owners of touched files get <code>+${far.spreadBoost}</code> so one expert doesn't absorb every change in a repo.</li>
      </ul>
      <h3 class="algo-h3">4 · Jira soft boosts</h3>
      <p class="algo-p">When a linked Jira ticket is present: high story-point estimates (≥5) nudge above-median experts by <code>+${soft.estimateExpertBoost}</code>; high/blocker priority nudges experts by <code>+${soft.priorityExpertBoost}</code> and penalises already-loaded reviewers (≥3 open) by <code>−${soft.highPriorityLoadPenalty}</code>. These never change the difficulty band.</p>
      <h3 class="algo-h3">5 · Decoupled availability penalty</h3>
      <p class="algo-p">Each candidate's score is reduced by <code>bandWeight[band] × (loadWeight·openLoad + busyWeight·jiraBusy + managerPenalty + hardWIP)</code>, capped at <strong>${Math.round(av.maxPenaltyFraction * 100)}%</strong> of <code>1.0</code> (not the candidate's own score). Load pressure works equally on all candidates regardless of band. PTO adds a large uncapped penalty on top. Live weights: load <code>${av.loadWeight}</code>/open review, busy <code>${av.busyWeight}</code>/unit, band scaling simple <code>${av.bandWeight.simple}</code> · moderate <code>${av.bandWeight.moderate}</code> · hard <code>${av.bandWeight.hard}</code>.</p>
      <h3 class="algo-h3">6 · Top-K selection (anti-bystander)</h3>
      <p class="algo-p">Instead of always picking the #1 ranked candidate, assignments are drawn randomly (seeded dice, deterministic) from the <strong>top 5</strong>. This spreads work across viable reviewers and prevents one person from monopolising reviews even when they consistently rank highest. Inspired by Meta's RevRecV2 (FSE'24), which uses a top-3 pool; Siara widens to top-5 for more spread.</p>
      <h3 class="algo-h3">7 · Fairness: spread low-risk, cap high-risk</h3>
      <p class="algo-p">Simple PRs (the bulk) are spread by load — that's why <code>bandWeight.simple</code> is high. Hard PRs still go to experts, but a <strong>WIP cap</strong> stops one expert being bombarded: past <code>${av.hardWipLimit}</code> concurrent hard reviews, each extra adds <code>${av.hardWipPenalty}</code> penalty so the ${av.hardWipLimit + 1}th+ overflows to the next expert. Model: expertise + workload balancing (<em>WhoDo</em>, FSE'19) with knowledge distribution (<em>Sofia</em>, ICSE'20).</p>
      <p class="algo-p">Candidates are ranked by final score → open load → seeded dice; the top ${a.reviewersPerPr} reviewer(s) are drawn from the top-5 pool. See <em>Review assignments</em> (History tab) and <em>Assignment flow</em> for the outcome; <em>Gini (workload)</em> quantifies how even it is.</p>
    </section>`;
}

function renderLegend(opts?: { includeExistingLoad?: boolean }): string {
  const existingLoad = opts?.includeExistingLoad
    ? `<li><span class="swatch" style="background: var(--load-existing)"></span>Existing open reviews</li>`
    : "";
  const items = BANDS.map(
    (band) =>
      `<li><span class="swatch" style="background: var(--band-${band})"></span>${BAND_LABEL[band]}</li>`,
  ).join("");
  return `<ul class="legend">${existingLoad}${items}</ul>`;
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

/**
 * Current vs historical assignment workload — one section, two sub-tabs.
 */
function renderAssignmentsSection(
  openPrs: OpenPrSnapshot[],
  currentAssignmentDate: string,
  operationalAssignments: Assignment[],
  historyMetrics: DashboardMetrics,
  dir: Directory,
): string {
  const currentBody = renderCurrentAssignmentsChart(
    openPrs,
    currentAssignmentDate,
    operationalAssignments,
    dir,
  );
  const historyChart = renderPerPersonChart(historyMetrics, dir);
  const totalOpen = openPrs.length;
  const unassigned = openPrs.filter((pr) => pr.assignees.length === 0).length;
  const historyTotal = Object.values(historyMetrics.reviewsPerPerson).reduce(
    (s, n) => s + n,
    0,
  );

  return `<section data-subtab-group="assignments">
      <h2>Review assignments</h2>
      <nav class="sub-tabs" role="tablist" aria-label="Assignment view">
        <button class="sub-tab active" type="button" data-subtab="assign-current">Current</button>
        <button class="sub-tab" type="button" data-subtab="assign-history">History</button>
      </nav>
      <div class="sub-panel" id="assign-current">
        <p class="section-hint">${totalOpen > 0 ? `${totalOpen} open PRs right now${unassigned > 0 ? `, ${unassigned} unassigned` : ""}. Existing open reviews are neutral; Siara assignments from ${escapeHtml(currentAssignmentDate)} are colored by difficulty.` : "No open PRs in the latest snapshot."} Click a reviewer name to see their PRs.</p>
        ${totalOpen > 0 ? `${renderLegend({ includeExistingLoad: true })}${currentBody}` : `<p class="empty">No open PRs in the latest snapshot.</p>`}
      </div>
      <div class="sub-panel hidden" id="assign-history">
        <p class="section-hint">${historyTotal} review assignment(s) across ${historyMetrics.activeReviewers} reviewer(s) — one row per PR (includes merged PRs from GitHub review requests, not only net-new Siara picks). Height of the hard band shows who carries the risk.</p>
        ${historyTotal > 0 ? `${renderLegend()}${historyChart}` : `<p class="empty">No assignment history yet.</p>`}
      </div>
    </section>`;
}

/** Stacked bar chart of open review load per reviewer (current snapshot). */
function renderCurrentAssignmentsChart(
  openPrs: OpenPrSnapshot[],
  currentAssignmentDate: string,
  operationalAssignments: Assignment[],
  dir: Directory,
): string {
  if (openPrs.length === 0) {
    return "";
  }

  interface ReviewerState {
    login: string;
    /** Requested reviews not attributable to the latest Siara assignment. */
    existing: number;
    /** All current open review requests for this reviewer. */
    total: number;
    simple: number;
    moderate: number;
    hard: number;
  }

  const byReviewer = new Map<string, ReviewerState>();
  const ensure = (login: string): ReviewerState => {
    const existing = byReviewer.get(login);
    if (existing) return existing;
    const fresh: ReviewerState = {
      login,
      existing: 0,
      total: 0,
      simple: 0,
      moderate: 0,
      hard: 0,
    };
    byReviewer.set(login, fresh);
    return fresh;
  };

  // The last same-day operational entry is Siara's latest assignment for a PR.
  // Older still-open assignments are part of the neutral baseline for this run.
  const latestAssignmentByPr = new Map<string, Assignment>();
  for (const assignment of operationalAssignments) {
    if (assignment.date !== currentAssignmentDate) continue;
    if (assignment.rationale.startsWith("[AUTO-SCORED]")) continue;
    latestAssignmentByPr.set(`${assignment.repo}#${assignment.pr}`, assignment);
  }

  for (const pr of openPrs) {
    const siaraAssignment = latestAssignmentByPr.get(`${pr.repo}#${pr.pr}`);
    for (const login of pr.assignees) {
      const s = ensure(login);
      s.total++;
      if (siaraAssignment?.assignees.includes(login)) {
        s[siaraAssignment.band]++;
      } else {
        s.existing++;
      }
    }
  }

  const reviewers = [...byReviewer.values()].sort(
    (a, b) => b.total - a.total || a.login.localeCompare(b.login),
  );

  const maxTotal = Math.max(1, ...reviewers.map((r) => r.total));

  // Stacked horizontal bar chart — count before bars
  const W = 640;
  const labelW = 150;
  const countW = 60;
  const rowH = 28;
  const barH = 18;
  const barsX = labelW + countW;
  const barMax = W - barsX;
  const height = reviewers.length * rowH;

  const body = reviewers
    .map((r, i) => {
      const y = i * rowH + (rowH - barH) / 2;
      let x = barsX;
      const existingSeg = (() => {
        if (r.existing <= 0) return "";
        const w = (r.existing / maxTotal) * barMax;
        const rect = `<rect x="${fmt(x)}" y="${y}" width="${fmt(w)}" height="${barH}" fill="var(--load-existing)"><title>${escapeHtml(personTitle(r.login, dir))} — Existing open reviews: ${r.existing}</title></rect>`;
        const num =
          w >= 16
            ? `<text x="${fmt(x + w / 2)}" y="${y + barH / 2}" class="seg-num" text-anchor="middle" dominant-baseline="central">${r.existing}</text>`
            : "";
        x += w;
        return rect + num;
      })();
      const segs = BANDS.map((band) => {
        const n = r[band];
        if (n <= 0) return "";
        const w = (n / maxTotal) * barMax;
        const rect = `<rect x="${fmt(x)}" y="${y}" width="${fmt(w)}" height="${barH}" fill="var(--band-${band})"><title>${escapeHtml(personTitle(r.login, dir))} — ${BAND_LABEL[band]}: ${n} open</title></rect>`;
        const num =
          w >= 16
            ? `<text x="${fmt(x + w / 2)}" y="${y + barH / 2}" class="seg-num" text-anchor="middle" dominant-baseline="central">${n}</text>`
            : "";
        x += w;
        return rect + num;
      }).join("");

      const label = `<text x="${labelW - 10}" y="${y + barH / 2}" class="svg-label svg-link" data-filter-login="${escapeHtml(r.login)}" text-anchor="end" dominant-baseline="central">${escapeHtml(displayName(r.login, dir))}<title>${escapeHtml(personTitle(r.login, dir))}</title></text>`;
      const count = `<text x="${labelW + 6}" y="${y + barH / 2}" class="svg-count" dominant-baseline="central">${r.total}</text>`;
      return label + count + existingSeg + segs;
    })
    .join("");

  return svg(
    W,
    height,
    body,
    "Current open reviews per person: existing load and snapshot-day Siara assignments by difficulty",
  );
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
      --load-existing: #6b7280;
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
      --load-existing: #596273;
    }

    * { box-sizing: border-box; }

    html { font-size: 14px; }

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
    .svg-link { cursor: pointer; }
    .svg-link:hover { fill: var(--accent); text-decoration: underline; }
    .seg-num { fill: #fff; font-size: 11px; font-variant-numeric: tabular-nums; pointer-events: none; }
    .heat-num { font-size: 11px; font-variant-numeric: tabular-nums; pointer-events: none; }

    .tabs { display: flex; gap: 0.25rem; margin-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
    .tab {
      appearance: none; border: none; background: none; color: var(--muted);
      font: inherit; font-size: 0.9rem; font-weight: 600;
      padding: 0.55rem 0.9rem; cursor: pointer;
      border-bottom: 2px solid transparent; margin-bottom: -1px;
    }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--text); border-bottom-color: var(--accent); }
    .tab-panel.hidden { display: none; }

    .sub-tabs {
      display: flex; gap: 0.35rem; margin: 0 0 1rem;
      border-bottom: 1px solid var(--border);
    }
    .sub-tab {
      appearance: none; border: none; background: none; color: var(--muted);
      font: inherit; font-size: 0.82rem; font-weight: 600;
      padding: 0.4rem 0.75rem; cursor: pointer;
      border-bottom: 2px solid transparent; margin-bottom: -1px;
    }
    .sub-tab:hover { color: var(--text); }
    .sub-tab.active { color: var(--text); border-bottom-color: var(--accent); }
    .sub-panel.hidden { display: none; }

    .table-search {
      width: 100%; max-width: 320px; margin: 0 0 0.85rem;
      padding: 0.45rem 0.65rem; border: 1px solid var(--border); border-radius: 8px;
      background: var(--surface); color: var(--text); font: inherit; font-size: 0.85rem;
    }
    table.sortable th { user-select: none; }
    table.sortable th[data-dir="asc"]::after { content: " ▲"; color: var(--muted); font-size: 0.7em; }
    table.sortable th[data-dir="desc"]::after { content: " ▼"; color: var(--muted); font-size: 0.7em; }
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

    .algo-h3 { margin: 1.4rem 0 0.35rem; font-size: 0.9rem; font-weight: 620; }
    .algo-p { margin: 0 0 0.6rem; font-size: 0.86rem; color: var(--text); }
    .algo-p code {
      font-size: 0.82em; background: var(--bg); border: 1px solid var(--border);
      border-radius: 4px; padding: 0.05rem 0.3rem; font-variant-numeric: tabular-nums;
    }
    .algo-list {
      margin: 0 0 0.6rem; padding-left: 1.2rem;
      font-size: 0.86rem; color: var(--text);
    }
    .algo-list li { margin-bottom: 0.35rem; }
    tr.strat-row-main { background: color-mix(in srgb, var(--accent) 8%, transparent); }

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
    .pr-cell { min-width: 9rem; line-height: 1.25; }
    .pr-main { font-weight: 600; font-variant-numeric: tabular-nums; }
    a.pr-main { color: var(--accent); text-decoration: none; }
    a.pr-main:hover { text-decoration: underline; }
    .pr-org { display: block; font-size: 0.72rem; color: var(--muted); }
    .count { width: 5rem; font-variant-numeric: tabular-nums; color: var(--muted); }

    .svg-count { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }

    footer { margin-top: 2rem; font-size: 0.82rem; color: var(--muted); text-align: center; }

${CHART_STYLES}`;
