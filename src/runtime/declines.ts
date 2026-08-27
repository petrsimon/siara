/**
 * Detect reviewer declines from GitHub review-request timeline events.
 * Pure — no I/O.
 */
import type { ReviewRequestEvent } from "../adapters/index.js";
import type { PullRequest } from "../types.js";

export interface DetectedDecline {
  pr: number;
  login: string;
  at: string;
}

/** Latest event kind for each PR+login pair. */
function latestEventKind(
  events: ReviewRequestEvent[],
): Map<string, ReviewRequestEvent> {
  const byKey = new Map<string, ReviewRequestEvent>();
  for (const ev of events) {
    const key = `${ev.pr}\0${ev.login}`;
    const prev = byKey.get(key);
    // Later event wins; on an exact-timestamp tie prefer "requested" so a
    // simultaneous re-request is never misread as a decline (false positives
    // are worse than a one-run delay in detecting a real decline).
    if (
      prev === undefined ||
      ev.at > prev.at ||
      (ev.at === prev.at && ev.kind === "requested")
    ) {
      byKey.set(key, ev);
    }
  }
  return byKey;
}

/**
 * A login on an open PR is a decline when Siara suggested them, they were
 * removed (latest event is `removed`), and they are not currently requested.
 */
export function detectDeclines(
  openPrs: PullRequest[],
  events: ReviewRequestEvent[],
  suggestedByPr: Map<number, string[]>,
): DetectedDecline[] {
  const latest = latestEventKind(events);
  const openByNumber = new Map(openPrs.map((pr) => [pr.number, pr]));
  const out: DetectedDecline[] = [];

  for (const ev of latest.values()) {
    if (ev.kind !== "removed") {
      continue;
    }
    const pr = openByNumber.get(ev.pr);
    if (pr === undefined) {
      continue;
    }
    const suggested = suggestedByPr.get(ev.pr);
    if (suggested === undefined || !suggested.includes(ev.login)) {
      continue;
    }
    if (pr.requestedReviewers.includes(ev.login)) {
      continue;
    }
    out.push({ pr: ev.pr, login: ev.login, at: ev.at });
  }

  return out;
}
