/**
 * Advanced chart generators for age distribution and difficulty×age scatter.
 * Rendered as inline SVG in the dashboard.
 */

import type {
  DifficultyBand,
  OpenPrSnapshot,
  OpenedToAssignment,
  ReviewAgePoint,
  ReviewResponse,
} from "../types.js";
import { escapeHtml } from "./html.js";

const BAND_LABEL: Record<DifficultyBand, string> = {
  simple: "Simple",
  moderate: "Moderate",
  hard: "Hard",
};

const AGE_BUCKET_LABELS = ["0-1d", "1-3d", "3-7d", "1-2w", "2-4w", "1-2mo", "2-3mo", "3mo+"];
const AGE_BUCKET_EDGES = [0, 1, 3, 7, 14, 30, 60, 90, Infinity];
const AGE_BUCKET_COLORS = ["#268bd2", "#2aa198", "#859900", "#b58900", "#cb4b16", "#d33682", "#6c71c4", "#dc322f"];
const MIN_SEGMENT_WIDTH = 22;

/** Wrap chart body in a responsive, accessible SVG. */
function svg(w: number, h: number, body: string, title: string): string {
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMinYMin meet">${body}</svg>`;
}

/** Trim float noise from SVG coordinates. */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Reserve enough room for the complete repository label and its summary. */
function repoLabelWidth(labels: string[], minimum: number): number {
  const longest = Math.max(...labels.map((label) => label.length), 0);
  // The labels use a 12px proportional font. This intentionally overestimates
  // slightly so long labels are not clipped at the left edge of the SVG.
  return Math.max(minimum, Math.ceil(longest * 7.1 + 20));
}

/** Keep small nonzero segments wide enough to show their count. */
function bucketWidths(counts: number[], maxCount: number, nominalPlotW: number): number[] {
  const scale = nominalPlotW / Math.max(maxCount, 1);
  return counts.map((count) => (count === 0 ? 0 : Math.max(count * scale, MIN_SEGMENT_WIDTH)));
}

/** Quartiles and IQR calculation. */
interface Quartiles {
  q1: number;
  median: number;
  q3: number;
  iqr: number;
  lowerFence: number;
  upperFence: number;
}

function quartiles(data: number[]): Quartiles {
  const sorted = [...data].sort((a, b) => a - b);
  const n = sorted.length;
  
  const medianIdx = Math.floor(n / 2);
  const median = n % 2 === 0 
    ? ((sorted[medianIdx - 1] ?? 0) + (sorted[medianIdx] ?? 0)) / 2
    : (sorted[medianIdx] ?? 0);
  
  const q1Idx = Math.floor(n / 4);
  const q1 = n % 4 === 0 
    ? ((sorted[q1Idx - 1] ?? 0) + (sorted[q1Idx] ?? 0)) / 2
    : (sorted[q1Idx] ?? 0);
  
  const q3Idx = Math.floor((3 * n) / 4);
  const q3 = n % 4 === 0 
    ? ((sorted[q3Idx - 1] ?? 0) + (sorted[q3Idx] ?? 0)) / 2
    : (sorted[q3Idx] ?? 0);
  
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  
  return { q1, median, q3, iqr, lowerFence, upperFence };
}

/**
 * Age distribution histogram with IQR-based outlier detection.
 * Returns both full-data and filtered views as HTML sections.
 */
export function renderAgeDistribution(points: ReviewAgePoint[]): string {
  const ages = points.map((point) => point.ageDays);
  
  if (ages.length === 0) {
    return `<section><h2>Review age distribution</h2><p class="empty">No review assignments with known lifecycle age.</p></section>`;
  }
  
  const stats = quartiles(ages);
  const inliers = ages.filter(a => a >= stats.lowerFence && a <= stats.upperFence);
  const outliers = ages.filter(a => a < stats.lowerFence || a > stats.upperFence);
  
  // Generate both views
  const fullChart = renderHistogram(ages, stats, "All data", true);
  const filteredChart = inliers.length > 0 
    ? renderHistogram(inliers, stats, "IQR-filtered (outliers excluded)", false)
    : `<p class="empty">All data points are outliers.</p>`;
  
  const outlierNote = outliers.length > 0
    ? `<p class="section-hint">${outliers.length} outliers detected (outside 1.5×IQR). Outliers: ${outliers.sort((a, b) => b - a).map((a) => `${fmtDays(a)}d`).join(", ")}</p>`
    : `<p class="section-hint">No outliers detected.</p>`;
  
  return `<section>
      <h2>Review age distribution</h2>
      <p class="section-hint">How long PRs spend in review, from the first reviewer assignment/request until merge (or the latest report time for open PRs), bucketed by industry-standard time ranges. Quartiles and IQR-based outlier detection (1.5×IQR rule).</p>
      ${outlierNote}
      <div class="grid-2">
        <div>
          <h3 class="chart-title">All data (n=${ages.length})</h3>
          ${fullChart}
        </div>
        <div>
          <h3 class="chart-title">Filtered (n=${inliers.length})</h3>
          ${filteredChart}
        </div>
      </div>
    </section>`;
}

/**
 * Stacked review-lifecycle age buckets by repository. Bar length shows total
 * PR volume; segment colors show how long each PR has spent in review.
 */
export function renderRepoAgeDistribution(points: ReviewAgePoint[]): string {
  const byRepo = new Map<string, number[]>();
  for (const point of points) {
    const ages = byRepo.get(point.repo) ?? [];
    ages.push(point.ageDays);
    byRepo.set(point.repo, ages);
  }

  if (byRepo.size === 0) {
    return `<section><h2>Review age by repository</h2><p class="empty">No review assignments with known lifecycle age by repository.</p></section>`;
  }

  const rows = [...byRepo.entries()]
    .map(([repo, ages]) => ({ repo, ages }))
    .sort((a, b) => b.ages.length - a.ages.length || a.repo.localeCompare(b.repo));
  const maxTotal = Math.max(...rows.map((row) => row.ages.length), 1);
  const labelTexts = rows.map(({ repo, ages }) => `${repo.split("/").pop() ?? repo} (${ages.length})`);
  const labelW = repoLabelWidth(labelTexts, 190);
  const nominalPlotW = 470;
  const plotW = Math.max(
    nominalPlotW,
    ...rows.map(({ ages }) => {
      const counts = AGE_BUCKET_LABELS.map(() => 0);
      for (const age of ages) {
        const edgeIndex = AGE_BUCKET_EDGES.findIndex((edge, i) => i > 0 && age < edge);
        const bucketIndex = edgeIndex >= 0 ? edgeIndex - 1 : counts.length - 1;
        counts[bucketIndex]! += 1;
      }
      return bucketWidths(counts, maxTotal, nominalPlotW).reduce((sum, width) => sum + width, 0);
    }),
  );
  const totalW = 70;
  const padT = 10;
  const padB = 12;
  const rowH = 30;
  const barH = 18;
  const H = padT + rows.length * rowH + padB;

  const body = rows.map(({ repo, ages }, rowIndex) => {
    const y = padT + rowIndex * rowH + (rowH - barH) / 2;
    const counts = AGE_BUCKET_LABELS.map(() => 0);
    for (const age of ages) {
      const edgeIndex = AGE_BUCKET_EDGES.findIndex((edge, i) => i > 0 && age < edge);
      const bucketIndex = edgeIndex >= 0 ? edgeIndex - 1 : counts.length - 1;
      counts[bucketIndex]! += 1;
    }

    let x = labelW;
    const widths = bucketWidths(counts, maxTotal, nominalPlotW);
    const segments = counts.map((count, bucketIndex) => {
      if (count === 0) return "";
      const width = widths[bucketIndex]!;
      const segment = `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${barH}" fill="${AGE_BUCKET_COLORS[bucketIndex]}" fill-opacity="0.82" rx="2"><title>${escapeHtml(repo)} — ${AGE_BUCKET_LABELS[bucketIndex]}: ${count} PR${count === 1 ? "" : "s"}</title></rect>`;
      const number = width >= MIN_SEGMENT_WIDTH
        ? `<text x="${fmt(x + width / 2)}" y="${fmt(y + barH / 2)}" class="seg-num" text-anchor="middle" dominant-baseline="central">${count}</text>`
        : "";
      x += width;
      return segment + number;
    }).join("");

    const shortRepo = repo.split("/").pop() ?? repo;
    const label = `<text x="${labelW - 10}" y="${fmt(y + barH / 2)}" class="svg-label" text-anchor="end" dominant-baseline="central">${escapeHtml(shortRepo)}<tspan class="svg-count"> (${ages.length})</tspan><title>${escapeHtml(repo)} — ${ages.length} PR${ages.length === 1 ? "" : "s"} in review-age data</title></text>`;
    const total = `<text x="${labelW + plotW + 8}" y="${fmt(y + barH / 2)}" class="svg-count" dominant-baseline="central">${ages.length} total</text>`;
    return label + segments + total;
  }).join("");

  const legend = AGE_BUCKET_LABELS.map((label, i) =>
    `<li><span class="swatch" style="background:${AGE_BUCKET_COLORS[i]}"></span>${label}</li>`,
  ).join("");

  return `<section>
      <h2>Review age by repository</h2>
      <p class="section-hint">PR volume and review-age mix per repository. Age is measured from the first reviewer assignment/request until merge, or until the report time for open PRs. Bar length is total PRs with known lifecycle age; segments are age buckets (small nonzero buckets use a minimum display width). Hover segments for counts.</p>
      <ul class="legend">${legend}</ul>
      <div class="scroll-x">${svg(labelW + plotW + totalW, H, body, "Review age distribution by repository")}</div>
    </section>`;
}

/**
 * Stacked PR-opened-to-assignment buckets by repository. Completed bars
 * show elapsed time; PRs still waiting for assignment are counted separately.
 */
export function renderRepoOpenedToAssignmentDistribution(
  observations: OpenedToAssignment[],
): string {
  const byRepo = new Map<string, { completed: number[]; pending: number }>();
  for (const observation of observations) {
    const state = byRepo.get(observation.repo) ?? { completed: [], pending: 0 };
    if (observation.latencyHours !== undefined && !observation.outstanding) {
      state.completed.push(observation.latencyHours / 24);
    } else if (observation.outstanding) {
      state.pending++;
    }
    byRepo.set(observation.repo, state);
  }

  if (byRepo.size === 0) {
    return `<section><h2>PR opened to reviewer assignment <span class="provisional">(provisional)</span></h2><p class="empty">No PRs with a known opened timestamp.</p></section>`;
  }

  const rows = [...byRepo.entries()]
    .map(([repo, state]) => ({ repo, ...state }))
    .sort(
      (a, b) =>
        b.completed.length + b.pending - (a.completed.length + a.pending) ||
        a.repo.localeCompare(b.repo),
    );
  const maxCompleted = Math.max(...rows.map((row) => row.completed.length), 1);
  const labelTexts = rows.map(({ repo, completed, pending }) => `${repo.split("/").pop() ?? repo} (${completed.length} completed, ${pending} pending)`);
  const labelW = repoLabelWidth(labelTexts, 220);
  const nominalPlotW = 470;
  const plotW = Math.max(
    nominalPlotW,
    ...rows.map(({ completed }) => {
      const counts = AGE_BUCKET_LABELS.map(() => 0);
      for (const days of completed) {
        const edgeIndex = AGE_BUCKET_EDGES.findIndex((edge, i) => i > 0 && days < edge);
        const bucketIndex = edgeIndex >= 0 ? edgeIndex - 1 : counts.length - 1;
        counts[bucketIndex]! += 1;
      }
      return bucketWidths(counts, maxCompleted, nominalPlotW).reduce((sum, width) => sum + width, 0);
    }),
  );
  const totalW = 120;
  const padT = 10;
  const padB = 12;
  const rowH = 34;
  const barH = 18;
  const H = padT + rows.length * rowH + padB;

  const body = rows.map(({ repo, completed, pending }, rowIndex) => {
    const y = padT + rowIndex * rowH + (rowH - barH) / 2;
    const counts = AGE_BUCKET_LABELS.map(() => 0);
    for (const days of completed) {
      const edgeIndex = AGE_BUCKET_EDGES.findIndex((edge, i) => i > 0 && days < edge);
      const bucketIndex = edgeIndex >= 0 ? edgeIndex - 1 : counts.length - 1;
      counts[bucketIndex]! += 1;
    }

    let x = labelW;
    const widths = bucketWidths(counts, maxCompleted, nominalPlotW);
    const segments = counts.map((count, bucketIndex) => {
      if (count === 0) return "";
      const width = widths[bucketIndex]!;
      const segment = `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${barH}" fill="${AGE_BUCKET_COLORS[bucketIndex]}" fill-opacity="0.82" rx="2"><title>${escapeHtml(repo)} — ${AGE_BUCKET_LABELS[bucketIndex]}: ${count} completed PR${count === 1 ? "" : "s"}</title></rect>`;
      const number = width >= MIN_SEGMENT_WIDTH
        ? `<text x="${fmt(x + width / 2)}" y="${fmt(y + barH / 2)}" class="seg-num" text-anchor="middle" dominant-baseline="central">${count}</text>`
        : "";
      x += width;
      return segment + number;
    }).join("");

    const shortRepo = repo.split("/").pop() ?? repo;
    const label = `<text x="${labelW - 10}" y="${fmt(y + barH / 2)}" class="svg-label" text-anchor="end" dominant-baseline="central">${escapeHtml(shortRepo)}<tspan class="svg-count"> (${completed.length} completed, ${pending} pending)</tspan><title>${escapeHtml(repo)}</title></text>`;
    const total = `<text x="${labelW + plotW + 8}" y="${fmt(y + barH / 2)}" class="svg-count" dominant-baseline="central">${pending > 0 ? `${pending} pending` : `${completed.length} total`}</text>`;
    return label + segments + total;
  }).join("");

  const legend = AGE_BUCKET_LABELS.map((label, i) =>
    `<li><span class="swatch" style="background:${AGE_BUCKET_COLORS[i]}"></span>${label}</li>`,
  ).join("");

  return `<section>
      <h2>PR opened to reviewer assignment <span class="provisional">(provisional)</span></h2>
      <p class="section-hint"><strong>Provisional metric:</strong> time from PR opened to the first direct reviewer request, by repository. Ready-for-review timestamps are not yet used; the oldest <code>ReadyForReviewEvent</code> will be collected in a future backfill. Completed intervals use the same time buckets as PR age; pending open PRs are shown separately. Small nonzero buckets use a minimum display width so their counts remain visible.</p>
      <ul class="legend">${legend}</ul>
      <div class="scroll-x">${svg(labelW + plotW + totalW, H, body, "Provisional PR opened to reviewer assignment by repository")}</div>
    </section>`;
}

/** 
 * Render a histogram with quartile markers.
 * @param data - Ages to histogram
 * @param stats - Pre-computed quartiles for marker lines
 * @param title - Chart title
 * @param showOutliers - Whether this chart includes outliers
 */
function renderHistogram(
  data: number[], 
  stats: Quartiles, 
  title: string,
  showOutliers: boolean
): string {
  if (data.length === 0) {
    return `<p class="empty">No data.</p>`;
  }
  
  const W = 380;
  const H = 240;
  const padL = 50;
  const padR = 20;
  const padT = 20;
  const padB = 50;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  
  // Fixed time buckets aligned with industry SLAs and business expectations.
  // Keep these shared with the per-repository chart below.
  const bucketEdges = AGE_BUCKET_EDGES;
  const bucketLabels = AGE_BUCKET_LABELS;

  // Build histogram bins
  const bins: { min: number; max: number; label: string; count: number }[] = [];
  for (let i = 0; i < bucketEdges.length - 1; i++) {
    bins.push({
      min: bucketEdges[i]!,
      max: bucketEdges[i + 1]!,
      label: bucketLabels[i]!,
      count: 0,
    });
  }

  for (const age of data) {
    const idx = bucketEdges.findIndex((edge, i) => i > 0 && age < edge) - 1;
    const binIdx = idx >= 0 ? idx : bins.length - 1;
    bins[binIdx]!.count++;
  }

  // Filter out empty bins at the end
  while (bins.length > 0 && bins[bins.length - 1]!.count === 0) {
    bins.pop();
  }
  
  const maxCount = Math.max(...bins.map(b => b.count), 1);
  const binCount = bins.length;

  // Draw bars with labels underneath
  const barsAndLabels = bins.map((bin, i) => {
    const x = padL + (i / binCount) * plotW;
    const barW = plotW / binCount - 2;
    const barH = (bin.count / maxCount) * plotH;
    const y = padT + plotH - barH;
    const centerX = x + barW / 2;

    const maxVal = bin.max === Infinity ? "+" : bin.max.toFixed(0);
    const bar = `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(barW)}" height="${fmt(barH)}" fill="var(--accent)" fill-opacity="0.7" rx="2"><title>${bin.label}: ${bin.count} PRs</title></rect>`;

    // Always use non-rotated labels with short bucket names
    const label = `<text x="${fmt(centerX)}" y="${padT + plotH + 18}" class="svg-tick" text-anchor="middle" style="font-size: 10px">${bin.label}</text>`;

    return bar + label;
  }).join("");
  
  // Y-axis ticks (count)
  const yTicks = [0, Math.floor(maxCount / 2), maxCount].map(count => {
    const y = padT + plotH - (count / maxCount) * plotH;
    return `<text x="${padL - 8}" y="${fmt(y)}" class="svg-tick" text-anchor="end" dominant-baseline="central">${count}</text>`;
  }).join("");

  // Quartile markers - map to bucket positions
  const markers = [];
  const maxBucketEdge = bins[bins.length - 1]!.max === Infinity
    ? bins[bins.length - 1]!.min + 90  // Use 90 days as visual max for infinity bucket
    : bins[bins.length - 1]!.max;

  const ageToX = (age: number): number => {
    // Find which bucket this age falls into
    const bucketIdx = bucketEdges.findIndex((edge, i) => i > 0 && age < edge) - 1;
    const idx = bucketIdx >= 0 ? bucketIdx : bins.length - 1;
    // Position at center of the bucket
    return padL + ((idx + 0.5) / binCount) * plotW;
  };

  if (stats.q1 <= maxBucketEdge) {
    const x1 = ageToX(stats.q1);
    markers.push(`<line x1="${fmt(x1)}" y1="${padT}" x2="${fmt(x1)}" y2="${padT + plotH}" stroke="var(--band-moderate)" stroke-width="1.5" stroke-dasharray="4 2"><title>Q1: ${stats.q1.toFixed(1)}d</title></line>`);
  }

  if (stats.median <= maxBucketEdge) {
    const xM = ageToX(stats.median);
    markers.push(`<line x1="${fmt(xM)}" y1="${padT}" x2="${fmt(xM)}" y2="${padT + plotH}" stroke="var(--band-hard)" stroke-width="2"><title>Median: ${stats.median.toFixed(1)}d</title></line>`);
  }

  if (stats.q3 <= maxBucketEdge) {
    const x3 = ageToX(stats.q3);
    markers.push(`<line x1="${fmt(x3)}" y1="${padT}" x2="${fmt(x3)}" y2="${padT + plotH}" stroke="var(--band-moderate)" stroke-width="1.5" stroke-dasharray="4 2"><title>Q3: ${stats.q3.toFixed(1)}d</title></line>`);
  }
  
  // Axes
  const axes = `
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--border)" stroke-width="1"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="var(--border)" stroke-width="1"/>
    <text x="${padL + plotW / 2}" y="${H - 2}" class="svg-tick" text-anchor="middle">Age (days)</text>
    <text x="${20}" y="${padT + plotH / 2}" class="svg-tick" text-anchor="middle" transform="rotate(-90 20 ${padT + plotH / 2})">Count</text>
  `;
  
  const legend = `
    <g transform="translate(${padL}, ${padT - 8})">
      <line x1="0" y1="0" x2="16" y2="0" stroke="var(--band-hard)" stroke-width="2"/>
      <text x="20" y="0" class="svg-tick" dominant-baseline="central">Median</text>
      <line x1="80" y1="0" x2="96" y2="0" stroke="var(--band-moderate)" stroke-width="1.5" stroke-dasharray="4 2"/>
      <text x="100" y="0" class="svg-tick" dominant-baseline="central">Q1/Q3</text>
    </g>
  `;
  
  return svg(W, H, axes + barsAndLabels + markers.join("") + yTicks + legend, title);
}

/**
 * Difficulty × review-age scatter plot.
 * Since review-age points don't carry continuous difficulty scores, we map
 * bands to representative values. X-axis: band (mapped to 0.15/0.45/0.75),
 * Y-axis: review age in days, colored by band.
 */
export function renderDifficultyAgeScatter(points: ReviewAgePoint[]): string {
  const agedPoints = points.filter(
    (point): point is ReviewAgePoint & { band: DifficultyBand } => point.band !== undefined,
  );

  if (agedPoints.length === 0) {
    return `<section><h2>Difficulty × review age</h2><p class="empty">No review assignments with difficulty and lifecycle-age data.</p></section>`;
  }
  
  const W = 640;
  const H = 360;
  const padL = 60;
  const padR = 30;
  const padT = 30;
  const padB = 50;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  
  // Map bands to representative difficulty values for X-axis positioning
  const bandToDiff: Record<DifficultyBand, number> = {
    simple: 0.15,
    moderate: 0.45,
    hard: 0.75,
  };
  
  const minAge = Math.min(...agedPoints.map((point) => point.ageDays));
  const maxAge = Math.max(...agedPoints.map((point) => point.ageDays));
  
  const ageRange = maxAge - minAge || 1;
  
  // Draw points with jitter to prevent exact overlap
  const circles = agedPoints.map((pr) => {
    const baseDiff = bandToDiff[pr.band];
    // Add small random jitter within band range (±0.08)
    const jitter = (Math.random() - 0.5) * 0.16;
    const diffValue = Math.max(0, Math.min(1, baseDiff + jitter));
    
    const x = padL + diffValue * plotW;
    const y = padT + plotH - ((pr.ageDays - minAge) / ageRange) * plotH;
    const color = `var(--band-${pr.band})`;
    
    return `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="4" fill="${color}" fill-opacity="0.7" stroke="#fff" stroke-width="0.5"><title>${escapeHtml(pr.repo)}#${pr.pr}
Band: ${BAND_LABEL[pr.band]}
Review age: ${fmtDays(pr.ageDays)}d (${pr.status === "merged" ? "merged" : "open at report time"})</title></circle>`;
  }).join("");
  
  // X-axis ticks (bands)
  const xTicks = [
    { val: 0.15, label: 'Simple' },
    { val: 0.45, label: 'Moderate' },
    { val: 0.75, label: 'Hard' },
  ].map(({ val, label }) => {
    const x = padL + val * plotW;
    return `<text x="${fmt(x)}" y="${H - 20}" class="svg-tick" text-anchor="middle">${label}</text>`;
  }).join("");
  
  // Y-axis ticks (age)
  const yStep = Math.ceil(maxAge / 5);
  const yTicks = Array.from({ length: 6 }, (_, i) => {
    const val = minAge + i * yStep;
    if (val > maxAge) return "";
    const y = padT + plotH - ((val - minAge) / ageRange) * plotH;
    return `<text x="${padL - 8}" y="${fmt(y)}" class="svg-tick" text-anchor="end" dominant-baseline="central">${val}d</text>`;
  }).join("");
  
  // Axes
  const axes = `
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--border)" stroke-width="1"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="var(--border)" stroke-width="1"/>
    <text x="${padL + plotW / 2}" y="${H - 5}" class="svg-tick" text-anchor="middle">Difficulty band</text>
    <text x="${25}" y="${padT + plotH / 2}" class="svg-tick" text-anchor="middle" transform="rotate(-90 25 ${padT + plotH / 2})">Review age (days)</text>
  `;
  
  // Legend
  const legendY = padT + 10;
  const legend = `
    <g transform="translate(${W - padR - 140}, ${legendY})">
      <circle cx="6" cy="0" r="4" fill="var(--band-simple)" fill-opacity="0.7" stroke="#fff" stroke-width="0.5"/>
      <text x="14" y="0" class="svg-tick" dominant-baseline="central">${BAND_LABEL.simple}</text>
      <circle cx="6" cy="18" r="4" fill="var(--band-moderate)" fill-opacity="0.7" stroke="#fff" stroke-width="0.5"/>
      <text x="14" y="18" class="svg-tick" dominant-baseline="central">${BAND_LABEL.moderate}</text>
      <circle cx="6" cy="36" r="4" fill="var(--band-hard)" fill-opacity="0.7" stroke="#fff" stroke-width="0.5"/>
      <text x="14" y="36" class="svg-tick" dominant-baseline="central">${BAND_LABEL.hard}</text>
    </g>
  `;
  
  return `<section>
      <h2>Difficulty × review age</h2>
      <p class="section-hint">Do harder PRs spend longer in review? Each point is a PR from the lifecycle report. Position shows difficulty band (X, with jitter to prevent overlap) and review age (Y).</p>
      ${svg(W, H, axes + circles + xTicks + yTicks + legend, "Difficulty vs review age scatter plot")}
    </section>`;
}

/** Days as a compact tick/tooltip label: 5, 1.5, … */
function fmtDays(d: number): string {
  const rounded = Math.round(d * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Per-reviewer time-to-merge distribution as horizontal box plots.
 * Each reviewer gets a box showing: min, Q1, median, Q3, max, outliers.
 * Value is days from when the reviewer was requested until the PR merged.
 */
export function renderMergeTimeDistribution(
  responses: ReviewResponse[],
  dir: Record<string, { name?: string; email?: string }>,
  windowDays = 90
): string {
  const byReviewer = new Map<string, number[]>();
  for (const r of responses) {
    if (r.mergeHours === undefined) continue;
    const list = byReviewer.get(r.reviewer) ?? [];
    list.push(r.mergeHours / 24);
    byReviewer.set(r.reviewer, list);
  }

  if (byReviewer.size === 0) {
    return `<section><h2>Time to merge</h2><p class="empty">No merged PRs with a known review-request time in the last ${windowDays} days.</p></section>`;
  }

  // Sort reviewers by median time-to-merge (slowest first)
  const reviewers = [...byReviewer.entries()]
    .map(([login, ages]) => ({ login, ages }))
    .sort((a, b) => quartiles(b.ages).median - quartiles(a.ages).median);
  
  const W = 640;
  const rowH = 32;
  const labelW = 140;
  const padR = 30;
  const padT = 20;
  const padB = 30;
  const plotW = W - labelW - padR;
  const H = reviewers.length * rowH + padT + padB;
  
  // Find global max for consistent scale (avoid divide-by-zero if all waits are 0).
  const rawMax = Math.max(...reviewers.flatMap(r => r.ages));
  const globalMax = rawMax > 0 ? rawMax : 1;
  
  const boxes = reviewers.map((r, i) => {
    const stats = quartiles(r.ages);
    const y = padT + i * rowH;
    const boxY = y + 6;
    const boxH = 20;
    const centerY = boxY + boxH / 2;
    
    // Scale to plot width
    const x = (val: number) => labelW + (val / globalMax) * plotW;
    
    const minVal = Math.min(...r.ages);
    const maxVal = Math.max(...r.ages);
    
    // Outliers (beyond fences)
    const outlierPoints = r.ages
      .filter(a => a < stats.lowerFence || a > stats.upperFence)
      .map(a => {
        const cx = x(a);
        return `<circle cx="${fmt(cx)}" cy="${centerY}" r="2.5" fill="var(--band-hard)" fill-opacity="0.8"><title>${escapeHtml(displayName(r.login, dir))}: ${fmtDays(a)}d (outlier)</title></circle>`;
      })
      .join("");
    
    // Whiskers: from min (or lower fence) to max (or upper fence)
    const whiskerMin = Math.max(minVal, stats.lowerFence);
    const whiskerMax = Math.min(maxVal, stats.upperFence);
    const whisker = `<line x1="${fmt(x(whiskerMin))}" y1="${centerY}" x2="${fmt(x(whiskerMax))}" y2="${centerY}" stroke="var(--muted)" stroke-width="1.5"/>`;
    
    // Box: Q1 to Q3
    const boxX = x(stats.q1);
    const boxW = x(stats.q3) - boxX;
    const box = `<rect x="${fmt(boxX)}" y="${boxY}" width="${fmt(boxW)}" height="${boxH}" fill="var(--accent)" fill-opacity="0.3" stroke="var(--accent)" stroke-width="1.5" rx="2"><title>${escapeHtml(displayName(r.login, dir))}
Q1: ${stats.q1.toFixed(1)}d, Median: ${stats.median.toFixed(1)}d, Q3: ${stats.q3.toFixed(1)}d
${r.ages.length} merged</title></rect>`;
    
    // Median line
    const medX = x(stats.median);
    const medLine = `<line x1="${fmt(medX)}" y1="${boxY}" x2="${fmt(medX)}" y2="${boxY + boxH}" stroke="var(--band-hard)" stroke-width="2"/>`;
    
    // Label
    const label = `<text x="${labelW - 10}" y="${centerY}" class="svg-label" text-anchor="end" dominant-baseline="central">${escapeHtml(displayName(r.login, dir))} <tspan class="svg-count">(${r.ages.length})</tspan><title>${escapeHtml(personTitle(r.login, dir))}</title></text>`;
    
    return label + whisker + box + medLine + outlierPoints;
  }).join("");
  
  // X-axis ticks
  const tickVals = [0, globalMax / 4, globalMax / 2, (3 * globalMax) / 4, globalMax];
  const xTicks = tickVals.map(val => {
    const tickX = labelW + (val / globalMax) * plotW;
    return `<text x="${fmt(tickX)}" y="${H - 10}" class="svg-tick" text-anchor="middle">${fmtDays(val)}d</text>`;
  }).join("");
  
  // Axis line
  const axis = `<line x1="${labelW}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--border)" stroke-width="1"/>`;
  
  const chart = svg(W, H, boxes + axis + xTicks, "Time-to-merge distribution per reviewer");

  return `<section>
      <h2>Time to merge</h2>
      <p class="section-hint">Distribution of days from GitHub requesting the review until the PR merged, per reviewer. Box shows quartiles (median = thick line), whiskers extend to 1.5×IQR, outliers shown as dots. Sorted by slowest median. <strong>Only covers PRs merged in the last ${windowDays} days</strong> — history deepens as Siara keeps running.</p>
      ${chart}
    </section>`;
}

/**
 * Author × reviewer heatmap: median time-to-merge (days) per author/reviewer pair.
 * Darker = slower. Cell label shows median; tooltip includes PR count.
 */
export function renderAuthorReviewerMergeMatrix(
  responses: ReviewResponse[],
  dir: Record<string, { name?: string; email?: string }>,
  openPrs: OpenPrSnapshot[] = [],
  windowDays = 90,
): string {
  const authorByPr = new Map<string, string>();
  for (const pr of openPrs) {
    authorByPr.set(`${pr.repo}#${pr.pr}`, pr.author);
  }

  const cellData = new Map<string, number[]>();
  for (const r of responses) {
    if (r.mergeHours === undefined) continue;
    const author = r.author ?? authorByPr.get(`${r.repo}#${r.pr}`);
    if (!author) continue;
    const key = `${author}\0${r.reviewer}`;
    const list = cellData.get(key) ?? [];
    list.push(r.mergeHours / 24);
    cellData.set(key, list);
  }

  if (cellData.size === 0) {
    return `<section><h2>Author × reviewer time to merge</h2><p class="empty">No merged PRs with author and review-request data in the last ${windowDays} days.</p></section>`;
  }

  const authors = [...new Set([...cellData.keys()].map((k) => k.split("\0")[0]!))].sort(
    (a, b) => {
      const ca = [...cellData.keys()].filter((k) => k.startsWith(`${a}\0`)).length;
      const cb = [...cellData.keys()].filter((k) => k.startsWith(`${b}\0`)).length;
      return cb - ca || a.localeCompare(b);
    },
  );
  const reviewers = [...new Set([...cellData.keys()].map((k) => k.split("\0")[1]!))].sort(
    (a, b) => {
      const ca = [...cellData.keys()].filter((k) => k.endsWith(`\0${a}`)).length;
      const cb = [...cellData.keys()].filter((k) => k.endsWith(`\0${b}`)).length;
      return cb - ca || a.localeCompare(b);
    },
  );

  const medians = [...cellData.values()].map((days) => quartiles(days).median);
  const maxMedian = Math.max(...medians, 1);

  const labelW = 140;
  const cell = 44;
  const cgap = 8;
  const colW = cell + cgap;
  const labelH = 96;
  const W = labelW + reviewers.length * colW;
  const H = authors.length * colW + labelH;

  const rows = authors
    .map((author, rI) => {
      const y = rI * colW;
      const label = `<text x="${labelW - 10}" y="${y + cell / 2}" class="svg-label" text-anchor="end" dominant-baseline="central">${escapeHtml(displayName(author, dir))}<title>${escapeHtml(personTitle(author, dir))}</title></text>`;
      const cells = reviewers
        .map((reviewer, cI) => {
          const days = cellData.get(`${author}\0${reviewer}`);
          const x = labelW + cI * colW;
          if (!days || days.length === 0) {
            return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="4" fill="var(--border)" fill-opacity="0.35"><title>${escapeHtml(displayName(author, dir))} → ${escapeHtml(displayName(reviewer, dir))}: no data</title></rect>`;
          }
          const med = quartiles(days).median;
          const intensity = med / maxMedian;
          const op = 0.18 + 0.82 * intensity;
          const label =
            cell >= 36
              ? `<text x="${x + cell / 2}" y="${y + cell / 2}" class="heat-num" fill="${intensity > 0.55 ? "#fff" : "var(--text)"}" text-anchor="middle" dominant-baseline="central">${fmtDays(med)}d</text>`
              : "";
          return (
            `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="4" fill="var(--accent)" fill-opacity="${fmt(op)}"><title>${escapeHtml(displayName(author, dir))} → ${escapeHtml(displayName(reviewer, dir))}
Median: ${fmtDays(med)}d (${days.length} PR${days.length === 1 ? "" : "s"})</title></rect>` +
            label
          );
        })
        .join("");
      return label + cells;
    })
    .join("");

  const ticks = reviewers
    .map((reviewer, cI) => {
      const x = labelW + cI * colW + cell / 2;
      const y = authors.length * colW + 14;
      return `<text x="${fmt(x)}" y="${y}" class="svg-tick" text-anchor="end" transform="rotate(-40 ${fmt(x)} ${y})">${escapeHtml(displayName(reviewer, dir))}</text>`;
    })
    .join("");

  const chart = svg(W, H, rows + ticks, "Author by reviewer median time to merge");

  return `<section>
      <h2>Author × reviewer time to merge</h2>
      <p class="section-hint">Median days from review request to merge for each author→reviewer pair. Darker = slower. Only PRs merged in the last ${windowDays} days with a known author and GitHub review-request time.</p>
      <div class="scroll-x">${chart}</div>
    </section>`;
}

/** Display label for a reviewer: real name if known, else the login. */
function displayName(login: string, dir: Record<string, { name?: string; email?: string }>): string {
  return dir[login]?.name?.trim() || login;
}

/** Tooltip text for a reviewer: login (nick) plus email when known. */
function personTitle(login: string, dir: Record<string, { name?: string; email?: string }>): string {
  const email = dir[login]?.email?.trim();
  return email ? `${login} · ${email}` : login;
}

/** Additional CSS for new charts. */
export const CHART_STYLES = `
    .chart-title {
      margin: 0.5rem 0 0.75rem;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text);
    }
`;
