/**
 * Deterministic tie-break helpers. No Math.random — ties resolve the same way
 * every run for a given (prNumber, login, salt) triple, so assignments are
 * reproducible and testable.
 */

/** FNV-1a 32-bit hash of a string → unsigned int. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic dice roll in [0, 1) seeded on (prNumber, login, salt).
 * Used only to break exact ties after primary score and load.
 */
export function seededDice(
  prNumber: number,
  login: string,
  salt = "",
): number {
  return fnv1a(`${prNumber}:${login}:${salt}`) / 0x100000000;
}
