import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM_CONFIG } from "./config.js";
import { loadConfig, SAMPLE_CONFIG } from "./config-loader.js";

let fixtureCounter = 0;

function nextConfigPath(label: string): string {
  fixtureCounter += 1;
  return join(tmpdir(), `siara-config-${label}-${fixtureCounter}.json`);
}

const createdPaths: string[] = [];

function writeConfig(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  createdPaths.push(path);
}

afterEach(() => {
  for (const path of createdPaths) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
  createdPaths.length = 0;
});

describe("loadConfig", () => {
  it("merges team defaults with partial overrides", () => {
    const path = nextConfigPath("merge");
    writeConfig(path, {
      team: {
        roster: ["alice", "bob"],
        reviewersPerPr: 2,
        syncWindowDays: 30,
      },
      repos: [{ repo: "org/a" }, { repo: "org/b", blocklist: ["bot"] }],
    });

    const loaded = loadConfig(path);

    expect(loaded.teamConfig.roster).toEqual(["alice", "bob"]);
    expect(loaded.teamConfig.reviewersPerPr).toBe(2);
    expect(loaded.teamConfig.syncWindowDays).toBe(30);
    expect(loaded.teamConfig.difficulty).toEqual(DEFAULT_TEAM_CONFIG.difficulty);
    expect(loaded.repoConfigs).toHaveLength(2);
    expect(loaded.repos).toEqual(["org/a", "org/b"]);
  });

  it("derives repos from repoConfigs", () => {
    const path = nextConfigPath("repos");
    writeConfig(path, SAMPLE_CONFIG);

    const loaded = loadConfig(path);
    expect(loaded.repos).toEqual(["my-org/my-repo"]);
    expect(loaded.repoConfigs[0]?.blocklist).toEqual(["dependabot[bot]"]);
  });

  it("throws on missing file", () => {
    const path = nextConfigPath("missing");
    expect(() => loadConfig(path)).toThrow(/not found or unreadable/);
  });

  it("throws on empty roster", () => {
    const path = nextConfigPath("empty-roster");
    writeConfig(path, { team: { roster: [] }, repos: [] });

    expect(() => loadConfig(path)).toThrow(/team\.roster/);
  });

  it("throws when roster is absent", () => {
    const path = nextConfigPath("no-roster");
    writeConfig(path, { team: {}, repos: [] });

    expect(() => loadConfig(path)).toThrow(/team\.roster/);
  });

  it("defaults repos to empty array when omitted", () => {
    const path = nextConfigPath("no-repos");
    writeConfig(path, { team: { roster: ["alice"] } });

    const loaded = loadConfig(path);
    expect(loaded.repoConfigs).toEqual([]);
    expect(loaded.repos).toEqual([]);
  });
});
