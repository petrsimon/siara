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
      <p class="section-hint">How long open PRs have been waiting. Quartiles and IQR-based outlier detection (1.5×IQR rule).</p>
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
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  
  const minAge = Math.min(...data);
  const maxAge = Math.max(...data);
  const range = maxAge - minAge;
  const binCount = Math.min(15, Math.max(5, Math.ceil(Math.sqrt(data.length))));
  const binWidth = range / binCount;
  
  // Build histogram bins
  const bins: { min: number; max: number; count: number }[] = [];
  for (let i = 0; i < binCount; i++) {
    const min = minAge + i * binWidth;
    const max = min + binWidth;
    bins.push({ min, max, count: 0 });
  }
  
  for (const age of data) {
    const idx = Math.min(binCount - 1, Math.floor((age - minAge) / binWidth));
    bins[idx]!.count++;
  }
  
  const maxCount = Math.max(...bins.map(b => b.count));
  
  // Draw bars
  const bars = bins.map((bin, i) => {
    const x = padL + (i / binCount) * plotW;
    const barW = plotW / binCount - 2;
    const barH = (bin.count / maxCount) * plotH;
    const y = padT + plotH - barH;
    
    return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(barW)}" height="${fmt(barH)}" fill="var(--accent)" fill-opacity="0.7" rx="2"><title>${bin.min.toFixed(1)}–${bin.max.toFixed(1)}d: ${bin.count} PRs</title></rect>`;
  }).join("");
  
  // X-axis ticks
  const xTicks = [minAge, maxAge].map(val => {
    const x = padL + ((val - minAge) / range) * plotW;
    return `<text x="${fmt(x)}" y="${H - 12}" class="svg-tick" text-anchor="middle">${val.toFixed(0)}d</text>`;
  }).join("");
  
  // Y-axis ticks (count)
  const yTicks = [0, Math.floor(maxCount / 2), maxCount].map(count => {
    const y = padT + plotH - (count / maxCount) * plotH;
    return `<text x="${padL - 8}" y="${fmt(y)}" class="svg-tick" text-anchor="end" dominant-baseline="central">${count}</text>`;
  }).join("");
  
  // Quartile markers
  const markers = [];
  
  // Only show quartile lines if they're within the data range
  if (stats.q1 >= minAge && stats.q1 <= maxAge) {
    const x1 = padL + ((stats.q1 - minAge) / range) * plotW;
    markers.push(`<line x1="${fmt(x1)}" y1="${padT}" x2="${fmt(x1)}" y2="${padT + plotH}" stroke="var(--band-moderate)" stroke-width="1.5" stroke-dasharray="4 2"><title>Q1: ${stats.q1.toFixed(1)}d</title></line>`);
  }
  
  if (stats.median >= minAge && stats.median <= maxAge) {
    const xM = padL + ((stats.median - minAge) / range) * plotW;
    markers.push(`<line x1="${fmt(xM)}" y1="${padT}" x2="${fmt(xM)}" y2="${padT + plotH}" stroke="var(--band-hard)" stroke-width="2"><title>Median: ${stats.median.toFixed(1)}d</title></line>`);
  }
  
  if (stats.q3 >= minAge && stats.q3 <= maxAge) {
    const x3 = padL + ((stats.q3 - minAge) / range) * plotW;
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
  
  return svg(W, H, axes + bars + markers.join("") + xTicks + yTicks + legend, title);
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

/** Additional CSS for new charts. */
export const CHART_STYLES = `
    .chart-title {
      margin: 0.5rem 0 0.75rem;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text);
    }
`;
