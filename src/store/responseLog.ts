/**
 * Review-latency report — pure `node:fs`, NO native deps.
 *
 * Like the open-PRs snapshot, this is OVERWRITTEN each `daily` run: it captures
 * the current review-response picture (how long each assigned reviewer took to
 * first review, and which assignments are still outstanding). Git-tracked so the
 * published, store-free dashboard can render responsiveness without loading the
 * SQLite addon.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ResponseTimeReport } from "../types.js";

/** Overwrite the response-time report (creates the parent dir if needed). */
export function writeResponseReport(path: string, report: ResponseTimeReport): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

/** Read the latest response-time report, or undefined if none / unreadable. */
export function readResponseReport(path: string): ResponseTimeReport | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ResponseTimeReport;
  } catch {
    console.warn(`readResponseReport: skipping malformed report in ${path}`);
    return undefined;
  }
}

/**
 * Default report path derived from the assignments-log path — a sibling with a
 * `.response-times.json` suffix (so `data/assignments.jsonl` →
 * `data/assignments.response-times.json`, and each test's unique log gets its
 * own, mirroring `snapshotPathFor`).
 */
export function responsePathFor(assignmentsPath: string): string {
  return assignmentsPath.endsWith(".jsonl")
    ? `${assignmentsPath.slice(0, -".jsonl".length)}.response-times.json`
    : `${assignmentsPath}.response-times.json`;
}
