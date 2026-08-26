import { describe, expect, it } from "vitest";
import type { ResponseTimeReport } from "../types.js";
import { enrichResponseAuthors } from "./enrichAuthors.js";

describe("enrichResponseAuthors", () => {
  it("fills authors from the open-PR snapshot without GitHub", async () => {
    const report: ResponseTimeReport = {
      takenAt: "2026-08-25T10:00:00.000Z",
      responses: [
        {
          repo: "org/repo",
          pr: 9,
          reviewer: "bob",
          assignedAt: "2026-08-01T00:00:00.000Z",
          outstanding: false,
          mergedAt: "2026-08-06T00:00:00.000Z",
          mergeHours: 120,
        },
      ],
    };
    const enriched = await enrichResponseAuthors(
      report,
      [],
      90,
      {
        takenAt: "2026-08-25T09:00:00.000Z",
        prs: [
          {
            repo: "org/repo",
            pr: 9,
            title: "x",
            author: "alice",
            assignees: ["bob"],
            staleness: "normal",
          },
        ],
      },
    );
    expect(enriched?.responses[0]?.author).toBe("alice");
  });
});
