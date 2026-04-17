# Codex Review

Local pre-PR reviewer for a git checkout.

`codex-review` compares your current work against a base ref, loads repo context like `AGENTS.md` and `.codex/reviewer.yml`, and produces a local review report before you open a pull request.

## Install

```bash
npm install
```

## Usage

```bash
node bin/review.js --base origin/main
```

Useful variants:

```bash
node bin/review.js --staged
node bin/review.js --engine codex
node bin/review.js --engine heuristic
node bin/review.js --mode security
node bin/review.js --model gpt-5.4
node bin/review.js --format markdown --report codex-review.md
node bin/review.js --fail-on important
```

After local install:

```bash
codex-review --base origin/main
```

## Repo Config

You can tune defaults with `.codex/reviewer.yml` in the target repository:

```yaml
mode: full
engine: auto
max_findings: 12
focus_areas:
  - security
  - regression
  - compatibility
paths:
  ignore:
    - dist/**
    - vendor/**
  high_risk:
    - app/Http/**
    - app/Services/**
notes:
  - Payments changes must be checked for subscription regressions.
```

CLI flags override config values.

## Engines

- `auto`: prefer Codex, fall back to heuristics on failure
- `codex`: require a Codex-backed review run
- `heuristic`: run only local heuristic checks

## Scope

The reviewer is optimized for local developer use:

- branch-vs-base review
- staged-only review
- repo-context loading
- WordPress-oriented heuristics
- text, markdown, and JSON outputs

See [CODEX_REVIEWER_PLAN.md](./CODEX_REVIEWER_PLAN.md) for the fuller product direction.
