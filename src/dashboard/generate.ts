import type { Assignment, DifficultyBand, OpenPrSnapshot, ReviewResponse } from "../types.js";
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
  const heatmap = renderHeatmap(input.assignments);
  const sankeySection = renderSankey(metrics);
  const flameSection = renderFlame(metrics);
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

    <nav class="tabs" role="tablist">
      <button class="tab active" type="button" data-tab="overview">Dashboard</button>
      <button class="tab" type="button" data-tab="open-prs">Open PRs</button>
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
      <h2>Reviewer × repo</h2>
      <p class="section-hint">Assignments per reviewer per repository — darker = more. Scroll right for more repos.</p>
      ${heatmap}
    </section>

    ${sankeySection}

    ${flameSection}

    ${waitingSection}

    ${responseSection}

    ${overridesSection}
    </div>

    <div class="tab-panel hidden" id="tab-open-prs">
    ${openPrsSection}
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
            row.style.display =
              row.textContent.toLowerCase().indexOf(q) >= 0 ? "" : "none";
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
      const label = `<text x="${labelW - 10}" y="${y + barH / 2}" class="svg-label svg-link" data-filter-login="${escapeHtml(login)}" text-anchor="end" dominant-baseline="central">${escapeHtml(login)}</text>`;
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
 * Reviewer × repo heatmap — who covers which repository. Cell intensity (and the
 * inline count) scales with that reviewer's assignment count in the repo. Repos
 * are columns (short name), reviewers rows sorted by total volume.
 */
function renderHeatmap(assignments: Assignment[]): string {
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
      const label = `<text x="${labelW - 10}" y="${y + cell / 2}" class="svg-label" text-anchor="end" dominant-baseline="central">${escapeHtml(login)}</text>`;
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
function renderSankey(metrics: DashboardMetrics): string {
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
        `<path d="${d}" fill="none" stroke="var(--band-${b})" stroke-width="${fmt(Math.max(1, t))}" stroke-opacity="0.4"><title>${BAND_LABEL[b]} → ${escapeHtml(login)}: ${c}</title></path>`,
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
        `<rect x="${rightX}" y="${fmt(y)}" width="${nodeW}" height="${fmt(Math.max(1, h))}" rx="2" fill="var(--accent)"><title>${escapeHtml(login)}: ${metrics.reviewsPerPerson[login]}</title></rect>` +
        `<text x="${rightX + nodeW + 8}" y="${fmt(cy)}" class="svg-label" dominant-baseline="central">${escapeHtml(login)} <tspan class="svg-count">${metrics.reviewsPerPerson[login]}</tspan></text>`
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

/**
 * Flame/icicle chart of the workload: All → reviewer → difficulty band. Each
 * layer sums to the same total; cell width ∝ share of review volume. Reviewer
 * cells are tinted by their heaviest band; counts sit on every cell wide enough.
 */
function renderFlame(metrics: DashboardMetrics): string {
  const reviewers = Object.entries(metrics.reviewsPerPerson).sort(
    ([la, ca], [lb, cb]) => (cb !== ca ? cb - ca : la.localeCompare(lb)),
  );
  const total = reviewers.reduce((s, [, c]) => s + c, 0);
  if (total === 0) {
    return `<section><h2>Workload breakdown</h2><p class="empty">No assignments yet.</p></section>`;
  }

  const W = 920;
  const rowH = 38;
  const vgap = 3;
  const H = rowH * 3 + vgap * 2;
  const scale = W / total;

  const cell = (
    x: number,
    y: number,
    w: number,
    fill: string,
    label: string,
    count: number,
  ): string => {
    const text =
      w > 46
        ? `<text x="${fmt(x + 6)}" y="${fmt(y + rowH / 2)}" class="flame-label" dominant-baseline="central">${escapeHtml(label)} ${count}</text>`
        : "";
    return `<rect x="${fmt(x)}" y="${y}" width="${fmt(Math.max(1, w - 1))}" height="${rowH}" rx="3" fill="${fill}"><title>${escapeHtml(label)}: ${count}</title></rect>${text}`;
  };

  const y1 = rowH + vgap;
  const y2 = (rowH + vgap) * 2;
  let body = cell(0, 0, W, "var(--accent)", "All assignments", total);

  let x = 0;
  for (const [login, cnt] of reviewers) {
    const w = cnt * scale;
    const byBand = metrics.bandByPerson[login] ?? { simple: 0, moderate: 0, hard: 0 };
    const dom = BANDS.reduce((best, b) => (byBand[b] > byBand[best] ? b : best), BANDS[0]);
    body += cell(x, y1, w, `var(--band-${dom})`, login, cnt);
    let bx = x;
    for (const b of BANDS) {
      const bc = byBand[b];
      if (bc <= 0) continue;
      body += cell(bx, y2, bc * scale, `var(--band-${b})`, BAND_LABEL[b], bc);
      bx += bc * scale;
    }
    x += w;
  }

  const chart = `<svg class="chart chart-fixed" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Workload breakdown flame graph" preserveAspectRatio="xMinYMin meet">${body}</svg>`;
  return `<section>
      <h2>Workload breakdown</h2>
      <p class="section-hint">Flame graph: all assignments → reviewer → difficulty band. Width = share of total review volume.</p>
      <div class="scroll-x">${chart}</div>
    </section>`;
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
          <td class="login"><span class="reviewer-link" data-filter-login="${escapeHtml(login)}">${escapeHtml(login)}</span></td>
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
  const bandRank: Record<DifficultyBand, number> = { simple: 0, moderate: 1, hard: 2 };
  const stalenessRank: Record<OpenPrSnapshot["staleness"], number> = {
    normal: 0,
    warning: 1,
    overdue: 2,
  };
  const sorted = [...prs].sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  const body = sorted
    .map((pr) => {
      const badge = STALENESS_BADGE[pr.staleness];
      const age = pr.ageDays === undefined ? "—" : `${pr.ageDays}d`;
      const band = pr.band
        ? `<span class="badge" style="background: var(--band-${pr.band})">${BAND_LABEL[pr.band]}</span>`
        : "—";
      const bandVal = pr.band ? bandRank[pr.band] : -1;
      const assignees = escapeHtml(pr.assignees.join(", ") || "—");
      return `
        <tr>
          <td class="login">${escapeHtml(pr.repo)}#${pr.pr}</td>
          <td>${escapeHtml(pr.title)}</td>
          <td data-val="${bandVal}">${band}</td>
          <td>${assignees}</td>
          <td class="count" data-val="${pr.ageDays ?? -1}">${age}</td>
          <td data-val="${stalenessRank[pr.staleness]}"><span class="badge" style="background: ${badge.color}">${badge.label}</span></td>
        </tr>`;
    })
    .join("");
  const takenAt = snapshot?.takenAt ? escapeHtml(snapshot.takenAt.slice(0, 10)) : "";
  return `<section>
      <h2>Open PRs</h2>
      <p class="section-hint">Point-in-time snapshot${takenAt ? ` from ${takenAt}` : ""} — click a column to sort; search filters rows.</p>
      <input type="search" class="table-search" data-target="open-prs-table" placeholder="Search open PRs…" aria-label="Search open PRs">
      <table id="open-prs-table" class="sortable">
        <thead>
          <tr><th data-sort="text">PR</th><th data-sort="text">Title</th><th data-sort="num">Difficulty</th><th data-sort="text">Assignees</th><th data-sort="num">Age</th><th data-sort="num">Status</th></tr>
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
    .svg-link { cursor: pointer; }
    .svg-link:hover { fill: var(--accent); text-decoration: underline; }
    .reviewer-link { color: var(--accent); cursor: pointer; }
    .reviewer-link:hover { text-decoration: underline; }
    .flame-label { fill: #fff; font-size: 12px; font-variant-numeric: tabular-nums; pointer-events: none; }
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
