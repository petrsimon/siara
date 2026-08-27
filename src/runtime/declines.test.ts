import { describe, expect, it } from "vitest";
import type { ReviewRequestEvent } from "../adapters/index.js";
import { pullRequest } from "../scoring/fixtures.js";
import { detectDeclines } from "./declines.js";

describe("detectDeclines", () => {
  it("records a removed reviewer who was in the prior suggestion", () => {
    const pr = pullRequest({ number: 1, requestedReviewers: [] });
    const events: ReviewRequestEvent[] = [
      { pr: 1, login: "bob", at: "2026-01-01T00:00:00.000Z", kind: "requested" },
      { pr: 1, login: "bob", at: "2026-01-02T00:00:00.000Z", kind: "removed" },
    ];
    const suggested = new Map([[1, ["bob"]]]);

    expect(detectDeclines([pr], events, suggested)).toEqual([
      { pr: 1, login: "bob", at: "2026-01-02T00:00:00.000Z" },
    ]);
  });

  it("does not record when the newest event is requested again", () => {
    const pr = pullRequest({ number: 1, requestedReviewers: ["bob"] });
    const events: ReviewRequestEvent[] = [
      { pr: 1, login: "bob", at: "2026-01-01T00:00:00.000Z", kind: "requested" },
      { pr: 1, login: "bob", at: "2026-01-02T00:00:00.000Z", kind: "removed" },
      { pr: 1, login: "bob", at: "2026-01-03T00:00:00.000Z", kind: "requested" },
    ];
    const suggested = new Map([[1, ["bob"]]]);

    expect(detectDeclines([pr], events, suggested)).toEqual([]);
  });

  it("ignores removals for logins Siara never suggested", () => {
    const pr = pullRequest({ number: 1, requestedReviewers: [] });
    const events: ReviewRequestEvent[] = [
      { pr: 1, login: "bob", at: "2026-01-02T00:00:00.000Z", kind: "removed" },
    ];

    expect(detectDeclines([pr], events, new Map())).toEqual([]);
  });
});
