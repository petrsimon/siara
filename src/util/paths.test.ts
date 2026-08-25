import { describe, expect, it } from "vitest";
import { branchFamily, dirOf, distinctDirs, matchGlob, sameBranchFamily } from "./paths.js";

describe("dirOf / distinctDirs", () => {
  it("returns the directory of a path", () => {
    expect(dirOf("src/auth/login.ts")).toBe("src/auth");
    expect(dirOf("README.md")).toBe(".");
  });

  it("dedupes directories", () => {
    expect(distinctDirs(["src/a/x.ts", "src/a/y.ts", "src/b/z.ts"])).toEqual([
      "src/a",
      "src/b",
    ]);
  });
});

describe("branchFamily", () => {
  it("groups sibling feature branches", () => {
    expect(sameBranchFamily("feat/auth-login", "feat/auth-session")).toBe(true);
    expect(sameBranchFamily("feat/auth-login", "fix/bug-123")).toBe(false);
  });

  it("falls back to whole branch when no group", () => {
    expect(branchFamily("main")).toBe("main");
  });
});

describe("matchGlob", () => {
  it("matches `**` across path segments", () => {
    expect(matchGlob("src/auth/login.ts", "**/auth/**")).toBe(true);
    expect(matchGlob("auth/login.ts", "**/auth/**")).toBe(true); // leading **/ optional
    expect(matchGlob("src/ui/button.tsx", "**/auth/**")).toBe(false);
  });

  it("`*` stays within a single segment", () => {
    expect(matchGlob("main.ts", "*.ts")).toBe(true);
    expect(matchGlob("src/main.ts", "*.ts")).toBe(false);
    expect(matchGlob("src/main.ts", "**/*.ts")).toBe(true);
  });

  it("matches substring-style rules", () => {
    expect(matchGlob("src/services/authClient.ts", "**/*auth*")).toBe(true);
    expect(matchGlob("config/prod.env", "**/*.env*")).toBe(true);
    expect(matchGlob("db/migrations/001.sql", "**/*.sql")).toBe(true);
  });

  it("escapes regex metacharacters in the literal parts", () => {
    expect(matchGlob("a.b.c", "a.b.c")).toBe(true);
    expect(matchGlob("axbxc", "a.b.c")).toBe(false); // '.' is literal, not any-char
  });
});
