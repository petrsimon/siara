/** Path + branch helpers shared by scorers. Pure, no I/O. */

/** Directory of a repo-relative path ("src/auth/login.ts" → "src/auth"). */
export function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

/** Distinct directories touched by a set of paths. */
export function distinctDirs(paths: string[]): string[] {
  return [...new Set(paths.map(dirOf))];
}

/**
 * Branch-family key: everything up to the last "/" or "-" segment boundary.
 * "feat/auth-login" and "feat/auth-session" share family "feat/auth".
 * Falls back to the whole branch when no separator group is found.
 */
export function branchFamily(branch: string): string {
  // Strip a trailing token after the last '-' so sibling feature branches match.
  const lastDash = branch.lastIndexOf("-");
  if (lastDash > branch.indexOf("/")) {
    return branch.slice(0, lastDash);
  }
  return branch;
}

/** True when two branches belong to the same family. */
export function sameBranchFamily(a: string, b: string): boolean {
  return branchFamily(a) === branchFamily(b) && branchFamily(a).length > 0;
}
