import type { JiraAdapter } from "../index.js";
import type { JiraData } from "../../types.js";

export class MockJiraAdapter implements JiraAdapter {
  constructor(
    private readonly issues: Record<string, JiraData> = {},
    private readonly workload: Record<string, number> = {},
  ) {}

  async getIssueData(key: string): Promise<JiraData> {
    return this.issues[key] ?? {};
  }

  async getReviewerWorkload(logins: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const login of logins) {
      if (this.workload[login] !== undefined) {
        result[login] = this.workload[login];
      }
    }
    return result;
  }
}
