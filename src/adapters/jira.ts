/**
 * Jira Cloud adapter (redhat.atlassian.net, REST API v3, Basic auth).
 *
 * Two read-only signals:
 *   - getIssueData(key): estimate (story points), normalized priority, epic —
 *     cached by sync for the soft Jira boosts + follow-up affinity.
 *   - getReviewerWorkload(logins): per-reviewer "heads-down" weight from their
 *     own in-progress, high-priority tickets, feeding the availability penalty.
 *
 * Credentials are injected (never read from config): JIRA_USER (account email) +
 * JIRA_ACCESS_TOKEN (API token), Basic-auth base64("email:token"). The HTTP
 * fetch is injectable so the adapter is unit-testable without a network.
 */
import type { SiaraTeamConfig } from "../config.js";
import type { JiraData } from "../types.js";
import type { JiraAdapter } from "./index.js";

type FetchFn = typeof fetch;

type JiraConfig = NonNullable<SiaraTeamConfig["jira"]>;

export interface JiraCloudOptions {
  /** Account email — Basic-auth username (from JIRA_USER). */
  email: string;
  /** API token — Basic-auth password (from JIRA_ACCESS_TOKEN). */
  token: string;
  /** Resolved Jira config (baseUrl, field ids, accountMap, workload tuning). */
  config: JiraConfig;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: FetchFn;
}

/** Map a Jira priority name to Siara's normalized scale. */
function normalizePriority(name: string | undefined): JiraData["priority"] | undefined {
  switch ((name ?? "").toLowerCase()) {
    case "highest":
    case "blocker":
      return "blocker";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
    case "lowest":
      return "low";
    default:
      return undefined;
  }
}

/** Numeric weight per normalized priority for workload accumulation. */
const DEFAULT_PRIORITY_WEIGHT: Record<NonNullable<JiraData["priority"]>, number> = {
  blocker: 3,
  high: 2,
  medium: 1,
  low: 0.5,
};

interface JiraIssueFields {
  priority?: { name?: string } | null;
  parent?: { key?: string } | null;
  assignee?: { accountId?: string } | null;
  [field: string]: unknown;
}

interface JiraIssue {
  key: string;
  fields: JiraIssueFields;
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
}

export class JiraCloudAdapter implements JiraAdapter {
  private readonly email: string;
  private readonly token: string;
  private readonly cfg: JiraConfig;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: JiraCloudOptions) {
    this.email = opts.email;
    this.token = opts.token;
    this.cfg = opts.config;
    this.baseUrl = opts.config.baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private authHeader(): string {
    const basic = Buffer.from(`${this.email}:${this.token}`).toString("base64");
    return `Basic ${basic}`;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`Jira ${path} → ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  async getIssueData(key: string): Promise<JiraData> {
    const fields = ["priority", "parent"];
    if (this.cfg.storyPointsFieldId) fields.push(this.cfg.storyPointsFieldId);
    if (this.cfg.epicFieldId) fields.push(this.cfg.epicFieldId);

    let issue: JiraIssue;
    try {
      issue = await this.getJson<JiraIssue>(
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.join(",")}`,
      );
    } catch {
      // A missing/inaccessible ticket must not fail the whole sync — the soft
      // boosts simply see no Jira data.
      return {};
    }

    const data: JiraData = {};
    const priority = normalizePriority(issue.fields.priority?.name);
    if (priority) data.priority = priority;

    const estimate = this.readEstimate(issue.fields);
    if (estimate !== undefined) data.estimate = estimate;

    const epic = this.readEpic(issue.fields);
    if (epic) data.epic = epic;

    return data;
  }

  private readEstimate(fields: JiraIssueFields): number | undefined {
    if (!this.cfg.storyPointsFieldId) return undefined;
    const raw = fields[this.cfg.storyPointsFieldId];
    return typeof raw === "number" ? raw : undefined;
  }

  private readEpic(fields: JiraIssueFields): string | undefined {
    if (this.cfg.epicFieldId) {
      const raw = fields[this.cfg.epicFieldId];
      if (typeof raw === "string" && raw !== "") return raw;
    }
    // Next-gen projects: the epic is the parent.
    return fields.parent?.key ?? undefined;
  }

  async getReviewerWorkload(logins: string[]): Promise<Record<string, number>> {
    const accountMap = this.cfg.accountMap ?? {};
    // accountId → github login, only for roster members we can resolve.
    const accountToLogin = new Map<string, string>();
    for (const login of logins) {
      const accountId = accountMap[login];
      if (accountId) accountToLogin.set(accountId, login);
    }
    if (accountToLogin.size === 0) return {};

    const statusCategory = this.cfg.workload?.statusCategory ?? "In Progress";
    const priorityWeights = this.cfg.workload?.priorityWeights;
    const accountIds = [...accountToLogin.keys()];
    const jql =
      `assignee in (${accountIds.join(",")}) ` +
      `AND statusCategory = "${statusCategory}"`;

    const fields = ["priority", "assignee"];
    if (this.cfg.storyPointsFieldId) fields.push(this.cfg.storyPointsFieldId);

    let response: JiraSearchResponse;
    try {
      response = await this.getJson<JiraSearchResponse>(
        // Jira Cloud removed /rest/api/3/search (410) — the enhanced-search
        // endpoint /search/jql is the replacement. Same `issues` response shape.
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
          `&maxResults=100&fields=${fields.join(",")}`,
      );
    } catch {
      // Workload is a soft signal — fall back to the manual reviewerBusy map.
      return {};
    }

    const weightByLogin: Record<string, number> = {};
    for (const issue of response.issues ?? []) {
      const accountId = issue.fields.assignee?.accountId;
      if (!accountId) continue;
      const login = accountToLogin.get(accountId);
      if (!login) continue;

      const priority = normalizePriority(issue.fields.priority?.name);
      const priorityWeight = this.priorityWeight(priority, priorityWeights);
      const points = this.readEstimate(issue.fields) ?? 1;
      weightByLogin[login] = (weightByLogin[login] ?? 0) + priorityWeight * points;
    }
    return weightByLogin;
  }

  private priorityWeight(
    priority: JiraData["priority"] | undefined,
    overrides: Record<string, number> | undefined,
  ): number {
    if (!priority) return 1;
    return overrides?.[priority] ?? DEFAULT_PRIORITY_WEIGHT[priority];
  }
}
