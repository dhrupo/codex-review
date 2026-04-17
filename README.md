# Codex Review

Internal pre-PR reviewer for WPManageNinja repositories.

`codex-review` compares your current work against a base ref, loads repo context like `AGENTS.md` and `.codex/reviewer.yml`, and produces a local review report before you open a pull request.

This tool is intentionally tuned for WPManageNinja engineering workflows:

- WordPress plugin repositories
- payment and subscription code paths
- REST/AJAX handlers
- settings, meta, and data-shape regressions
- nonce, capability, and sanitization issues

It is not meant to be a polished public general-purpose reviewer.

## Install

```bash
npm install
```

For local shell usage during development:

```bash
npm link
```

## Usage

```bash
node bin/review.js --base origin/dev
```

Useful variants:

```bash
node bin/review.js --staged
node bin/review.js --engine codex
node bin/review.js --engine heuristic
node bin/review.js --base origin/dev --engine codex --thorough
node bin/review.js --mode security
node bin/review.js --model gpt-5.4
node bin/review.js --format markdown --report codex-review.md
node bin/review.js --fail-on important
```

After local install:

```bash
codex-review --base origin/dev
```

## Recommended WPManageNinja Workflow

For Fluent Forms / Fluent Forms Pro style repos:

```bash
codex-review --base origin/dev --engine codex --thorough
```

For a faster first pass:

```bash
codex-review --base origin/dev --engine heuristic
```

Good use cases:

- before commit when touching payment logic
- before push when changing auth, nonce, or capability paths
- before PR when changing settings/data persistence or integrations

## Repo Config

You can tune defaults with `.codex/reviewer.yml` in the target repository:

```yaml
mode: full
engine: auto
base: origin/dev
review_depth: balanced
max_findings: 12
focus_areas:
  - security
  - regression
  - compatibility
paths:
  ignore:
    - dist/**
    - vendor/**
    - builds/**
  high_risk:
    - app/Http/**
    - app/Services/**
    - src/Payments/**
    - src/Integrations/**
notes:
  - Payments changes must be checked for subscription regressions.
```

CLI flags override config values.

## Engines

- `auto`: prefer Codex, fall back to heuristics on failure
- `codex`: require a Codex-backed review run
- `heuristic`: run only local heuristic checks

## Base Selection

If no `--base` is passed, the reviewer now prefers:

1. repo config `base`
2. `origin/dev`
3. `origin/development`
4. `origin/main`
5. `origin/master`

## Review Depth

- `balanced`: narrower Codex scope for faster reviews
- `thorough`: broader Codex scope for slower but deeper pre-PR review

## Scope

The reviewer is optimized for local developer use:

- branch-vs-base review
- staged-only review
- repo-context loading
- WPManageNinja / WordPress-oriented heuristics
- text, markdown, and JSON outputs

See [CODEX_REVIEWER_PLAN.md](./CODEX_REVIEWER_PLAN.md) for the fuller product direction.
