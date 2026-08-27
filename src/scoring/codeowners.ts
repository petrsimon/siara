/**
 * CODEOWNERS parsing and path matching. Pure, deterministic — no I/O.
 *
 * GitHub semantics: last matching rule wins per file; owners are unioned across
 * files. Patterns are gitignore-style with CODEOWNERS-specific anchoring rules.
 */
import { matchGlob } from "../util/paths.js";

export interface CodeownersRule {
  pattern: string;
  /** Raw owner tokens, e.g. "@user" or "@org/team". */
  owners: string[];
}

/** Split CODEOWNERS text into ordered rules (comments and blanks stripped). */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const hashIdx = trimmed.indexOf("#");
    const body = hashIdx >= 0 ? trimmed.slice(0, hashIdx).trim() : trimmed;
    if (body.length === 0) {
      continue;
    }
    const parts = body.split(/\s+/);
    const pattern = parts[0];
    if (pattern === undefined) {
      continue;
    }
    const owners = parts.slice(1);
    if (owners.length === 0) {
      continue;
    }
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Match a repo-relative path against a CODEOWNERS pattern.
 * Covers: `*` (all), `/dir/` (directory prefix), `*.ext`, `path/to/file`, `dir/**`.
 */
export function matchCodeownersPattern(path: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }

  // Trailing `/` — directory prefix (matches the dir and everything beneath).
  if (pattern.endsWith("/")) {
    const prefix = pattern.slice(0, -1);
    if (prefix.startsWith("/")) {
      const anchored = prefix.slice(1);
      return path.startsWith(`${anchored}/`);
    }
    return (
      path === prefix ||
      path.startsWith(`${prefix}/`) ||
      path.endsWith(`/${prefix}`) ||
      path.includes(`/${prefix}/`)
    );
  }

  // Leading `/` — anchored to repository root.
  if (pattern.startsWith("/")) {
    return matchGlob(path, pattern.slice(1));
  }

  // No slash — match basename at any depth.
  if (!pattern.includes("/")) {
    const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
    return matchGlob(base, pattern);
  }

  return matchGlob(path, pattern);
}

/**
 * Owners for the given paths: last-matching-rule-wins per file, unioned across
 * files. Returns raw owner tokens from the file.
 */
export function ownersForPaths(rules: CodeownersRule[], paths: string[]): string[] {
  const ownerSet = new Set<string>();
  for (const path of paths) {
    let matched: string[] | undefined;
    for (const rule of rules) {
      if (matchCodeownersPattern(path, rule.pattern)) {
        matched = rule.owners;
      }
    }
    if (matched) {
      for (const owner of matched) {
        ownerSet.add(owner);
      }
    }
  }
  return [...ownerSet];
}
