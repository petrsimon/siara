/**
 * Gini coefficient of load inequality across **active reviewers only**
 * (logins that appear in reviewsPerPerson). A roster-relative Gini would need
 * the full team roster, which the assignment log does not carry.
 *
 * Sorted ascending form (x_1 ≤ … ≤ x_n, i = 1..n):
 *   G = (2 * Σ_i(i * x_i)) / (n * Σ x) - (n + 1) / n
 *
 * Edge cases: n === 0 or Σ x === 0 → 0; all-equal → 0; clamp to [0, 1].
 */
export function computeGini(loads: number[]): number {
  const n = loads.length;
  if (n === 0) {
    return 0;
  }

  const total = loads.reduce((sum, load) => sum + load, 0);
  if (total === 0) {
    return 0;
  }

  const sorted = [...loads].sort((a, b) => a - b);
  let weightedSum = 0;
  for (let i = 0; i < n; i++) {
    weightedSum += (i + 1) * (sorted[i] ?? 0);
  }

  const gini = (2 * weightedSum) / (n * total) - (n + 1) / n;
  return Math.min(1, Math.max(0, gini));
}
