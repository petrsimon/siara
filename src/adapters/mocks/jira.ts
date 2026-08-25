import type { JiraAdapter } from "../index.js";
import type { JiraData } from "../../types.js";

export class MockJiraAdapter implements JiraAdapter {
  constructor(private readonly issues: Record<string, JiraData> = {}) {}

  async getIssueData(key: string): Promise<JiraData> {
    return this.issues[key] ?? {};
  }
}
