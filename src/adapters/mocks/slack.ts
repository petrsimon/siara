import type { SlackAdapter } from "../index.js";

export interface RecordedSlackMessage {
  threadTs: string | undefined;
  text: string;
  ts: string;
}

export class MockSlackAdapter implements SlackAdapter {
  public readonly assignments: RecordedSlackMessage[] = [];
  public readonly reposts: RecordedSlackMessage[] = [];
  private callCount = 0;

  async postAssignment(
    threadTs: string | undefined,
    text: string,
  ): Promise<string> {
    this.callCount += 1;
    const ts = `assignment-${this.callCount}`;
    this.assignments.push({ threadTs, text, ts });
    return ts;
  }

  async repostPending(
    threadTs: string | undefined,
    text: string,
  ): Promise<string> {
    this.callCount += 1;
    const ts = `repost-${this.callCount}`;
    this.reposts.push({ threadTs, text, ts });
    return ts;
  }
}
