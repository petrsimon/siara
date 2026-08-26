/**
 * Advanced chart generators for age distribution and difficulty×age scatter.
 * Rendered as inline SVG in the dashboard.
 */

import type { DifficultyBand, OpenPrSnapshot } from "../types.js";
import { escapeHtml } from "./html.js";

const BAND_LABEL: Record<DifficultyBand, string> = {
  simple: "Simple",
  moderate: "Moderate",
  hard: "Hard",
};

/** Wrap chart body in a responsive, accessible SVG. */
function svg(w: number, h: number, body: string, title: string): string {
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMinYMin meet">${body}</svg>`;
}

/** Trim float noise from SVG coordinates. */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
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
export function renderAgeDistribution(openPrs: OpenPrSnapshot[]): string {
  const ages = openPrs
    .filter(pr => pr.ageDays !== undefined)
    .map(pr => pr.ageDays!);
  
  if (ages.length === 0) {
    return `<section><h2>PR age distribution</h2><p class="empty">No open PRs with known age.</p></section>`;
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
    ? `<p class="section-hint">${outliers.length} outliers detected (outside 1.5×IQR). Outliers: ${outliers.sort((a, b) => b - a).map(a => `${a}d`).join(", ")}</p>`
    : `<p class="section-hint">No outliers detected.</p>`;
  
  return `<section>
      <h2>PR age distribution</h2>
      <p class="section-hint">How long open PRs have been waiting, bucketed by industry-standard time ranges (same-day, 1-3d, 1-2w, etc.). Quartiles and IQR-based outlier detection (1.5×IQR rule).</p>
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
  
  // Fixed time buckets aligned with industry SLAs and business expectations
  const bucketEdges = [0, 1, 3, 7, 14, 30, 60, 90, Infinity];
  const bucketLabels = ["0-1d", "1-3d", "3-7d", "1-2w", "2-4w", "1-2mo", "2-3mo", "3mo+"];

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
 * Difficulty × age scatter plot.
 * Since OpenPrSnapshot doesn't have difficulty scores, we map bands to representative values.
 * X-axis: band (mapped to 0.15/0.45/0.75), Y-axis: age in days, colored by band.
 */
export function renderDifficultyAgeScatter(openPrs: OpenPrSnapshot[]): string {
  const points = openPrs.filter(pr => 
    pr.ageDays !== undefined && 
    pr.band !== undefined
  );
  
  if (points.length === 0) {
    return `<section><h2>Difficulty × age</h2><p class="empty">No open PRs with difficulty and age data.</p></section>`;
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
  
  const minAge = Math.min(...points.map(p => p.ageDays!));
  const maxAge = Math.max(...points.map(p => p.ageDays!));
  
  const ageRange = maxAge - minAge || 1;
  
  // Draw points with jitter to prevent exact overlap
  const circles = points.map(pr => {
    const baseDiff = bandToDiff[pr.band!];
    // Add small random jitter within band range (±0.08)
    const jitter = (Math.random() - 0.5) * 0.16;
    const diffValue = Math.max(0, Math.min(1, baseDiff + jitter));
    
    const x = padL + diffValue * plotW;
    const y = padT + plotH - ((pr.ageDays! - minAge) / ageRange) * plotH;
    const color = `var(--band-${pr.band})`;
    
    return `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="4" fill="${color}" fill-opacity="0.7" stroke="#fff" stroke-width="0.5"><title>${escapeHtml(pr.repo)}#${pr.pr}
Band: ${BAND_LABEL[pr.band!]}
Age: ${pr.ageDays}d</title></circle>`;
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
    <text x="${25}" y="${padT + plotH / 2}" class="svg-tick" text-anchor="middle" transform="rotate(-90 25 ${padT + plotH / 2})">Age (days)</text>
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
      <h2>Difficulty × age</h2>
      <p class="section-hint">Do harder PRs sit longer? Each point is an open PR. Position shows difficulty band (X, with jitter to prevent overlap) and age (Y).</p>
      ${svg(W, H, axes + circles + xTicks + yTicks + legend, "Difficulty vs age scatter plot")}
    </section>`;
}

/**
 * Per-reviewer waiting time distribution as horizontal box plots.
 * Each reviewer gets a box showing: min, Q1, median, Q3, max, outliers.
 */
export function renderWaitingDistribution(
  openPrs: OpenPrSnapshot[],
  dir: Record<string, { name?: string; email?: string }>
): string {
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

  // Sort reviewers by max age (longest wait first)
  const reviewers = [...byReviewer.entries()]
    .map(([login, ages]) => ({ login, ages }))
    .sort((a, b) => Math.max(...b.ages) - Math.max(...a.ages));
  
  const W = 640;
  const rowH = 32;
  const labelW = 140;
  const padR = 30;
  const padT = 20;
  const padB = 30;
  const plotW = W - labelW - padR;
  const H = reviewers.length * rowH + padT + padB;
  
  // Find global max for consistent scale
  const globalMax = Math.max(...reviewers.flatMap(r => r.ages));
  
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
        return `<circle cx="${fmt(cx)}" cy="${centerY}" r="2.5" fill="var(--band-hard)" fill-opacity="0.8"><title>${escapeHtml(displayName(r.login, dir))}: ${a}d (outlier)</title></circle>`;
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
${r.ages.length} open PRs</title></rect>`;
    
    // Median line
    const medX = x(stats.median);
    const medLine = `<line x1="${fmt(medX)}" y1="${boxY}" x2="${fmt(medX)}" y2="${boxY + boxH}" stroke="var(--band-hard)" stroke-width="2"/>`;
    
    // Label
    const label = `<text x="${labelW - 10}" y="${centerY}" class="svg-label" text-anchor="end" dominant-baseline="central">${escapeHtml(displayName(r.login, dir))} <tspan class="svg-count">(${r.ages.length})</tspan><title>${escapeHtml(personTitle(r.login, dir))}</title></text>`;
    
    return label + whisker + box + medLine + outlierPoints;
  }).join("");
  
  // X-axis ticks
  const tickVals = [0, Math.round(globalMax / 4), Math.round(globalMax / 2), Math.round(3 * globalMax / 4), globalMax];
  const xTicks = tickVals.map(val => {
    const tickX = labelW + (val / globalMax) * plotW;
    return `<text x="${fmt(tickX)}" y="${H - 10}" class="svg-tick" text-anchor="middle">${val}d</text>`;
  }).join("");
  
  // Axis line
  const axis = `<line x1="${labelW}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--border)" stroke-width="1"/>`;
  
  const chart = svg(W, H, boxes + axis + xTicks, "Waiting time distribution per reviewer");
  
  return `<section>
      <h2>Waiting on reviewers</h2>
      <p class="section-hint">Distribution of PR ages (days since PR created) for each reviewer's current assignments. Box shows quartiles (median = thick line), whiskers extend to 1.5×IQR, outliers shown as dots. Sorted by longest wait.</p>
      ${chart}
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
