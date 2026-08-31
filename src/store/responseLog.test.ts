import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResponseTimeReport } from "../types.js";
import {
  readResponseReport,
  responsePathFor,
  writeResponseReport,
} from "./responseLog.js";

let counter = 0;
const paths: string[] = [];
function nextPath(): string {
  counter += 1;
  const p = join(tmpdir(), `siara-resp-${counter}.json`);
  paths.push(p);
  return p;
}

afterEach(() => {
  for (const p of paths) {
    if (existsSync(p)) unlinkSync(p);
  }
  paths.length = 0;
});

const REPORT: ResponseTimeReport = {
  takenAt: "2026-08-25T10:00:00.000Z",
  responses: [
    {
      repo: "org/repo",
      pr: 7,
      reviewer: "bob",
      assignedAt: "2026-08-20T00:00:00.000Z",
      firstReviewAt: "2026-08-22T09:00:00.000Z",
      latencyHours: 57,
      outstanding: false,
    },
    {
      repo: "org/repo",
      pr: 8,
      reviewer: "carol",
      assignedAt: "2026-08-20T00:00:00.000Z",
      outstanding: true,
      waitingHours: 120,
    },
  ],
  readyToAssignment: [
    {
      repo: "org/repo",
      pr: 9,
      readyAt: "2026-08-20T00:00:00.000Z",
      assignedAt: "2026-08-21T12:00:00.000Z",
      reviewer: "dave",
      latencyHours: 36,
      outstanding: false,
    },
  ],
};

describe("responseLog", () => {
  it("writes and reads back a report round-trip", () => {
    const p = nextPath();
    writeResponseReport(p, REPORT);
    expect(readResponseReport(p)).toEqual(REPORT);
  });

  it("overwrites the previous report (point-in-time, not appended)", () => {
    const p = nextPath();
    writeResponseReport(p, REPORT);
    const next: ResponseTimeReport = { takenAt: "2026-08-26T10:00:00.000Z", responses: [] };
    writeResponseReport(p, next);
    expect(readResponseReport(p)).toEqual(next);
  });

  it("returns undefined for a missing file", () => {
    expect(readResponseReport(nextPath())).toBeUndefined();
  });

  it("derives a sibling .response-times.json path from the assignments log", () => {
    expect(responsePathFor("data/assignments.jsonl")).toBe(
      "data/assignments.response-times.json",
    );
    expect(responsePathFor("data/log")).toBe("data/log.response-times.json");
  });
});
