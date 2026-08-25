import { describe, expect, it } from "vitest";
import { seededDice } from "../util/dice.js";
import {
  candidate,
  file,
  hardFiles,
  moderateFiles,
  pickInput,
  pullRequest,
  simpleFiles,
  testConfig,
} from "./fixtures.js";
import { pickReviewers } from "./pickReviewers.js";

const NOW = "2026-01-15T12:00:00.000Z";

/** Alice (few commits) vs Bob (many commits) on a shared path. */
function noviceAndExpert(path: string) {
  return [
    candidate("alice", { commitsByPath: { [path]: 2 } }),
    candidate("bob", { commitsByPath: { [path]: 10 } }),
  ];
}

describe("pickReviewers", () => {
  describe("eligible filter", () => {
    it("excludes author, requested reviewers, blocklisted logins, and non-roster members", () => {
      const config = testConfig({
        roster: ["alice", "bob", "blocked"],
        blocklist: ["blocked"],
      });
      const result = pickReviewers({
        pr: pullRequest({
          author: "author",
          requestedReviewers: ["bob"],
          files: simpleFiles(),
        }),
        config,
        candidates: [
          candidate("author"),
          candidate("bob"),
          candidate("blocked"),
          candidate("alice"),
          candidate("outsider"),
        ],
        nowIso: NOW,
      });

      expect(result.ranked.map((c) => c.login)).toEqual(["alice"]);
      expect(result.assignees).toEqual(["alice"]);
    });
  });

  describe("band routing", () => {
    const path = "src/ui/button.tsx";

    it("on a simple diff ranks lowest-familiarity candidate first (education)", () => {
      const result = pickReviewers(
        pickInput({
          pr: { files: simpleFiles() },
          candidates: noviceAndExpert(path),
        }),
      );

      expect(result.difficulty.band).toBe("simple");
      expect(result.ranked[0]?.login).toBe("alice");
    });

    it("on a hard diff ranks highest-knowledge candidate first (expertise)", () => {
      const result = pickReviewers(
        pickInput({
          pr: { files: hardFiles() },
          candidates: noviceAndExpert("src/a/mod0.ts"),
        }),
      );

      expect(result.difficulty.band).toBe("hard");
      expect(result.ranked[0]?.login).toBe("bob");
    });

    it("on a moderate diff uses the familiarity/knowledge blend", () => {
      const result = pickReviewers(
        pickInput({
          pr: { files: moderateFiles() },
          candidates: noviceAndExpert("src/a/one.ts"),
        }),
      );

      expect(result.difficulty.band).toBe("moderate");
      expect(result.ranked[0]?.login).toBe("bob");
    });

    it("does not route a small auth diff through the education path", () => {
      const authPath = "src/auth/login.ts";
      const result = pickReviewers(
        pickInput({
          pr: { files: [file(authPath, 3, 1)] },
          candidates: noviceAndExpert(authPath),
        }),
      );

      // Size says simple; path-risk floors to moderate so knowledge counts and
      // the novice isn't handed a dangerous change alone.
      expect(result.difficulty.pathRisk.bandFloored).toBe(true);
      expect(result.difficulty.band).toBe("moderate");
      expect(result.ranked[0]?.login).toBe("bob");
    });
  });

  describe("tie-breaks", () => {
    it("prefers lower openReviewLoad when final scores are equal", () => {
      const result = pickReviewers(
        pickInput({
          pr: { files: simpleFiles() },
          candidates: [
            candidate("alice", { openReviewLoad: 3 }),
            candidate("bob", { openReviewLoad: 0 }),
          ],
        }),
      );

      expect(result.ranked[0]?.login).toBe("bob");
      expect(result.ranked[1]?.login).toBe("alice");
    });

    it("breaks equal score and load ties with seeded dice deterministically", () => {
      const input = pickInput({
        pr: { number: 42, files: simpleFiles() },
        config: { diceSeedSalt: "tie-salt" },
        candidates: [
          candidate("alice", { openReviewLoad: 0 }),
          candidate("bob", { openReviewLoad: 0 }),
        ],
      });

      const first = pickReviewers(input);
      const second = pickReviewers(input);
      expect(first.ranked.map((c) => c.login)).toEqual(
        second.ranked.map((c) => c.login),
      );

      const diceOrder = ["alice", "bob"].sort(
        (a, b) =>
          seededDice(42, a, "tie-salt") - seededDice(42, b, "tie-salt"),
      );
      expect(first.ranked.map((c) => c.login)).toEqual(diceOrder);
    });

    it("can change tie order when diceSeedSalt changes", () => {
      const base = pickInput({
        pr: { number: 42, files: simpleFiles() },
        candidates: [
          candidate("alice", { openReviewLoad: 0 }),
          candidate("bob", { openReviewLoad: 0 }),
        ],
      });

      const orderForSalt = (salt: string) => {
        const result = pickReviewers({
          ...base,
          config: testConfig({ diceSeedSalt: salt }),
        });
        return result.ranked.map((c) => c.login);
      };

      const orderA = orderForSalt("salt-0");
      const orderB = orderForSalt("salt-50");
      const diceOrderA =
        seededDice(42, "alice", "salt-0") < seededDice(42, "bob", "salt-0")
          ? ["alice", "bob"]
          : ["bob", "alice"];
      const diceOrderB =
        seededDice(42, "alice", "salt-50") < seededDice(42, "bob", "salt-50")
          ? ["alice", "bob"]
          : ["bob", "alice"];

      expect(orderA).toEqual(diceOrderA);
      expect(orderB).toEqual(diceOrderB);
      expect(diceOrderA).not.toEqual(diceOrderB);
    });
  });

  describe("reviewersPerPr", () => {
    it("returns exactly N assignees when the pool is large enough", () => {
      const result = pickReviewers(
        pickInput({
          config: { reviewersPerPr: 2 },
          pr: { files: simpleFiles() },
        }),
      );

      expect(result.assignees).toHaveLength(2);
      expect(result.assignees).toEqual(
        result.ranked.slice(0, 2).map((c) => c.login),
      );
    });

    it("returns fewer assignees when the eligible pool is smaller", () => {
      const result = pickReviewers(
        pickInput({
          config: { reviewersPerPr: 3 },
          candidates: [candidate("alice"), candidate("bob")],
          pr: { files: simpleFiles() },
        }),
      );

      expect(result.assignees).toHaveLength(2);
    });
  });

  describe("files-at-risk pairing", () => {
    it("pairs the highest-knowledge expert with a spread-boosted non-owner", () => {
      const riskyPath = "src/risky.ts";
      const result = pickReviewers(
        pickInput({
          config: {
            roster: ["owner", "learner-a", "learner-b"],
            reviewersPerPr: 2,
            filesAtRisk: { spreadBoost: 0.15, pairWithExpert: true },
          },
          pr: { files: [file(riskyPath)] },
          candidates: [
            candidate("owner", {
              commitsByPath: { [riskyPath]: 5 },
            }),
            candidate("learner-a"),
            candidate("learner-b"),
          ],
        }),
      );

      expect(result.atRiskCount).toBe(1);
      expect(result.assignees).toHaveLength(2);
      expect(result.assignees).toContain("owner");
      expect(result.assignees.some((login) => login !== "owner")).toBe(true);
      const spreadBoosted = result.assignees.find((login) => login !== "owner");
      expect(result.ranked.find((c) => c.login === spreadBoosted)?.boosts.filesAtRisk).toBeGreaterThan(0);
    });
  });

  describe("empty eligible pool", () => {
    it("returns no assignees when nobody is eligible", () => {
      const result = pickReviewers(
        pickInput({
          pr: pullRequest({
            author: "alice",
            requestedReviewers: ["bob"],
            files: simpleFiles(),
          }),
          candidates: [candidate("alice"), candidate("bob")],
        }),
      );

      expect(result.ranked).toEqual([]);
      expect(result.assignees).toEqual([]);
    });
  });
});
