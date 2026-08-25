import { describe, expect, it, vi } from "vitest";
import type { SiaraTeamConfig } from "../config.js";
import { JiraCloudAdapter } from "./jira.js";

type JiraCfg = NonNullable<SiaraTeamConfig["jira"]>;

const BASE = "https://redhat.atlassian.net";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

function adapter(config: JiraCfg, fetchFn: typeof fetch): JiraCloudAdapter {
  return new JiraCloudAdapter({ email: "me@rh.com", token: "tok", config, fetchFn });
}

describe("JiraCloudAdapter.getIssueData", () => {
  it("normalizes priority, reads story points and next-gen parent epic", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        key: "RHCLOUD-1",
        fields: {
          priority: { name: "Highest" },
          parent: { key: "RHCLOUD-100" },
          customfield_10016: 5,
        },
      }),
    ) as unknown as typeof fetch;

    const cfg: JiraCfg = { baseUrl: BASE, storyPointsFieldId: "customfield_10016" };
    const data = await adapter(cfg, fetchFn).getIssueData("RHCLOUD-1");

    expect(data).toEqual({ priority: "blocker", estimate: 5, epic: "RHCLOUD-100" });
  });

  it("uses Basic auth and requests only the configured fields", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ key: "X-1", fields: {} }),
    ) as unknown as typeof fetch;

    await adapter({ baseUrl: BASE }, fetchFn).getIssueData("X-1");

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(`${BASE}/rest/api/3/issue/X-1?fields=priority,parent`);
    const auth = (init as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe(
      `Basic ${Buffer.from("me@rh.com:tok").toString("base64")}`,
    );
  });

  it("returns {} when the ticket is inaccessible (never fails sync)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({}, false, 404),
    ) as unknown as typeof fetch;

    const data = await adapter({ baseUrl: BASE }, fetchFn).getIssueData("GONE-1");
    expect(data).toEqual({});
  });

  it("ignores an unmapped priority", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ key: "X-2", fields: { priority: { name: "Trivial" } } }),
    ) as unknown as typeof fetch;

    const data = await adapter({ baseUrl: BASE }, fetchFn).getIssueData("X-2");
    expect(data).toEqual({});
  });
});

describe("JiraCloudAdapter.getReviewerWorkload", () => {
  const cfg: JiraCfg = {
    baseUrl: BASE,
    storyPointsFieldId: "customfield_10016",
    accountMap: { alice: "acc-a", bob: "acc-b" },
  };

  it("returns {} when no roster login has a Jira account mapping", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const result = await adapter({ baseUrl: BASE }, fetchFn).getReviewerWorkload([
      "alice",
    ]);
    expect(result).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("weights in-progress issues by priority × points, keyed by github login", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        issues: [
          {
            key: "A-1",
            fields: {
              assignee: { accountId: "acc-a" },
              priority: { name: "High" }, // weight 2
              customfield_10016: 3,
            },
          },
          {
            key: "A-2",
            fields: {
              assignee: { accountId: "acc-a" },
              priority: { name: "Medium" }, // weight 1
              customfield_10016: 2,
            },
          },
          {
            key: "B-1",
            fields: {
              assignee: { accountId: "acc-b" },
              priority: { name: "Highest" }, // weight 3, no points → 1
            },
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await adapter(cfg, fetchFn).getReviewerWorkload(["alice", "bob"]);
    // alice: 2*3 + 1*2 = 8 ; bob: 3*1 = 3
    expect(result).toEqual({ alice: 8, bob: 3 });

    const [url] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain("/rest/api/3/search/jql?jql=");
    expect(decodeURIComponent(url as string)).toContain(
      'assignee in (acc-a,acc-b) AND statusCategory = "In Progress"',
    );
  });

  it("respects configured priority weights and status category", async () => {
    const tuned: JiraCfg = {
      ...cfg,
      workload: { statusCategory: "In Review", priorityWeights: { high: 10 } },
    };
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        issues: [
          {
            key: "A-1",
            fields: { assignee: { accountId: "acc-a" }, priority: { name: "High" } },
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await adapter(tuned, fetchFn).getReviewerWorkload(["alice"]);
    expect(result).toEqual({ alice: 10 });
    const [url] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(decodeURIComponent(url as string)).toContain('statusCategory = "In Review"');
  });

  it("returns {} on a search error (soft fallback)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({}, false, 400),
    ) as unknown as typeof fetch;
    const result = await adapter(cfg, fetchFn).getReviewerWorkload(["alice"]);
    expect(result).toEqual({});
  });
});
