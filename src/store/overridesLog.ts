/**
 * Append-only JSONL override log — pure `node:fs`, NO native deps.
 *
 * Mirrors assignmentsLog: kept free of better-sqlite3 so the dashboard can read
 * it without loading the SQLite native addon. Records manual reviewer changes
 * observed after auto-assignment (see Override in types).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Override } from "../types.js";

/** Append one override record as a JSON line (creates the parent dir if needed). */
export function appendOverrideFile(path: string, o: Override): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  appendFileSync(path, `${JSON.stringify(o)}\n`);
}

/** Read all override records; skip (and warn on) any corrupt/partial line. */
export function readOverridesFile(path: string): Override[] {
  if (!existsSync(path)) {
    return [];
  }
  const content = readFileSync(path, "utf-8");
  const out: Override[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as Override);
    } catch {
      console.warn(`readOverrides: skipping malformed line in ${path}`);
    }
  }
  return out;
}

/**
 * Default override-log path derived from the assignments-log path — a sibling
 * with an `.overrides.jsonl` suffix (so `data/assignments.jsonl` →
 * `data/assignments.overrides.jsonl`, and each test's unique log gets its own).
 */
export function overridesPathFor(assignmentsPath: string): string {
  return assignmentsPath.endsWith(".jsonl")
    ? `${assignmentsPath.slice(0, -".jsonl".length)}.overrides.jsonl`
    : `${assignmentsPath}.overrides.jsonl`;
}
