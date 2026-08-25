/**
 * Append-only JSONL assignment log — pure `node:fs`, NO native deps.
 *
 * Kept free of better-sqlite3 so read-only consumers (the dashboard) can use it
 * without loading the SQLite native addon.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Assignment } from "../types.js";

/** Append one assignment record as a JSON line (creates the parent dir if needed). */
export function appendAssignmentFile(path: string, a: Assignment): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  appendFileSync(path, `${JSON.stringify(a)}\n`);
}

/** Read all assignment records; skip (and warn on) any corrupt/partial line. */
export function readAssignmentsFile(path: string): Assignment[] {
  if (!existsSync(path)) {
    return [];
  }
  const content = readFileSync(path, "utf-8");
  const out: Assignment[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as Assignment);
    } catch {
      // Skip a corrupt/partial line (e.g. from a crashed append) rather than
      // failing the whole dashboard/log read.
      console.warn(`readAssignments: skipping malformed line in ${path}`);
    }
  }
  return out;
}
