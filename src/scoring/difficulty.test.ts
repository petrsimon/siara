import { describe, expect, it } from "vitest";
import { scoreDifficulty } from "./difficulty.js";
import { file, testConfig } from "./fixtures.js";

describe("scoreDifficulty", () => {
  const config = testConfig();

  it("returns simple band for small churn, few files, one directory", () => {
    const result = scoreDifficulty(
      [
        file("src/auth/login.ts", 5, 3),
        file("src/auth/session.ts", 4, 2),
      ],
      config,
    );

    expect(result.band).toBe("simple");
    expect(result.score).toBeLessThan(config.difficulty.bands.simple);
    expect(result.raw.filesChanged).toBe(2);
    expect(result.raw.directoriesTouched).toBe(1);
    expect(result.raw.totalChurn).toBe(9);
  });

  it("returns hard band for 10+ files, multi-dir spread, and 300+ churn", () => {
    const files = [
      ...Array.from({ length: 4 }, (_, i) =>
        file(`src/a/mod${i}.ts`, 40, 10),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        file(`src/b/mod${i}.ts`, 40, 10),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        file(`lib/c/mod${i}.ts`, 40, 10),
      ),
    ];

    const result = scoreDifficulty(files, config);

    expect(result.raw.filesChanged).toBeGreaterThanOrEqual(10);
    expect(result.raw.totalChurn).toBeGreaterThanOrEqual(300);
    expect(result.raw.directoriesTouched).toBeGreaterThanOrEqual(3);
    expect(result.band).toBe("hard");
    expect(result.score).toBeGreaterThanOrEqual(config.difficulty.bands.hard);
  });

  it("returns moderate band for mid-sized diffs", () => {
    const result = scoreDifficulty(
      [
        file("src/a/one.ts", 30, 10),
        file("src/b/two.ts", 25, 15),
        file("src/c/three.ts", 20, 10),
        file("lib/d/four.ts", 15, 5),
      ],
      config,
    );

    expect(result.band).toBe("moderate");
    expect(result.score).toBeGreaterThanOrEqual(config.difficulty.bands.simple);
    expect(result.score).toBeLessThan(config.difficulty.bands.hard);
  });

  it("keeps normalized components in 0–1", () => {
    const result = scoreDifficulty(
      [
        file("src/a/one.ts", 500, 500),
        file("src/b/two.ts", 500, 500),
      ],
      config,
    );

    expect(result.components.normChurn).toBeGreaterThanOrEqual(0);
    expect(result.components.normChurn).toBeLessThanOrEqual(1);
    expect(result.components.normFiles).toBeGreaterThanOrEqual(0);
    expect(result.components.normFiles).toBeLessThanOrEqual(1);
    expect(result.components.normSpread).toBeGreaterThanOrEqual(0);
    expect(result.components.normSpread).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("caps per-file churn before summing", () => {
    const result = scoreDifficulty(
      [file("src/huge.ts", 10_000, 10_000)],
      config,
    );

    expect(result.raw.totalChurn).toBe(config.difficultyCeilings.perFileChurnCap);
  });

  it("handles empty file list as simple zero score", () => {
    const result = scoreDifficulty([], config);

    expect(result.score).toBe(0);
    expect(result.band).toBe("simple");
    expect(result.raw).toEqual({
      totalChurn: 0,
      filesChanged: 0,
      directoriesTouched: 0,
    });
  });
});
