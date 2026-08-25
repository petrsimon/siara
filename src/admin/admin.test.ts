import { describe, expect, it } from "vitest";
import {
  parseReviewersPayload,
  renderAdminPage,
  updateReviewersInConfig,
} from "./index.js";

const ROSTER = ["alice", "bob", "carol"];

describe("parseReviewersPayload", () => {
  it("keeps only meaningful, well-typed properties", () => {
    const out = parseReviewersPayload(
      {
        alice: { busy: 3, unavailable: true, until: "2026-09-01", note: " on PTO " },
        bob: { busy: 0, unavailable: false, note: "" }, // all empty → dropped
      },
      ROSTER,
    );
    expect(out).toEqual({
      alice: { busy: 3, unavailable: true, until: "2026-09-01", note: "on PTO" },
    });
  });

  it("rejects an off-roster login", () => {
    expect(() => parseReviewersPayload({ mallory: { busy: 1 } }, ROSTER)).toThrow(
      /not on the roster/,
    );
  });

  it("ignores a malformed until date", () => {
    const out = parseReviewersPayload({ alice: { unavailable: true, until: "soon" } }, ROSTER);
    expect(out.alice).toEqual({ unavailable: true });
  });

  it("throws on a non-object payload", () => {
    expect(() => parseReviewersPayload("nope", ROSTER)).toThrow();
  });
});

describe("updateReviewersInConfig", () => {
  it("sets team.reviewers while preserving the rest of the config", () => {
    const raw = JSON.stringify({
      team: { roster: ["alice"], managers: ["alice"] },
      repos: [{ repo: "org/repo" }],
    });
    const next = updateReviewersInConfig(raw, { alice: { unavailable: true } });
    const parsed = JSON.parse(next);
    expect(parsed.team.reviewers).toEqual({ alice: { unavailable: true } });
    expect(parsed.team.roster).toEqual(["alice"]);
    expect(parsed.team.managers).toEqual(["alice"]);
    expect(parsed.repos).toEqual([{ repo: "org/repo" }]);
  });

  it("throws when the config has no team block", () => {
    expect(() => updateReviewersInConfig(JSON.stringify({}), {})).toThrow(/no team/);
  });
});

describe("renderAdminPage", () => {
  it("renders a row per roster member with current values", () => {
    const html = renderAdminPage(ROSTER, { alice: { busy: 4, unavailable: true, note: "back Mon" } });
    expect(html).toContain('data-login="alice"');
    expect(html).toContain('data-login="bob"');
    expect(html).toContain('value="4"');
    expect(html).toContain("checked");
    expect(html).toContain("back Mon");
  });

  it("escapes note/login content", () => {
    const html = renderAdminPage(["alice"], { alice: { note: "<script>x</script>" } });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
