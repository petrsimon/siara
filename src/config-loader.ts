/**
 * Load Siara configuration from a JSON file on disk.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_TEAM_CONFIG,
  type SiaraRepoConfig,
  type SiaraTeamConfig,
} from "./config.js";

export interface SiaraConfigFile {
  team: Partial<SiaraTeamConfig> & { roster: string[] };
  repos?: SiaraRepoConfig[];
}

export const SAMPLE_CONFIG: SiaraConfigFile = {
  team: {
    roster: ["alice", "bob", "carol"],
  },
  repos: [
    {
      repo: "my-org/my-repo",
      blocklist: ["dependabot[bot]"],
    },
  ],
};

export interface LoadedConfig {
  teamConfig: SiaraTeamConfig;
  repoConfigs: SiaraRepoConfig[];
  repos: string[];
}

/** "owner/name", each side [A-Za-z0-9_.-]. Blocks path/query injection into gh api URLs. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A GitHub login (optionally "[bot]"). Blocks "-"-leading arg confusion in gh. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;

/**
 * Reject repo slugs / logins that could inject into `gh api` endpoint strings or
 * be misread by `gh` as flags. Values come from operator config, so this is
 * defense-in-depth on the trust boundary, not the only guard.
 */
function validateNames(teamConfig: SiaraTeamConfig, repoConfigs: SiaraRepoConfig[]): void {
  const logins = [
    ...teamConfig.roster,
    ...repoConfigs.flatMap((r) => r.blocklist ?? []),
  ];
  for (const login of logins) {
    if (!LOGIN_RE.test(login)) {
      throw new Error(`Siara config: invalid GitHub login "${login}" (expected a GitHub username)`);
    }
  }
  for (const r of repoConfigs) {
    if (!REPO_RE.test(r.repo)) {
      throw new Error(`Siara config: invalid repo "${r.repo}" (expected "owner/name")`);
    }
  }
}

function mergeTeamConfig(
  partial: Partial<SiaraTeamConfig> & { roster: string[] },
): SiaraTeamConfig {
  return {
    ...DEFAULT_TEAM_CONFIG,
    ...partial,
    roster: partial.roster,
    difficulty: {
      ...DEFAULT_TEAM_CONFIG.difficulty,
      ...partial.difficulty,
      weights: {
        ...DEFAULT_TEAM_CONFIG.difficulty.weights,
        ...partial.difficulty?.weights,
      },
      bands: {
        ...DEFAULT_TEAM_CONFIG.difficulty.bands,
        ...partial.difficulty?.bands,
      },
    },
    difficultyCeilings: {
      ...DEFAULT_TEAM_CONFIG.difficultyCeilings,
      ...partial.difficultyCeilings,
    },
    familiarity: {
      ...DEFAULT_TEAM_CONFIG.familiarity,
      ...partial.familiarity,
    },
    followUpAffinity: {
      ...DEFAULT_TEAM_CONFIG.followUpAffinity,
      ...partial.followUpAffinity,
    },
    filesAtRisk: {
      ...DEFAULT_TEAM_CONFIG.filesAtRisk,
      ...partial.filesAtRisk,
    },
    pathRisk: {
      ...DEFAULT_TEAM_CONFIG.pathRisk,
      ...partial.pathRisk,
      // Keep default rules unless the operator explicitly supplies their own.
      rules: partial.pathRisk?.rules ?? DEFAULT_TEAM_CONFIG.pathRisk.rules,
    },
    identityMap: {
      ...DEFAULT_TEAM_CONFIG.identityMap,
      ...partial.identityMap,
    },
    soft: {
      ...DEFAULT_TEAM_CONFIG.soft,
      ...partial.soft,
    },
    staleness: {
      ...DEFAULT_TEAM_CONFIG.staleness,
      ...partial.staleness,
    },
  };
}

/**
 * Read and merge Siara config from disk.
 * @param configPath Defaults to process.env.SIARA_CONFIG or ./siara.config.json
 */
export function loadConfig(configPath?: string): LoadedConfig {
  const path = resolve(configPath ?? process.env.SIARA_CONFIG ?? "./siara.config.json");

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Siara config not found or unreadable at ${path}: ${message}`);
  }

  let parsed: SiaraConfigFile;
  try {
    parsed = JSON.parse(raw) as SiaraConfigFile;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in Siara config ${path}: ${message}`);
  }

  if (!parsed.team?.roster || parsed.team.roster.length === 0) {
    throw new Error(`Siara config at ${path} must define team.roster with at least one login`);
  }

  const teamConfig = mergeTeamConfig(parsed.team);
  const repoConfigs = parsed.repos ?? [];
  validateNames(teamConfig, repoConfigs);
  const repos = repoConfigs.map((r) => r.repo);

  return { teamConfig, repoConfigs, repos };
}
