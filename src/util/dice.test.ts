import { describe, expect, it } from "vitest";
import { seededDice } from "./dice.js";

describe("seededDice", () => {
  it("is stable across repeated calls for the same inputs", () => {
    const first = seededDice(123, "alice", "team-salt");
    const second = seededDice(123, "alice", "team-salt");

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
  });

  it("differs by login for the same PR", () => {
    const alice = seededDice(123, "alice", "team-salt");
    const bob = seededDice(123, "bob", "team-salt");

    expect(alice).not.toBe(bob);
  });

  it("differs by PR number for the same login", () => {
    const pr100 = seededDice(100, "alice", "team-salt");
    const pr200 = seededDice(200, "alice", "team-salt");

    expect(pr100).not.toBe(pr200);
  });

  it("differs by salt", () => {
    const a = seededDice(123, "alice", "salt-a");
    const b = seededDice(123, "alice", "salt-b");

    expect(a).not.toBe(b);
  });
});
