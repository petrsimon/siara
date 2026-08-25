/** Subtract whole calendar days from an ISO timestamp (UTC). */
export function subtractDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

/** Whole days elapsed from earlierIso to laterIso (floor). */
export function daysBetween(earlierIso: string, laterIso: string): number {
  const earlier = new Date(earlierIso).getTime();
  const later = new Date(laterIso).getTime();
  return Math.floor((later - earlier) / (24 * 60 * 60 * 1000));
}

/** Whole hours elapsed from earlierIso to laterIso (floor, clamped at 0). */
export function hoursBetween(earlierIso: string, laterIso: string): number {
  const earlier = new Date(earlierIso).getTime();
  const later = new Date(laterIso).getTime();
  return Math.max(0, Math.floor((later - earlier) / (60 * 60 * 1000)));
}
