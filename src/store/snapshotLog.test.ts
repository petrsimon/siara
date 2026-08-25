import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenPrsSnapshot } from "../types.js";
import {
  readOpenPrsSnapshot,
  snapshotPathFor,
  writeOpenPrsSnapshot,
} from "./snapshotLog.js";

let counter = 0;
const paths: string[] = [];
function nextPath(): string {
  counter += 1;
  const p = join(tmpdir(), `siara-snap-${counter}.json`);
  paths.push(p);
  return p;
}

afterEach(() => {
  for (const p of paths) {
    if (existsSync(p)) unlinkSync(p);
  }
  paths.length = 0;
});

const SNAPSHOT: OpenPrsSnapshot = {
  takenAt: "2026-08-25T10:00:00.000Z",
  prs: [
    {
      repo: "org/repo",
      pr: 7,
      title: "Add thing",
      author: "alice",
      assignees: ["bob"],
      ageDays: 3,
      band: "hard",
      staleness: "warning",
      postedAt: "2026-08-22T10:00:00.000Z",
    },
  ],
};

describe("snapshotLog", () => {
  it("writes and reads back a snapshot round-trip", () => {
    const p = nextPath();
    writeOpenPrsSnapshot(p, SNAPSHOT);
    expect(readOpenPrsSnapshot(p)).toEqual(SNAPSHOT);
  });

  it("overwrites the previous snapshot (point-in-time, not appended)", () => {
    const p = nextPath();
    writeOpenPrsSnapshot(p, SNAPSHOT);
    const next: OpenPrsSnapshot = { takenAt: "2026-08-26T10:00:00.000Z", prs: [] };
    writeOpenPrsSnapshot(p, next);
    expect(readOpenPrsSnapshot(p)).toEqual(next);
  });

  it("returns undefined for a missing file", () => {
    expect(readOpenPrsSnapshot(nextPath())).toBeUndefined();
  });

  it("derives a sibling .open-prs.json path from the assignments log", () => {
    expect(snapshotPathFor("data/assignments.jsonl")).toBe("data/assignments.open-prs.json");
    expect(snapshotPathFor("data/log")).toBe("data/log.open-prs.json");
  });
});
