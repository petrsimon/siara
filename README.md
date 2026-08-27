# Siara

**Siara** — **S**uper**I**ntelligent**A**uto**R**eviewer**A**ssigner.

A deterministic, **non-LLM** TypeScript engine that picks pull-request reviewers
from real team signals (GitHub commit/review history + Jira metadata). No black
box: every assignment comes with a human-readable rationale.

## Why

Reviewer assignment usually optimizes for one thing (load, or CODEOWNERS, or
"whoever's free"). Siara balances three that pull against each other:

- **Education** — route *simple* PRs to the *least familiar* reviewer so
  knowledge spreads (backed by [SofiaWL](https://arxiv.org/abs/2312.17236)).
- **Expertise** — route *hard* PRs to the people who actually know the code.
- **Fairness** — load-aware tie-breaks and per-repo blocklists so the same few
  people don't carry every review.

Plus a **files-at-risk / bus-factor** signal that nudges a non-owner into review
whenever a changed file is known by only one developer — even on hard PRs.

## How it works

```
PR inputs → filter eligible → difficulty score (3 bands)
                                   ├─ simple   → prefer lowest familiarity
                                   ├─ moderate → blend familiarity + knowledge
                                   └─ hard     → rank by knowledge
          → files-at-risk spread boost → follow-up affinity boost
          → soft Jira estimate/priority boosts
          → sort: primary score → load → seeded dice
          → assign top N + log rationale as a PR comment
```

Before scoring, eligibility removes blocklisted users, the PR author, already
requested reviewers, and recorded decliners. When maintainer data is available,
CODEOWNERS/maintainer matches narrow the pool when at least one roster member
matches; otherwise the normal roster pool remains. If a previously suggested
reviewer is removed from GitHub, the next daily run records the decline and
reassigns without that reviewer. Manual reviewer changes are respected.

All scoring is **pure and deterministic**: ties break with a seeded dice on
`(prNumber, login)`, so the same inputs always produce the same assignment.

## Difficulty banding

A continuous 0–1 score from diff shape (churn, file count, directory spread —
each normalized to 0–1 before weighting), mapped to `simple` / `moderate` /
`hard`. See the [plan](#status) for the full formula.

> **Risk ≠ size — handled.** Diff size alone would score a one-line auth/crypto
> change as "simple" and route it to the least-familiar reviewer. Siara applies
> **path-risk weighting**: files matching risk rules (auth, crypto, migrations,
> secrets, infra…) have their churn multiplied *before* aggregation, and any
> high-risk path **floors the band** (e.g. simple → moderate) so knowledge — not
> education — drives routing. Rules and multipliers are configurable per team and
> per repo (`pathRisk` in config). The rationale names the risky paths and the
> escalation.

## Daily Slack workflow

Siara runs inside a daily Slack workflow where devs post PRs awaiting review:

- **New PRs** → assigned, rationale posted to thread, review requested on GitHub.
- **Pending PRs** → reposted daily with **age** and **assignee**, with
  staleness escalation (`≥3d` ⚠️, `≥5d` 🔴 overdue).
- **Completed PRs** → dropped from the repost.

The daily repost *is* the notification system — no separate DM/escalation infra.

## Data

- **SQLite** (`siara.db`, gitignored) — cached GitHub/Jira data + computed
  scores, rebuilt from APIs on cold start, incrementally updated daily.
- **JSONL** (`data/assignments.jsonl`, gitignored) — append-only, auditable
  assignment log. It holds **real reviewer names**, so the plaintext `data/` dir
  is never committed; the dashboard is published from an **encrypted** copy
  (`data.enc`) instead — see [Publishing](#publishing-the-dashboard-github-pages).
- **Dashboard artifacts** (also under `data/`, all included in `data.enc`):
  `assignments.open-prs.json` is the latest point-in-time open-PR snapshot used
  for current age/staleness views; `assignments.response-times.json` is the
  latest GitHub review-request/review/merge timing report; and
  `assignments.overrides.jsonl` records observed manual reviewer changes. The
  dashboard's History view combines the assignment log with PRs present in the
  response report but absent from that log (including GitHub review-request rows
  for merged PRs). Its age charts describe current open PRs, not historical PR
  age at merge (historical records do not yet store `createdAt`).

## Status

Working end-to-end: sync, scoring (difficulty, familiarity, knowledge,
follow-up affinity, files-at-risk, soft boosts), orchestrator, adapters
(GitHub/Jira/Slack), dry-run, shadow, and the encrypted dashboard. Full spec:
`inators.main--siara-reviewer-assigner-plan.md`.

## Usage

```sh
npm install
npm run build

# configure: copy the example and edit roster + repos
cp siara.config.example.json siara.config.json

node dist/cli.js sync        # fetch GitHub/Jira signals into ./siara.db
node dist/cli.js dry-run     # score pending PRs, no side effects (start here)
node dist/cli.js shadow      # compute + log recommendations, post nothing
node dist/cli.js daily       # assign + comment + request review + log
node dist/cli.js backfill    # score current open PRs to populate difficulty bands
node dist/cli.js admin       # run the local reviewer-admin page (port 4319)
node dist/cli.js dashboard   # write ./dashboard.html from the dashboard artifacts
```

The GitHub adapter shells out to the authenticated [`gh` CLI](https://cli.github.com/)
— use `gh auth login` locally or `GH_TOKEN` in the current container template;
there are no extra application dependencies. **Start with `dry-run`** to tune
config and build trust before going live.

Environment: `SIARA_CONFIG` (default `./siara.config.json`), `SIARA_DB`
(default `./siara.db`).

`sync` is the slow step. Pass `--no-sync` to `dry-run`/`daily` to score from the
last-synced signals (open PRs are still listed fresh) — turns a multi-minute
round trip into ~2s while iterating on scoring or config.

### Faster commit history from local clones

The dominant sync cost is the commits API: one request per changed path. If you
already have a repo cloned, point Siara at it and it reads authorship from
`git log` in one pass instead — minutes become sub-second. Reviews, open PRs, and
review load still come from `gh` (they don't exist in a clone).

```jsonc
{
  "team": {
    "roster": ["octocat", "hubot"],
    // git records author *emails*, not GitHub logins — map them:
    "identityMap": { "octo@example.com": "octocat", "hubot@example.com": "hubot" }
  },
  "repos": [
    { "repo": "my-org/my-repo", "localPath": "/abs/path/to/clone" }
  ]
}
```

GitHub noreply emails (`ID+login@users.noreply.github.com`) are decoded
automatically. Add every email a teammate commits under (people often mix a work
and a personal address); unmapped authors are ignored. **Keep the clone fetched**
— a stale clone misses recent authorship. If `localPath` is missing or not a git
repo, Siara falls back to the API for that repo.

### Publishing the dashboard (GitHub Pages)

The fairness log holds real reviewer names, so it is **never committed in the
clear**. Instead you publish an **encrypted bundle**:

```sh
# after a daily/shadow run, encrypt data/ -> data.enc and commit it
SIARA_LOG_KEY=<shared-passphrase> npm run publish-log
git add data.enc && git commit -m "chore: publish fairness log" && git push
```

`.github/workflows/dashboard.yml` then, on each push to `data.enc` (plus a daily
schedule and manual dispatch): decrypts `data.enc` with the `SIARA_LOG_KEY`
secret, builds the dashboard, encrypts the rendered page with **StatiCrypt**
(client-side AES — the page decrypts in-browser on the right password), and
deploys to GitHub Pages. So the data is protected **twice**: encrypted at rest in
git (`data.enc`) and encrypted in transit to viewers (StatiCrypt).

Setup:

1. Repo **Settings → Pages → Source: GitHub Actions**.
2. Repo **Settings → Secrets and variables → Actions →** add two secrets, each
   shared with the team out-of-band (e.g. in Slack):
   - `SIARA_LOG_KEY` — the passphrase used by `npm run publish-log` (decrypts `data.enc`).
   - `DASHBOARD_PASSWORD` — the StatiCrypt password viewers type to open the page.

The workflow needs no `gh` auth or team config — only the committed `data.enc`.
If either secret is unset the run **fails loudly** rather than publishing an
unencrypted or empty page. Encryption is symmetric AES-256 via `openssl`
(preinstalled on the runner and macOS; see `scripts/log-crypt.sh`).

> Fallback: if the repo moves to a GitHub Enterprise org, switch to native
> **private GitHub Pages** (org-member auth) and drop StatiCrypt.

## Deployment (Litestream + S3 on OpenShift/Clowder)

Siara is a scheduled batch job (one `daily` run), not a long-running service.
The container image runs Litestream to replicate the configured `SIARA_DB`
(default `/data/siara.db` in the image) to S3-compatible object storage so
SQLite state survives pod restarts without managed Postgres.

### Flow

1. **Restore** — on startup, `litestream restore -if-replica-exists` pulls the
   latest replica into `SIARA_DB` (no-op on first run).
2. **Replicate + exec** — `litestream replicate -exec "siara daily"` streams
   WAL changes while the command runs and performs a final sync on exit; the
   command's exit code is propagated.

WAL mode is enabled in `SqliteStore` (required for Litestream).

### Environment variables

| Variable | Purpose |
| --- | --- |
| `SIARA_DB` | SQLite path (default `/data/siara.db` in the image) |
| `SIARA_CMD` | Subcommand to run under Litestream (default `daily`) |
| `SIARA_CONFIG` | Path to `siara.config.json` |
| `REPLICA_URL` | S3 replica URL, e.g. `s3://bucket-name/siara` |
| `LITESTREAM_ACCESS_KEY_ID` | S3 access key (auto-read by Litestream) |
| `LITESTREAM_SECRET_ACCESS_KEY` | S3 secret key (auto-read by Litestream) |
| `LITESTREAM_ENDPOINT` | S3-compatible endpoint, e.g. `http://minio:9000` (MinIO/Clowder ephemeral) |
| `LITESTREAM_CONFIG` | Litestream config path (default `/opt/app-root/src/litestream.yml`) |
| `ACG_CONFIG` | Clowder `cdappconfig.json` path (default `/cdappconfig.json`) |
| `GH_TOKEN` | GitHub API token for the `gh` CLI |
| `JIRA_USER` / `JIRA_ACCESS_TOKEN` | Jira API credentials |
| `SLACK_TOKEN` | Slack bot token for daily workflow posts |

On Clowder, the current template mounts secrets for GitHub, Jira, and Slack
credentials plus config; Clowder provisions an `objectStore` bucket and injects
storage credentials into `cdappconfig.json`. The entrypoint runs
`scripts/clowder-env.mjs` to map that JSON to the Litestream env vars above.

> **Rehor deployment caveat:** the current Siara adapter/template still uses
> direct `GH_TOKEN` and `JIRA_USER` / `JIRA_ACCESS_TOKEN` credentials. It is not
> yet wired to Rehor's shared `devbot-proxy` (executor-backed `gh` and
> proxy-hosted Jira MCP). Do not treat this template as the final shared-proxy
> deployment: before production, remove GitHub/Jira credentials from the Siara
> pod and use the proxy access path.

See `config/clowdapp.yaml` for an OpenShift Template with a `ClowdApp` job
(no `database:` block — persistence is Litestream + S3 only).

### Local Docker (no bucket)

Build and run without `REPLICA_URL` to skip Litestream (dev/local):

```sh
docker build -t siara:local .
docker run --rm \
  -e GH_TOKEN="$GH_TOKEN" \
  -e SIARA_CONFIG=/etc/siara/siara.config.json \
  -v "$PWD/siara.config.json:/etc/siara/siara.config.json:ro" \
  siara:local
```

With S3 or MinIO, export `REPLICA_URL` and `LITESTREAM_*` (or rely on
`ACG_CONFIG` / Clowder). Example with MinIO:

```sh
export REPLICA_URL=s3://siara/siara
export LITESTREAM_ACCESS_KEY_ID=minioadmin
export LITESTREAM_SECRET_ACCESS_KEY=minioadmin
export LITESTREAM_ENDPOINT=http://localhost:9000
docker run --rm --network host -e REPLICA_URL -e LITESTREAM_ACCESS_KEY_ID \
  -e LITESTREAM_SECRET_ACCESS_KEY -e LITESTREAM_ENDPOINT \
  -e GH_TOKEN="$GH_TOKEN" \
  -v "$PWD/siara.config.json:/etc/siara/siara.config.json:ro" \
  siara:local
```

## Security

- **No shell injection** — the GitHub adapter shells to `gh` via `execFile` with
  argument arrays, never a shell string.
- **Input validation** — repo slugs and logins from config are validated at load
  time (`owner/name`, GitHub-username charset) before they reach `gh api`
  endpoints, blocking path/query injection and `-`-leading argument confusion.
- **Safe temp files** — PR-comment bodies are written to a private `mkdtemp`
  directory (`0700`, `wx` flag), defeating predictable-name symlink attacks.
- **Dashboard XSS** — every user-derived string is HTML-escaped before embedding.
- **No secrets in the repo** — `siara.config.json` (roster, Jira IDs, emails) and
  `siara.db` are gitignored; only `siara.config.example.json` is tracked. Auth is
  delegated to the ambient `gh` credentials; `DASHBOARD_PASSWORD` is a CI secret.
- **Parameterized SQL** and per-line-tolerant JSONL reads (one corrupt line can't
  break the dashboard or forge a record).

## Development

```sh
npm install
npm run typecheck
npm test
```

Scorers, orchestrator, store, runtime, and dashboard are covered by fixture-based
unit tests — no network in tests (the `gh` adapter's pure parsers are tested
against fixture JSON).

## License

MIT
