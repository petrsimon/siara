import { describe, expect, it } from "vitest";
import { parseGitLog, resolveLogin } from "./localGit.js";

const IDENTITY = {
  "khala@redhat.com": "karelhala",
  "justinorringer@gmail.com": "justinorringer",
  "Brandon Tweed": "catastrophe-brandon",
};

/** Build a git-log record with the NUL layout parseGitLog expects. */
function record(email: string, name: string, files: string[]): string {
  return `\0\0${email}\0${name}\n${files.map((f) => `${f}\n`).join("")}\n`;
}

describe("resolveLogin", () => {
  it("maps a known email to its login", () => {
    expect(resolveLogin("khala@redhat.com", "Karel Hala", IDENTITY)).toBe("karelhala");
  });

  it("decodes a GitHub noreply email without a map entry", () => {
    expect(
      resolveLogin("138883744+OlhaTmlk@users.noreply.github.com", "Olha", {}),
    ).toBe("OlhaTmlk");
  });

  it("decodes the legacy noreply form (no numeric prefix)", () => {
    expect(resolveLogin("octocat@users.noreply.github.com", "Octo", {})).toBe("octocat");
  });

  it("falls back to the name when the email is unmapped", () => {
    expect(resolveLogin("noreply@example.com", "Brandon Tweed", IDENTITY)).toBe(
      "catastrophe-brandon",
    );
  });

  it("returns undefined for an unmapped author", () => {
    expect(resolveLogin("stranger@example.com", "Stranger", IDENTITY)).toBeUndefined();
  });
});

describe("parseGitLog", () => {
  it("tallies path counts per login, restricted to wanted paths", () => {
    const stdout =
      record("khala@redhat.com", "Karel Hala", ["src/a.ts", "src/b.ts", "docs/x.md"]) +
      record("khala@redhat.com", "Karel Hala", ["src/a.ts"]) +
      record("justinorringer@gmail.com", "justinorringer", ["src/b.ts"]);
    const wanted = new Set(["src/a.ts", "src/b.ts"]);

    const result = parseGitLog(stdout, wanted, IDENTITY);

    expect(result).toEqual({
      karelhala: { "src/a.ts": 2, "src/b.ts": 1 },
      justinorringer: { "src/b.ts": 1 },
    });
  });

  it("skips commits from unmapped authors", () => {
    const stdout = record("stranger@example.com", "Stranger", ["src/a.ts"]);
    expect(parseGitLog(stdout, new Set(["src/a.ts"]), IDENTITY)).toEqual({});
  });

  it("ignores paths outside the wanted set", () => {
    const stdout = record("khala@redhat.com", "Karel Hala", ["vendor/lib.js"]);
    expect(parseGitLog(stdout, new Set(["src/a.ts"]), IDENTITY)).toEqual({});
  });

  it("returns an empty object for empty output", () => {
    expect(parseGitLog("", new Set(["src/a.ts"]), IDENTITY)).toEqual({});
  });

  it("does not pollute the prototype on a __proto__ path", () => {
    const stdout = record("khala@redhat.com", "Karel Hala", ["__proto__"]);
    const result = parseGitLog(stdout, new Set(["__proto__"]), IDENTITY);
    // Recorded as an own property on a null-proto map, not via the setter.
    const paths = result["karelhala"] as Record<string, number>;
    expect(paths["__proto__"]).toBe(1);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});
