import { describe, expect, it, vi } from "vitest";
import { SlackHttpAdapter } from "./slack.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

function adapter(fetchFn: typeof fetch): SlackHttpAdapter {
  return new SlackHttpAdapter({ token: "xoxp-tok", channel: "C123", fetchFn });
}

describe("SlackHttpAdapter", () => {
  it("posts a top-level message with Bearer auth and returns the ts", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ ok: true, ts: "1700000000.000100" }),
    ) as unknown as typeof fetch;

    const ts = await adapter(fetchFn).postAssignment(undefined, "assigned alice");
    expect(ts).toBe("1700000000.000100");

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    const req = init as RequestInit;
    expect(req.method).toBe("POST");
    const headers = req.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxp-tok");
    const body = JSON.parse(req.body as string) as Record<string, unknown>;
    expect(body).toEqual({ channel: "C123", text: "assigned alice" });
  });

  it("nests a repost under a thread when threadTs is given", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ ok: true, ts: "2.0" }),
    ) as unknown as typeof fetch;

    await adapter(fetchFn).repostPending("1.0", "still open");
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.thread_ts).toBe("1.0");
  });

  it("throws on a Slack logical error (ok:false in a 200 body)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ ok: false, error: "channel_not_found" }),
    ) as unknown as typeof fetch;

    await expect(adapter(fetchFn).postAssignment(undefined, "x")).rejects.toThrow(
      "channel_not_found",
    );
  });
});
