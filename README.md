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

> **Risk ≠ size.** Difficulty is pure size/spread today. A one-line auth/crypto
> change scores "simple" while being high-risk, so simple-path education routing
> is flagged as *advisory* in the rationale until path-risk weighting lands
> (Phase 1.5).

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

## Development

```sh
npm install
npm run typecheck
npm test
```

Scorers are pure functions with fixture-based unit tests — no network in tests.

## License

MIT
