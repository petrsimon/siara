import { describe, expect, it } from "vitest";
import { formatRationale, toAssignment } from "./rationale.js";
import {
  candidate,
  file,
  hardFiles,
  pickInput,
  simpleFiles,
  testConfig,
} from "./scoring/fixtures.js";
import { pickReviewers } from "./scoring/pickReviewers.js";

const DATE = "2026-01-15";
const REPO = "org/repo";

function rationaleFor(partial: Parameters<typeof pickInput>[0] = {}) {
  const input = pickInput(partial);
  const result = pickReviewers(input);
  return {
    input,
    result,
    rationaleInput: {
      repo: REPO,
      prNumber: input.pr.number,
      date: DATE,
      result,
    },
  };
}

describe("formatRationale", () => {
  it("includes assignees, difficulty band+score, files count, and one line per candidate", () => {
    const { result, rationaleInput } = rationaleFor({
      pr: { files: simpleFiles() },
    });

    const text = formatRationale(rationaleInput);

    expect(text).toContain(`Assigned @${result.assignees[0]}`);
    expect(text).toContain(`PR #${rationaleInput.prNumber} (${REPO})`);
    expect(text).toContain(`Difficulty: ${result.difficulty.band}`);
    expect(text).toContain(`score ${result.difficulty.score.toFixed(2)}`);
    expect(text).toContain(`${result.difficulty.raw.filesChanged} files`);
    expect(text).toContain("Ranked candidates:");
    for (const c of result.ranked) {
      expect(text).toContain(`@${c.login}:`);
    }
  });

  it("includes the simple-band advisory note only for simple diffs", () => {
    const simple = formatRationale(rationaleFor({ pr: { files: simpleFiles() } }).rationaleInput);
    const hard = formatRationale(rationaleFor({ pr: { files: hardFiles() } }).rationaleInput);

    expect(simple).toContain("advisory: 'simple' is by diff size only");
    expect(hard).not.toContain("advisory: 'simple' is by diff size only");
  });

  it("includes the files-at-risk line only when atRiskCount > 0", () => {
    const withRisk = formatRationale(
      rationaleFor({
        config: { roster: ["owner", "learner"] },
        pr: { files: [file("src/risky.ts")] },
        candidates: [
          candidate("owner", { commitsByPath: { "src/risky.ts": 2 } }),
          candidate("learner"),
        ],
      }).rationaleInput,
    );
    const withoutRisk = formatRationale(
      rationaleFor({ pr: { files: simpleFiles() } }).rationaleInput,
    );

    expect(withRisk).toContain("Files-at-risk: 1 bus-factor-1 file(s)");
    expect(withoutRisk).not.toContain("Files-at-risk:");
  });
});

describe("toAssignment", () => {
  it("produces a well-formed Assignment record", () => {
    const { result, rationaleInput } = rationaleFor({
      config: testConfig({ reviewersPerPr: 2 }),
      pr: { number: 42, files: simpleFiles() },
    });

    const assignment = toAssignment(rationaleInput);

    expect(assignment.date).toBe(DATE);
    expect(assignment.pr).toBe(42);
    expect(assignment.repo).toBe(REPO);
    expect(assignment.assignees).toEqual(result.assignees);
    expect(assignment.difficulty).toBe(result.difficulty.score);
    expect(assignment.band).toBe(result.difficulty.band);
    expect(assignment.rationale.length).toBeGreaterThan(0);
    expect(assignment.candidates).toEqual(
      result.ranked.map(
        (c) => `${c.login}:${(result.finalScoreByLogin[c.login] ?? 0).toFixed(2)}`,
      ),
    );
    expect(assignment.candidates[0]).toMatch(/^[^:]+:\d+\.\d{2}$/);
  });
});
