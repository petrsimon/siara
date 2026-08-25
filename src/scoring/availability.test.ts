import { describe, expect, it } from "vitest";
import { availabilityPenalty, isReviewerUnavailable } from "./availability.js";
import type { SiaraTeamConfig } from "../config.js";

const AVAIL: SiaraTeamConfig["availability"] = {
  loadWeight: 0.03,
  busyWeight: 0.15,
  managerModeratePenalty: 0.25,
  managerHardPenalty: 0.6,
  unavailablePenalty: 5,
  bandWeight: { simple: 0.2, moderate: 0.6, hard: 1.0 },
  hardWipLimit: 3,
  hardWipPenalty: 0.5,
  maxPenaltyFraction: 0.9,
};

function team(managers: string[]): Pick<SiaraTeamConfig, "managers" | "availability"> {
  return { managers, availability: AVAIL };
}

describe("availabilityPenalty", () => {
  it("is zero with no load, no busy, non-manager", () => {
    expect(
      availabilityPenalty({
        login: "dev",
        band: "hard",
        openReviewLoad: 0,
        jiraBusy: 0,
        team: team([]),
      }),
    ).toBe(0);
  });

  it("scales load penalty by band weight", () => {
    const args = { login: "dev", openReviewLoad: 10, jiraBusy: 0, team: team([]) };
    const hard = availabilityPenalty({ ...args, band: "hard" });
    const simple = availabilityPenalty({ ...args, band: "simple" });
    // raw = 0.03*10 = 0.3; hard=1.0x, simple=0.2x
    expect(hard).toBeCloseTo(0.3);
    expect(simple).toBeCloseTo(0.06);
    expect(simple).toBeLessThan(hard);
  });

  it("weights busy heavier than load per unit", () => {
    const load = availabilityPenalty({
      login: "dev",
      band: "hard",
      openReviewLoad: 1,
      jiraBusy: 0,
      team: team([]),
    });
    const busy = availabilityPenalty({
      login: "dev",
      band: "hard",
      openReviewLoad: 0,
      jiraBusy: 1,
      team: team([]),
    });
    expect(busy).toBeGreaterThan(load);
  });

  it("penalizes managers on hard more than moderate, never on simple", () => {
    const base = { login: "boss", openReviewLoad: 0, jiraBusy: 0, team: team(["boss"]) };
    const hard = availabilityPenalty({ ...base, band: "hard" });
    const moderate = availabilityPenalty({ ...base, band: "moderate" });
    const simple = availabilityPenalty({ ...base, band: "simple" });
    // hard = 1.0*0.6 = 0.6; moderate = 0.6*0.25 = 0.15; simple = 0
    expect(hard).toBeCloseTo(0.6);
    expect(moderate).toBeCloseTo(0.15);
    expect(simple).toBe(0);
    expect(hard).toBeGreaterThan(moderate);
  });

  it("does not penalize a non-manager for the manager component", () => {
    const args = { login: "dev", band: "hard" as const, openReviewLoad: 0, jiraBusy: 0 };
    expect(availabilityPenalty({ ...args, team: team(["boss"]) })).toBe(0);
    expect(availabilityPenalty({ ...args, team: team(["dev"]) })).toBeCloseTo(0.6);
  });

  it("combines load, busy, and manager components", () => {
    const p = availabilityPenalty({
      login: "boss",
      band: "hard",
      openReviewLoad: 5,
      jiraBusy: 2,
      team: team(["boss"]),
    });
    // raw = 0.03*5 + 0.15*2 + 0.6 = 0.15 + 0.30 + 0.6 = 1.05; band 1.0x
    expect(p).toBeCloseTo(1.05);
  });

  it("adds no hard-WIP penalty at or below the limit", () => {
    const base = { login: "dev", openReviewLoad: 0, jiraBusy: 0, team: team([]) };
    // hardReviewLoad 0..2 (limit 3) → no overflow yet.
    expect(availabilityPenalty({ ...base, band: "hard", hardReviewLoad: 2 })).toBe(0);
  });

  it("adds an escalating hard-WIP penalty past the limit, on hard only", () => {
    const base = { login: "dev", openReviewLoad: 0, jiraBusy: 0, team: team([]) };
    // limit 3: holding 3 → over 1 → 0.5; holding 4 → over 2 → 1.0. band hard = 1.0x.
    const at3 = availabilityPenalty({ ...base, band: "hard", hardReviewLoad: 3 });
    const at4 = availabilityPenalty({ ...base, band: "hard", hardReviewLoad: 4 });
    expect(at3).toBeCloseTo(0.5);
    expect(at4).toBeCloseTo(1.0);
    expect(at4).toBeGreaterThan(at3);
    // Never on simple/moderate — hard PRs are the only ones protected.
    expect(availabilityPenalty({ ...base, band: "simple", hardReviewLoad: 9 })).toBe(0);
    expect(availabilityPenalty({ ...base, band: "moderate", hardReviewLoad: 9 })).toBeCloseTo(0);
  });

  it("disables the hard-WIP penalty when hardWipLimit is 0", () => {
    const off: SiaraTeamConfig["availability"] = { ...AVAIL, hardWipLimit: 0 };
    const p = availabilityPenalty({
      login: "dev",
      band: "hard",
      openReviewLoad: 0,
      jiraBusy: 0,
      hardReviewLoad: 9,
      team: { managers: [], availability: off },
    });
    expect(p).toBe(0);
  });

  it("clamps negative load/busy to zero", () => {
    const p = availabilityPenalty({
      login: "dev",
      band: "hard",
      openReviewLoad: -5,
      jiraBusy: -3,
      team: team([]),
    });
    expect(p).toBe(0);
  });

  it("adds a flat unavailable penalty on every band (not band-scaled)", () => {
    const base = { login: "dev", openReviewLoad: 0, jiraBusy: 0, team: team([]), unavailable: true };
    const simple = availabilityPenalty({ ...base, band: "simple" });
    const hard = availabilityPenalty({ ...base, band: "hard" });
    // PTO is flat 5 regardless of band (no load/busy/manager here).
    expect(simple).toBeCloseTo(5);
    expect(hard).toBeCloseTo(5);
  });

  it("stacks the unavailable penalty on top of band-scaled load/busy", () => {
    const p = availabilityPenalty({
      login: "dev",
      band: "hard",
      openReviewLoad: 5,
      jiraBusy: 2,
      unavailable: true,
      team: team([]),
    });
    // raw = 0.03*5 + 0.15*2 = 0.45; band 1.0x → 0.45; + 5 flat PTO = 5.45
    expect(p).toBeCloseTo(5.45);
  });
});

describe("isReviewerUnavailable", () => {
  const NOW = "2026-08-25T10:00:00.000Z";

  it("is false when props are missing or unavailable is not set", () => {
    expect(isReviewerUnavailable(undefined, NOW)).toBe(false);
    expect(isReviewerUnavailable({ busy: 3 }, NOW)).toBe(false);
    expect(isReviewerUnavailable({ unavailable: false }, NOW)).toBe(false);
  });

  it("is true when unavailable with no until (open-ended PTO)", () => {
    expect(isReviewerUnavailable({ unavailable: true }, NOW)).toBe(true);
  });

  it("respects an inclusive until date, auto-expiring the day after", () => {
    expect(isReviewerUnavailable({ unavailable: true, until: "2026-08-25" }, NOW)).toBe(true);
    expect(isReviewerUnavailable({ unavailable: true, until: "2026-08-26" }, NOW)).toBe(true);
    expect(isReviewerUnavailable({ unavailable: true, until: "2026-08-24" }, NOW)).toBe(false);
  });
});
