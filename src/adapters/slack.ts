/**
 * Slack Web API adapter (chat.postMessage).
 *
 * Posts assignment rationales and stale-PR reposts to a single channel. Threads
 * are supported: pass a parent `thread_ts` and replies nest under it; the first
 * post (threadTs undefined) becomes a top-level message and its returned ts can
 * seed a thread.
 *
 * The token is injected (never from config): a user token (xoxp-…) or bot token
 * (xoxb-…) from the SLACK_TOKEN environment. Per Red Hat policy, dev/test runs
 * must target the sandbox workspace, not production. The HTTP fetch is injectable
 * so the adapter is unit-testable without a network.
 */
import type { SlackAdapter } from "./index.js";

type FetchFn = typeof fetch;

export interface SlackHttpOptions {
  /** Bearer token (xoxp-… user or xoxb-… bot) from SLACK_TOKEN. */
  token: string;
  /** Target channel id (e.g. "C0123ABCD") or name the token can post to. */
  channel: string;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: FetchFn;
}

interface SlackPostResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

export class SlackHttpAdapter implements SlackAdapter {
  private readonly token: string;
  private readonly channel: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: SlackHttpOptions) {
    this.token = opts.token;
    this.channel = opts.channel;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async postAssignment(threadTs: string | undefined, text: string): Promise<string> {
    return this.post(threadTs, text);
  }

  async repostPending(threadTs: string | undefined, text: string): Promise<string> {
    return this.post(threadTs, text);
  }

  private async post(threadTs: string | undefined, text: string): Promise<string> {
    const body: Record<string, unknown> = { channel: this.channel, text };
    if (threadTs) body.thread_ts = threadTs;

    const res = await this.fetchFn("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    // Slack signals logical failure in the JSON body (ok:false), often with
    // HTTP 200 — so check both. Surface the Slack error verbatim.
    const json = (await res.json()) as SlackPostResponse;
    if (!res.ok || !json.ok) {
      throw new Error(`Slack chat.postMessage failed: ${json.error ?? res.status}`);
    }
    return json.ts ?? "";
  }
}
