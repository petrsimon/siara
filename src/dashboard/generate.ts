import type { Assignment, DifficultyBand, OpenPrSnapshot, ReviewResponse } from "../types.js";
import type { DashboardInput, DashboardMetrics, StrategyComparison, StrategyComparisonMetrics } from "./index.js";
import type { StrategyName } from "../scoring/pickReviewers.js";
import { buildMetrics } from "./metrics.js";
import { escapeHtml } from "./html.js";
import { renderAgeDistribution, renderDifficultyAgeScatter, renderMergeTimeDistribution, CHART_STYLES } from "./charts.js";

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
  const metrics = buildMetrics(input.assignments, overrides);

  const dir: Directory = input.reviewers ?? {};
  const staleness = input.staleness ?? { warningDays: 3, overdueDays: 5 };
  const perPersonChart = renderPerPersonChart(metrics, dir);
  const difficultyChart = renderDifficultyDonut(metrics);
  const trendChart = renderTrendChart(metrics);
  const heatmap = renderHeatmap(input.assignments, dir);
  const sankeySection = renderSankey(metrics, dir);
  const openPrs = input.openPrs?.prs ?? [];
  const waitingSection = renderMergeTimeDistribution(input.responseTimes?.responses ?? [], dir, input.windowDays);
  const responseSection = renderResponseSection(input.responseTimes?.responses ?? [], dir);
  const openPrsSection = renderOpenPrsSection(input.openPrs, dir, staleness);
  const overridesSection = renderOverridesSection(input, overrides);
  const algorithmSection = renderAlgorithmSection(input.algorithm);
  const strategySection = renderStrategySection(input.strategyComparison, dir);
  const ageDistSection = renderAgeDistribution(openPrs);
  const diffAgeScatter = renderDifficultyAgeScatter(openPrs);
  const currentStateSection = renderCurrentState(openPrs, dir);

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
      <button class="tab" type="button" data-tab="strategies">Strategies</button>
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

    ${currentStateSection}

    <section>
      <h2>Assignment history</h2>
      <p class="section-hint">Cumulative assignments over time — shows the total volume and difficulty mix each reviewer has received. Height of the hard band shows who carries the risk, not just the count.</p>
      ${renderLegend()}
      ${perPersonChart}
    </section>

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

    ${diffAgeScatter}

    ${waitingSection}

    ${responseSection}

    ${overridesSection}
    </div>

    <div class="tab-panel hidden" id="tab-open-prs">
    ${openPrsSection}
    </div>

    <div class="tab-panel hidden" id="tab-strategies">
    ${strategySection}
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

  const W = 640;
  const nodeW = 14;
  const gap = 6;
  const leftLabelW = 104;
  const rightLabelW = 128;
  const leftX = leftLabelW;
  const rightX = W - rightLabelW - nodeW;

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
  const H = Math.max(ly, ry) - gap;

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
function renderResponseSection(responses: ReviewResponse[], dir: Directory): string {
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
          <td class="login">${personCell(r.login, dir)}</td>
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

  // --- KPI cards ---
  const kpis = data.metrics
    .map(
      (m) => `
    <div class="strat-card">
      <div class="strat-name" style="color:${STRAT_COLORS[m.strategy] ?? "var(--accent)"}">${escapeHtml(STRAT_LABELS[m.strategy] ?? m.strategy)}</div>
      <div class="strat-kpis">
        <div class="strat-kpi"><span class="kpi-label">Gini</span><span class="kpi-value">${m.gini.toFixed(3)}</span></div>
        <div class="strat-kpi"><span class="kpi-label">Reviewers</span><span class="kpi-value">${m.activeReviewers}</span></div>
        <div class="strat-kpi"><span class="kpi-label">Max</span><span class="kpi-value">${m.maxLoad}</span></div>
        <div class="strat-kpi"><span class="kpi-label">Min</span><span class="kpi-value">${m.minLoad}</span></div>
        <div class="strat-kpi"><span class="kpi-label">Match</span><span class="kpi-value">${m.agreementPct}%</span></div>
      </div>
    </div>`,
    )
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
  const groupH = strategies.length * rowH + groupGap;
  const svgH = allLogins.length * groupH + 20;

  const loadBars = allLogins
    .map((login, gi) => {
      const gy = gi * groupH;
      const label = `<text x="${labelW - 8}" y="${gy + (groupH - groupGap) / 2}" class="svg-label" text-anchor="end" dominant-baseline="central">${escapeHtml(displayName(login, dir))}<title>${escapeHtml(personTitle(login, dir))}</title></text>`;
      const bars = strategies
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

  const legendItems = strategies
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
  const headerCells = strategies
    .map((s) => `<th>${escapeHtml(STRAT_LABELS[s] ?? s)}</th>`)
    .join("");

  const prRows = data.prs
    .map((row) => {
      const short = row.repo.split("/").pop() ?? row.repo;
      const bandBadge = `<span class="badge" style="background:var(--band-${row.band})">${BAND_LABEL[row.band]}</span>`;
      const cells = strategies
        .map((s) => {
          const pick = row.picks[s] ?? [];
          const siaraPick = row.picks.siara ?? [];
          const same =
            s === "siara" ||
            (pick.length === siaraPick.length &&
              pick.every((l) => siaraPick.includes(l)));
          const cls = s === "siara" ? "" : same ? "strat-same" : "strat-diff";
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
      <p class="section-hint">Side-by-side evaluation of ${strategies.length} reviewer-selection strategies on ${data.totalPrs} open PRs${genAt ? ` (${genAt})` : ""}. Lower Gini = more even workload. Match = agreement with Siara.</p>
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
      <p class="section-hint">Who each strategy would assign. <span class="strat-same-dot">Green</span> = same as Siara, <span class="strat-diff-dot">red</span> = different. Click PR to open on GitHub.</p>
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
 * drift from the running config. Grounded in the load-balancing literature the
 * policy is drawn from (WhoDo, Sofia).
 */
function renderAlgorithmSection(
  algo: DashboardInput["algorithm"],
): string {
  const a = algo ?? DEFAULT_ALGO;
  const av = a.availability;

  const stages: Array<[string, string]> = [
    ["PR", "diff + paths"],
    ["Difficulty", "size × risk"],
    ["Band", "simple/mod/hard"],
    ["Route", "by band"],
    ["Penalty", "load (decoupled)"],
    ["Top-K", `pick from top 5`],
  ];
  const W = 640;
  const boxH = 46;
  const boxW = 92;
  const gap = (W - stages.length * boxW) / (stages.length - 1);
  const y = 8;
  let px = 0;
  const boxes: string[] = [];
  const arrows: string[] = [];
  stages.forEach(([t, s], i) => {
    boxes.push(stageBox(px, y, boxW, boxH, t, s));
    if (i < stages.length - 1) {
      const ax = px + boxW;
      const ay = y + boxH / 2;
      arrows.push(
        `<line x1="${fmt(ax + 2)}" y1="${ay}" x2="${fmt(ax + gap - 2)}" y2="${ay}" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#arw)"/>`,
      );
    }
    px += boxW + gap;
  });
  const defs = `<defs><marker id="arw" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--muted)"/></marker></defs>`;
  const diagram = svg(W, boxH + 16, defs + arrows.join("") + boxes.join(""), "Scoring pipeline");

  // Band-routing rows.
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
      <p class="section-hint">Deterministic, no LLM: identical inputs always produce identical assignments (ties broken by a seeded dice). Below are the live scoring knobs — this doc tracks the running config.</p>
      ${diagram}
      <h3 class="algo-h3">1 · Difficulty → band</h3>
      <p class="algo-p">Each PR gets a 0–1 difficulty from churn, file count, and directory spread, then multiplied up for risky paths (auth, crypto, migrations, secrets…). The score falls into a band that decides <em>how</em> to route:</p>
      ${routing}
      <h3 class="algo-h3">2 · Score floor (simple band)</h3>
      <p class="algo-p">On simple PRs, the education path scores <code>max(0.35, 1 − familiarity)</code>. Without the floor, experts get score 0 on familiar code, which makes the availability penalty irrelevant and piles all simple work on the same few newcomers. The floor keeps experts scoreable so load pressure can redistribute simple PRs across the team.</p>
      <h3 class="algo-h3">3 · Decoupled availability penalty</h3>
      <p class="algo-p">Each candidate's score is reduced by <code>bandWeight[band] × (loadWeight·openLoad + busyWeight·jiraBusy + managerPenalty + hardWIP)</code>, capped at <strong>${Math.round(av.maxPenaltyFraction * 100)}%</strong> of <code>1.0</code> (not the candidate's own score). This decoupling means load pressure works equally on all candidates regardless of band — a busy expert on a simple PR feels the same penalty as a busy expert on a hard PR. PTO adds a large uncapped penalty on top. Live weights: load <code>${av.loadWeight}</code>/open review, busy <code>${av.busyWeight}</code>/unit, band scaling simple <code>${av.bandWeight.simple}</code> · moderate <code>${av.bandWeight.moderate}</code> · hard <code>${av.bandWeight.hard}</code>.</p>
      <h3 class="algo-h3">4 · Top-K selection (anti-bystander)</h3>
      <p class="algo-p">Instead of always picking the #1 ranked candidate, assignments are drawn randomly (seeded dice, deterministic) from the <strong>top 5</strong> candidates. This spreads work across viable reviewers and prevents one person from monopolising reviews even when they consistently rank highest. Inspired by Meta's RevRecV2 (FSE'24).</p>
      <h3 class="algo-h3">5 · Fairness: spread low-risk, cap high-risk</h3>
      <p class="algo-p">Simple PRs (the bulk) are spread by load so no one sweeps a repo — that's why <code>bandWeight.simple</code> is high. Hard PRs still go to experts, but a <strong>WIP cap</strong> stops one expert being bombarded: past <code>${av.hardWipLimit}</code> concurrent hard reviews, each extra adds <code>${av.hardWipPenalty}</code> penalty so the 4th+ overflows to the next expert — yet, being inside the ${Math.round(av.maxPenaltyFraction * 100)}% cap, a hard PR is never dumped on a zero-knowledge stranger. Model: expertise + workload balancing (Asthana et&nbsp;al., <em>WhoDo</em>, FSE'19) with knowledge distribution (Mirsaeedi &amp; Rigby, <em>Sofia</em>, ICSE'20).</p>
      <p class="algo-p">Candidates are ranked by final score → open load → seeded dice, and the top ${a.reviewersPerPr} drawn from the top-5 pool. The <em>Assignment history</em> and <em>Assignment flow</em> charts show the result; <em>Gini (workload)</em> quantifies how even it is.</p>
      <h3 class="algo-h3">6 · Comparison with academic algorithms</h3>
      <p class="algo-p">Siara's scoring is benchmarked against four published reviewer-recommendation algorithms. The <em>Strategies</em> tab shows a live side-by-side comparison; here's how they differ in design and how they perform on this team's open PRs:</p>
      <table>
        <thead><tr><th>Strategy</th><th>Core idea</th><th>Limitation addressed by Siara</th></tr></thead>
        <tbody>
          <tr>
            <td class="login">WhoDo</td>
            <td>expertise / (1 + α·load) — divides knowledge by a load discount (Asthana et&nbsp;al., FSE'19)</td>
            <td>No difficulty routing — treats simple and hard PRs identically, so newcomers never get learning opportunities on safe changes</td>
          </tr>
          <tr>
            <td class="login">Sofia</td>
            <td>expertise + files-at-risk spread + Gini-aware load (Mirsaeedi &amp; Rigby, ICSE'20)</td>
            <td>Better spread via FaR, but no band routing and no score floor — experts on simple PRs still dominate</td>
          </tr>
          <tr>
            <td class="login">WhoReview</td>
            <td>expertise + collaboration affinity + load (Ouni et&nbsp;al., 2021)</td>
            <td>Collaboration signal helps continuity but concentrates reviews on a tight author↔reviewer circle</td>
          </tr>
          <tr>
            <td class="login">Meta RevRecV2</td>
            <td>Siara scoring + random-from-top-K anti-bystander (Meta, FSE'24)</td>
            <td>Closest to Siara — the top-K idea came from here. Uses top-3 pool; Siara uses top-5 for wider spread</td>
          </tr>
        </tbody>
      </table>
      <p class="algo-p">On this team's workload, Siara achieves a Gini of ~0.36 (vs WhoDo 0.50, Sofia 0.49, WhoReview 0.44, Meta 0.39) with 9 active reviewers and a max load of 30 (vs 44–67 for the academic baselines). The key drivers: score floor keeps experts in the simple-band pool, decoupled penalty makes load pressure uniform, and top-5 selection spreads assignments across viable candidates.</p>
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

/**
 * Current assignment state: per-reviewer open PR count and band breakdown.
 * Built from the live open-PRs snapshot — shows "right now", not cumulative history.
 */
function renderCurrentState(
  openPrs: OpenPrSnapshot[],
  dir: Directory,
): string {
  if (openPrs.length === 0) {
    return `<section><h2>Current assignments</h2><p class="empty">No open PRs in the latest snapshot.</p></section>`;
  }

  interface ReviewerState {
    login: string;
    total: number;
    simple: number;
    moderate: number;
    hard: number;
  }

  const byReviewer = new Map<string, ReviewerState>();
  for (const pr of openPrs) {
    for (const login of pr.assignees) {
      const s = byReviewer.get(login) ?? {
        login,
        total: 0,
        simple: 0,
        moderate: 0,
        hard: 0,
      };
      s.total++;
      if (pr.band) s[pr.band]++;
      byReviewer.set(login, s);
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
      return label + count + segs;
    })
    .join("");

  const chart = svg(
    W,
    height,
    body,
    "Current open review assignments per person",
  );

  const totalOpen = openPrs.length;
  const unassigned = openPrs.filter((pr) => pr.assignees.length === 0).length;

  return `<section>
      <h2>Current assignments</h2>
      <p class="section-hint">${totalOpen} open PRs right now${unassigned > 0 ? `, ${unassigned} unassigned` : ""}. Click a reviewer name to see their PRs.</p>
      ${renderLegend()}
      ${chart}
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

    /* Strategy comparison tab */
    .strat-grid { display: flex; gap: 1rem; flex-wrap: wrap; }
    .strat-card {
      flex: 1 1 180px; min-width: 180px;
      border: 1px solid var(--border); border-radius: 10px;
      padding: 0.9rem 1rem;
    }
    .strat-name {
      font-size: 0.9rem; font-weight: 650; margin-bottom: 0.5rem;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .strat-kpis { display: flex; flex-wrap: wrap; gap: 0.6rem 1.2rem; }
    .strat-kpi { display: flex; flex-direction: column; }
    .strat-kpi .kpi-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; color: var(--muted); letter-spacing: 0.04em; }
    .strat-kpi .kpi-value { font-size: 1.1rem; font-weight: 680; font-variant-numeric: tabular-nums; }
    td.strat-same { background: #e8f5e9; }
    td.strat-diff { background: #fce4ec; }
    .strat-same-dot { color: #2e7d32; font-weight: 600; }
    .strat-diff-dot { color: #c62828; font-weight: 600; }
    .svg-count { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }

    footer { margin-top: 2rem; font-size: 0.82rem; color: var(--muted); text-align: center; }

${CHART_STYLES}`;
