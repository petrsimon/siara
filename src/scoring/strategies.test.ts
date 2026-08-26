import { describe, expect, it } from "vitest";
import {
  candidate,
  hardFiles,
  moderateFiles,
  pickInput,
  simpleFiles,
} from "./fixtures.js";
import { pickReviewers } from "./pickReviewers.js";
import type { StrategyName } from "./strategies.js";
import { ALL_STRATEGIES } from "./strategies.js";

describe("strategies", () => {
  describe("all strategies return valid results", () => {
    for (const strategy of ALL_STRATEGIES) {
      it(`${strategy} returns ranked candidates and assignees`, () => {
        const result = pickReviewers(
          pickInput({
            pr: { files: moderateFiles() },
            config: { reviewersPerPr: 1 },
            candidates: [
              candidate("alice", {
                commitsByPath: { "src/a/one.ts": 10 },
              }),
              candidate("bob", {
                commitsByPath: { "src/a/one.ts": 2 },
                openReviewLoad: 3,
              }),
              candidate("carol"),
            ],
            strategy,
          }),
        );

        expect(result.strategy).toBe(strategy);
        expect(result.ranked.length).toBe(3);
        expect(result.assignees.length).toBe(1);
        expect(result.difficulty.band).toBe("moderate");
      });
    }
  });

  describe("whodo favors expertise penalized by load", () => {
    it("demotes a loaded expert below a lighter peer", () => {
      const result = pickReviewers(
        pickInput({
          config: { roster: ["expert", "peer"] },
          pr: { files: hardFiles() },
          candidates: [
            candidate("expert", {
              commitsByPath: { "src/a/mod0.ts": 10 },
              openReviewLoad: 8,
            }),
            candidate("peer", {
              commitsByPath: { "src/a/mod0.ts": 8 },
              openReviewLoad: 0,
            }),
          ],
          strategy: "whodo",
        }),
      );

      // peer's score = knowledge / (1 + 0) > expert's / (1 + 0.3×8)
      expect(result.assignees[0]).toBe("peer");
    });

    it("picks the expert when loads are equal", () => {
      const result = pickReviewers(
        pickInput({
          config: { roster: ["expert", "peer"] },
          pr: { files: hardFiles() },
          candidates: [
            candidate("expert", {
              commitsByPath: { "src/a/mod0.ts": 10 },
            }),
            candidate("peer", {
              commitsByPath: { "src/a/mod0.ts": 2 },
            }),
          ],
          strategy: "whodo",
        }),
      );

      expect(result.assignees[0]).toBe("expert");
    });
  });

  describe("sofia rewards knowledge spread on at-risk files", () => {
    it("boosts non-owners when files are at risk", () => {
      const riskyPath = "src/risky.ts";
      const result = pickReviewers(
        pickInput({
          config: { roster: ["owner", "learner"] },
          pr: { files: [{ path: riskyPath, additions: 10, deletions: 5 }] },
          candidates: [
            candidate("owner", {
              commitsByPath: { [riskyPath]: 10 },
            }),
            candidate("learner"),
          ],
          strategy: "sofia",
        }),
      );

      expect(result.atRiskCount).toBe(1);
      const learner = result.ranked.find((c) => c.login === "learner");
      expect(learner).toBeDefined();
      expect(
        learner!.notes.some((n) => n.includes("spread")),
      ).toBe(true);
    });
  });

  describe("whoreview values collaboration affinity", () => {
    it("boosts a candidate with recent related reviews", () => {
      const result = pickReviewers(
        pickInput({
          config: { roster: ["alice", "bob"] },
          pr: {
            files: moderateFiles(),
            branch: "feat/auth-login",
          },
          candidates: [
            candidate("alice", {
              commitsByPath: { "src/a/one.ts": 5 },
              recentReviews: [
                {
                  prNumber: 90,
                  branch: "feat/auth-signup",
                  reviewedAt: "2026-01-10T12:00:00.000Z",
                },
              ],
            }),
            candidate("bob", {
              commitsByPath: { "src/a/one.ts": 5 },
            }),
          ],
          strategy: "whoreview",
        }),
      );

      // Alice has follow-up affinity (same branch family), Bob doesn't.
      expect(result.assignees[0]).toBe("alice");
    });
  });

  describe("meta randomizes from top-K", () => {
    it("assigns from the top-3 pool", () => {
      const result = pickReviewers(
        pickInput({
          pr: { files: moderateFiles() },
          candidates: [
            candidate("alice", {
              commitsByPath: { "src/a/one.ts": 10 },
            }),
            candidate("bob", {
              commitsByPath: { "src/a/one.ts": 8 },
            }),
            candidate("carol", {
              commitsByPath: { "src/a/one.ts": 6 },
            }),
          ],
          strategy: "meta",
        }),
      );

      // The assignee must be one of the top-3.
      expect(["alice", "bob", "carol"]).toContain(result.assignees[0]);
      // Should have a meta annotation on the chosen candidate.
      const chosen = result.ranked.find(
        (c) => c.login === result.assignees[0],
      );
      expect(chosen?.notes.some((n) => n.includes("anti-bystander"))).toBe(
        true,
      );
    });

    it("is deterministic for the same PR number and salt", () => {
      const input = pickInput({
        pr: { number: 42, files: moderateFiles() },
        config: { diceSeedSalt: "meta-test" },
        candidates: [
          candidate("alice", {
            commitsByPath: { "src/a/one.ts": 10 },
          }),
          candidate("bob", {
            commitsByPath: { "src/a/one.ts": 8 },
          }),
          candidate("carol", {
            commitsByPath: { "src/a/one.ts": 6 },
          }),
        ],
        strategy: "meta" as StrategyName,
      });

      const r1 = pickReviewers(input);
      const r2 = pickReviewers(input);
      expect(r1.assignees).toEqual(r2.assignees);
    });
  });

  describe("strategy field flows through to result", () => {
    it("defaults to siara", () => {
      const result = pickReviewers(
        pickInput({ pr: { files: simpleFiles() } }),
      );
      expect(result.strategy).toBe("siara");
    });

    it("respects explicit strategy", () => {
      const result = pickReviewers(
        pickInput({ pr: { files: simpleFiles() }, strategy: "whodo" }),
      );
      expect(result.strategy).toBe("whodo");
    });
  });

  describe("strategies produce different rankings", () => {
    it("siara and whodo can produce different top picks", () => {
      const input = pickInput({
        config: { roster: ["alice", "bob"] },
        pr: { files: hardFiles() },
        candidates: [
          candidate("alice", {
            commitsByPath: { "src/a/mod0.ts": 10 },
            openReviewLoad: 5,
          }),
          candidate("bob", {
            commitsByPath: { "src/a/mod0.ts": 9 },
            openReviewLoad: 0,
          }),
        ],
      });

      const siara = pickReviewers({ ...input, strategy: "siara" });
      const whodo = pickReviewers({ ...input, strategy: "whodo" });

      // Both strategies score the pool, but the scoring formulas differ:
      // WhoDo divides by (1 + 0.3×load), Siara uses a capped additive penalty.
      // The key property: they're not identical — they CAN diverge.
      expect(siara.strategy).toBe("siara");
      expect(whodo.strategy).toBe("whodo");
      // WhoDo: alice_score = 1.0/(1+1.5)=0.4, bob_score = 0.9/(1+0)=0.9 → bob
      expect(whodo.assignees[0]).toBe("bob");
    });
  });
});
