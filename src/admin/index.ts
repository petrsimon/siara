/**
 * Local editable admin page (NOT published). A tiny localhost HTTP server that
 * renders an editable roster and writes reviewer properties (busy coefficient +
 * PTO/don't-assign) straight back into siara.config.json.
 *
 * Deliberately localhost-only and config-file-backed: the published dashboard
 * stays static/log-only, while operators tune availability here. No deps — the
 * server uses node:http; the pure functions below are unit-tested.
 */
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewerProps } from "../config.js";
import type { SiaraConfigFile } from "../config-loader.js";
import { escapeHtml } from "../dashboard/html.js";

/**
 * Validate + normalize a POSTed reviewers payload against the roster. Rejects
 * off-roster logins (the same trust-boundary guard the config loader applies)
 * and coerces each field to its expected type, dropping empties so the config
 * stays minimal.
 */
export function parseReviewersPayload(
  payload: unknown,
  roster: string[],
): Record<string, ReviewerProps> {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("reviewers payload must be an object");
  }
  const rosterSet = new Set(roster);
  const out: Record<string, ReviewerProps> = {};
  for (const [login, raw] of Object.entries(payload as Record<string, unknown>)) {
    if (!rosterSet.has(login)) {
      throw new Error(`reviewers login "${login}" is not on the roster`);
    }
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`reviewers["${login}"] must be an object`);
    }
    const r = raw as Record<string, unknown>;
    const props: ReviewerProps = {};
    if (typeof r.busy === "number" && Number.isFinite(r.busy) && r.busy !== 0) {
      props.busy = r.busy;
    }
    if (r.unavailable === true) {
      props.unavailable = true;
    }
    if (typeof r.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.until)) {
      props.until = r.until;
    }
    if (typeof r.note === "string" && r.note.trim() !== "") {
      props.note = r.note.trim();
    }
    // Only keep reviewers with at least one meaningful property.
    if (Object.keys(props).length > 0) {
      out[login] = props;
    }
  }
  return out;
}

/**
 * Set `team.reviewers` in a raw siara.config.json string, preserving everything
 * else, and pretty-print it back. Pure — the server does the file I/O.
 */
export function updateReviewersInConfig(
  rawJson: string,
  reviewers: Record<string, ReviewerProps>,
): string {
  const parsed = JSON.parse(rawJson) as SiaraConfigFile;
  if (!parsed.team) {
    throw new Error("config has no team block");
  }
  parsed.team.reviewers = reviewers;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Render the editable admin HTML page. */
export function renderAdminPage(
  roster: string[],
  reviewers: Record<string, ReviewerProps>,
): string {
  const rows = [...roster]
    .sort((a, b) => a.localeCompare(b))
    .map((login) => {
      const p = reviewers[login] ?? {};
      const busy = p.busy ?? "";
      const checked = p.unavailable ? " checked" : "";
      const until = p.until ?? "";
      const note = p.note ? escapeHtml(p.note) : "";
      const id = escapeHtml(login);
      return `
        <tr data-login="${id}">
          <td class="login">${id}</td>
          <td><input type="number" step="0.5" class="f-busy" value="${busy}" style="width:5rem"></td>
          <td><input type="checkbox" class="f-unavail"${checked}></td>
          <td><input type="date" class="f-until" value="${escapeHtml(until)}"></td>
          <td><input type="text" class="f-note" value="${note}" style="width:100%"></td>
        </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Siara — Reviewer Admin (local)</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 820px;
      margin: 2rem auto; padding: 0 1rem; color: #191c24; background: #f7f8fa; }
    h1 { font-size: 1.4rem; }
    p.hint { color: #5c6370; font-size: 0.9rem; }
    table { width: 100%; border-collapse: collapse; background: #fff;
      border: 1px solid #e4e7ec; border-radius: 8px; }
    th, td { padding: 0.5rem 0.6rem; text-align: left; border-bottom: 1px solid #e4e7ec; }
    th { font-size: 0.75rem; text-transform: uppercase; color: #5c6370; }
    .login { font-weight: 600; }
    button { margin-top: 1rem; padding: 0.5rem 1.2rem; font-size: 0.95rem;
      border: none; border-radius: 8px; background: #3b6df6; color: #fff; cursor: pointer; }
    #status { margin-left: 1rem; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Siara — Reviewer Admin <span style="font-weight:400;color:#5c6370">(local, not published)</span></h1>
  <p class="hint">Edit each reviewer's busy coefficient and PTO / don't-assign flag.
  Unavailable applies a strong soft penalty (still assignable if sole viable).
  <code>until</code> auto-expires PTO. Saving writes <code>siara.config.json</code>.</p>
  <table>
    <thead>
      <tr><th>Reviewer</th><th>Busy</th><th>Unavailable</th><th>Until</th><th>Note</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div><button onclick="__save()">Save</button><span id="status"></span></div>
  <script>
    async function __save() {
      var payload = {};
      document.querySelectorAll("tr[data-login]").forEach(function (tr) {
        var login = tr.getAttribute("data-login");
        var busy = parseFloat(tr.querySelector(".f-busy").value);
        var props = {};
        if (!isNaN(busy) && busy !== 0) props.busy = busy;
        if (tr.querySelector(".f-unavail").checked) props.unavailable = true;
        var until = tr.querySelector(".f-until").value;
        if (until) props.until = until;
        var note = tr.querySelector(".f-note").value.trim();
        if (note) props.note = note;
        if (Object.keys(props).length > 0) payload[login] = props;
      });
      var status = document.getElementById("status");
      status.textContent = "Saving…";
      try {
        var res = await fetch("/api/reviewers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        var json = await res.json();
        status.textContent = json.ok ? "Saved ✓" : ("Error: " + (json.error || res.status));
      } catch (e) {
        status.textContent = "Error: " + e;
      }
    }
  </script>
</body>
</html>`;
}

export interface AdminServerOptions {
  configPath: string;
  port?: number;
  /** Loaded roster (validated). */
  roster: string[];
}

/**
 * Start the localhost admin server. Binds to 127.0.0.1 only. Returns the server
 * so the caller (or a test) can close it.
 */
export function startAdminServer(opts: AdminServerOptions): Server {
  const configPath = resolve(opts.configPath);
  const port = opts.port ?? 4319;

  const server = createServer((req, res) => {
    const send = (status: number, type: string, body: string): void => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      // Re-read config each GET so the form reflects the latest on disk.
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as SiaraConfigFile;
      const reviewers = parsed.team?.reviewers ?? {};
      send(200, "text/html; charset=utf-8", renderAdminPage(opts.roster, reviewers));
      return;
    }

    if (req.method === "POST" && req.url === "/api/reviewers") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(); // guard against absurd payloads
      });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body) as unknown;
          const reviewers = parseReviewersPayload(payload, opts.roster);
          const raw = readFileSync(configPath, "utf8");
          writeFileSync(configPath, updateReviewersInConfig(raw, reviewers));
          send(200, "application/json", JSON.stringify({ ok: true }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(400, "application/json", JSON.stringify({ ok: false, error: message }));
        }
      });
      return;
    }

    send(404, "text/plain", "Not found");
  });

  server.listen(port, "127.0.0.1");
  return server;
}
