/**
 * Point-in-time open-PRs snapshot — pure `node:fs`, NO native deps.
 *
 * Unlike the append-only assignment/override logs, this is OVERWRITTEN each
 * `daily` run: it captures the *current* set of open PRs with their age and
 * staleness. Git-tracked so the published dashboard can render a PR-age overview
 * and per-reviewer waiting stats without touching config or the SQLite store.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OpenPrsSnapshot } from "../types.js";

/** Overwrite the open-PRs snapshot (creates the parent dir if needed). */
export function writeOpenPrsSnapshot(path: string, snapshot: OpenPrsSnapshot): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Read the latest open-PRs snapshot, or undefined if none / unreadable. */
export function readOpenPrsSnapshot(path: string): OpenPrsSnapshot | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as OpenPrsSnapshot;
  } catch {
    console.warn(`readOpenPrsSnapshot: skipping malformed snapshot in ${path}`);
    return undefined;
  }
}

/**
 * Default snapshot path derived from the assignments-log path — a sibling with
 * an `.open-prs.json` suffix (so `data/assignments.jsonl` →
 * `data/assignments.open-prs.json`, and each test's unique log gets its own,
 * mirroring `overridesPathFor`).
 */
export function snapshotPathFor(assignmentsPath: string): string {
  return assignmentsPath.endsWith(".jsonl")
    ? `${assignmentsPath.slice(0, -".jsonl".length)}.open-prs.json`
    : `${assignmentsPath}.open-prs.json`;
}
