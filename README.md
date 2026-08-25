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
- **JSONL** (`data/assignments.jsonl`, git-tracked) — append-only, auditable
  assignment log.

## Status

Phase 1, in active development. Full spec: `inators.main--siara-reviewer-assigner-plan.md`.

Scoring layer (difficulty, familiarity, knowledge, follow-up affinity,
files-at-risk, soft boosts) and orchestrator are the current focus. Sync,
adapters, dashboard, and dry-run mode follow.

## Usage

```sh
npm install
npm run build

# configure: copy the example and edit roster + repos
cp siara.config.example.json siara.config.json

node dist/cli.js sync        # fetch GitHub/Jira signals into ./siara.db
node dist/cli.js dry-run     # score pending PRs, no side effects (start here)
node dist/cli.js daily       # assign + comment + request review + log
node dist/cli.js dashboard   # write ./dashboard.html from the assignment log
```

The GitHub adapter shells out to the authenticated [`gh` CLI](https://cli.github.com/)
— no tokens to configure, no extra dependencies. **Start with `dry-run`** to tune
config and build trust before going live.

Environment: `SIARA_CONFIG` (default `./siara.config.json`), `SIARA_DB`
(default `./siara.db`).

### Publishing the dashboard (GitHub Pages)

`.github/workflows/dashboard.yml` builds the dashboard from the git-tracked
assignment log, encrypts it with **StatiCrypt** (client-side AES — the page
decrypts in-browser on the right password), and deploys to GitHub Pages. The
dashboard shows internal fairness data, so it is **never published in the
clear**.

Setup:

1. Repo **Settings → Pages → Source: GitHub Actions**.
2. Repo **Settings → Secrets and variables → Actions →** add `DASHBOARD_PASSWORD`
   (share it with the team out-of-band, e.g. in Slack).

The workflow runs on pushes to `data/assignments.jsonl`, daily on a schedule,
and on manual dispatch. It needs no `gh` auth or team config — only the
committed assignment log. If `DASHBOARD_PASSWORD` is unset the run fails loudly
rather than publishing an unencrypted page.

> Fallback: if the repo moves to a GitHub Enterprise org, switch to native
> **private GitHub Pages** (org-member auth) and drop StatiCrypt.

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
