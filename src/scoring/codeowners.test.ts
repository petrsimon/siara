import { describe, expect, it } from "vitest";
import {
  matchCodeownersPattern,
  ownersForPaths,
  parseCodeowners,
} from "./codeowners.js";

describe("parseCodeowners", () => {
  it("strips comments and blank lines", () => {
    const text = `
# top-level comment
*.ts @alice

  # inline is not supported mid-line in our parser — treated as part of pattern if unspaced

/docs/ @bob
`;
    const rules = parseCodeowners(text);
    expect(rules).toEqual([
      { pattern: "*.ts", owners: ["@alice"] },
      { pattern: "/docs/", owners: ["@bob"] },
    ]);
  });

  it("parses multiple owners on one line", () => {
    const rules = parseCodeowners("src/ @alice @org/team @bob");
    expect(rules).toEqual([
      { pattern: "src/", owners: ["@alice", "@org/team", "@bob"] },
    ]);
  });

  it("ignores lines with no owners", () => {
    expect(parseCodeowners("README.md\n*.go @dev")).toEqual([
      { pattern: "*.go", owners: ["@dev"] },
    ]);
  });

  it("preserves team-vs-user tokens verbatim", () => {
    const rules = parseCodeowners("* @user @my-org/platform");
    expect(rules[0]?.owners).toEqual(["@user", "@my-org/platform"]);
  });
});

describe("matchCodeownersPattern", () => {
  it("matches * catch-all", () => {
    expect(matchCodeownersPattern("any/path/file.ts", "*")).toBe(true);
  });

  it("matches extension globs on basename", () => {
    expect(matchCodeownersPattern("src/main.ts", "*.ts")).toBe(true);
    expect(matchCodeownersPattern("src/main.js", "*.ts")).toBe(false);
  });

  it("matches directory prefixes with trailing slash", () => {
    expect(matchCodeownersPattern("docs/guide.md", "/docs/")).toBe(true);
    expect(matchCodeownersPattern("src/docs/x", "/docs/")).toBe(false);
    expect(matchCodeownersPattern("docs", "/docs/")).toBe(false);
  });

  it("matches path/to/file and dir/** patterns", () => {
    expect(matchCodeownersPattern("src/auth/login.ts", "src/auth/**")).toBe(true);
    expect(matchCodeownersPattern("src/auth/login.ts", "src/ui/**")).toBe(false);
    expect(matchCodeownersPattern("src/auth/login.ts", "src/auth/login.ts")).toBe(true);
  });
});

describe("ownersForPaths", () => {
  it("uses last-match-wins per file", () => {
    const rules = parseCodeowners(`
*.md @docs-team
/src/core/ @core @org/platform
* @fallback
`);
    const owners = ownersForPaths(rules, ["README.md"]);
    // *.md matches, then * also matches — last wins → @fallback
    expect(owners).toEqual(["@fallback"]);
  });

  it("unions owners across multiple files", () => {
    const rules = parseCodeowners(`
/src/core/ @core @org/platform
*.md @docs-team
`);
    const owners = ownersForPaths(rules, ["src/core/a.ts", "notes.md"]);
    expect(owners).toContain("@core");
    expect(owners).toContain("@org/platform");
    expect(owners).toContain("@docs-team");
  });

  it("returns empty when nothing matches", () => {
    const narrow = parseCodeowners("/only/ @solo");
    expect(ownersForPaths(narrow, ["other.ts"])).toEqual([]);
  });
});
