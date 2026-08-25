/**
 * Daily run: sync → assign new PRs (comment + request review + Slack post +
 * JSONL append) → repost pending with age + assignee + staleness marker →
 * completed PRs dropped. Honors DailyOptions.dryRun (no side effects).
 *
 * TODO(composer): implement.
 */
import type { DailyOptions, DailyResult, SiaraDeps } from "./index.js";

export async function daily(
  _deps: SiaraDeps,
  _nowIso: string,
  _opts: DailyOptions = {},
): Promise<DailyResult> {
  throw new Error("not implemented");
}
