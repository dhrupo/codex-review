# Codex Review

Internal pre-PR reviewer for WPManageNinja repositories.

`codex-review` is meant to be run locally by developers before pushing code or opening a pull request. It compares your current branch or working tree against a base branch, loads repo context, and produces a review report focused on the kinds of issues that matter most in WPManageNinja codebases.

This tool is intentionally optimized for:

- WordPress plugin repositories
- payment and subscription code paths
- REST and AJAX handlers
- settings, options, post meta, and data-shape regressions
- nonce, capability, sanitization, and escaping issues
- pre-PR review on repositories like Fluent Forms and Fluent Forms Pro

It is not intended to be a polished public general-purpose reviewer.

## What It Does

`codex-review` has two review layers:

1. Heuristic review
   Fast local checks for common WordPress and WPManageNinja risks.
2. Codex review
   A deeper model-backed pass over the most relevant files in the current diff.

You can run either engine directly, or use `auto` mode to prefer Codex and fall back to heuristics if Codex is unavailable or fails.

## Requirements

- Node.js 18+
- `git`
- Codex CLI installed and authenticated if you want the Codex-backed review path

Heuristic-only review works without Codex CLI.

## Installation

### Option 1: Local clone for development

```bash
git clone https://github.com/dhrupo/codex-review.git
cd codex-review
npm install
```

Run directly:

```bash
node bin/review.js --help
```

### Option 2: Link globally on your machine

From inside the cloned `codex-review` repository:

```bash
npm install
npm link
```

Then you can run:

```bash
codex-review --help
```

Recommended for WPManageNinja dev machines.

If you want the shortest teammate onboarding path, use [SETUP.md](./SETUP.md).

## Quick Start

Go to the target plugin repository, then run:

```bash
codex-review --base origin/dev --engine codex --thorough
```

Example:

```bash
cd /path/to/fluentformpro
codex-review --base origin/dev --engine codex --thorough
```

If you want a faster first pass:

```bash
codex-review --base origin/dev --engine heuristic
```

If you only want to review staged changes:

```bash
codex-review --staged --engine codex
```

## Recommended WPManageNinja Workflow

### For Fluent Forms / Fluent Forms Pro style repos

Use this before opening a PR:

```bash
codex-review --base origin/dev --engine codex --thorough
```

Use this for a quick first pass while still coding:

```bash
codex-review --base origin/dev --engine heuristic
```

### When to run it

- before commit when touching payment logic
- before push when changing auth, nonce, capability, or route logic
- before PR when changing settings, persistence, integrations, exports, or payment flows

### Practical guidance

- Use `origin/dev` as the base for WPManageNinja repos unless that repo has a different integration branch.
- Use `--thorough` for payment, subscription, webhook, and security-sensitive changes.
- Use `--report` if you want a markdown artifact you can attach to task notes or share with teammates.

## Common Commands

Basic local review:

```bash
codex-review --base origin/dev
```

Force Codex-backed review:

```bash
codex-review --base origin/dev --engine codex
```

Heuristic-only review:

```bash
codex-review --base origin/dev --engine heuristic
```

Thorough Codex review:

```bash
codex-review --base origin/dev --engine codex --thorough
```

Security-focused pass:

```bash
codex-review --base origin/dev --mode security --engine codex
```

Write a markdown report:

```bash
codex-review --base origin/dev --engine codex --format markdown --report codex-review.md
```

Fail non-zero on medium or higher findings:

```bash
codex-review --base origin/dev --fail-on medium
```

Review only specific files:

```bash
codex-review --base origin/dev --files src/Payments/AjaxEndpoints.php,src/Payments/PaymentMethods/RazorPay/RazorPayProcessor.php
```

## Output Formats

### Text

Default terminal output. Good for normal local use.

### Markdown

Useful when you want a report artifact:

```bash
codex-review --base origin/dev --format markdown --report codex-review.md
```

### JSON

Useful for automation, experimentation, or comparing outputs:

```bash
codex-review --base origin/dev --format json
```

## How To Read The Result

The report includes:

- `verdict`
- `confidence`
- `baseRef`
- `mode`
- `reviewDepth`
- `engine`
- `summary`
- `findings`

If Codex scope is narrowed for prompt-size control, the report also shows:

- full changed file scope
- `codexReviewedFiles` for the deep-review subset

This is expected behavior on larger branches.

## Engines

- `auto`
  Prefer Codex, fall back to heuristics on failure.
- `codex`
  Require a Codex-backed review.
- `heuristic`
  Run only local heuristic checks.

## Review Depth

- `balanced`
  Narrower Codex scope for faster reviews.
- `thorough`
  Broader Codex scope for slower but deeper pre-PR review.

Use `--thorough` for:

- payment changes
- webhook verification changes
- auth/capability changes
- settings persistence changes
- security-sensitive fixes

## Base Selection

If no `--base` is passed, the reviewer prefers:

1. repo config `base`
2. `origin/dev`
3. `origin/development`
4. `origin/main`
5. `origin/master`

For WPManageNinja repos, `origin/dev` is typically the correct default.

## Repo Config

You can tune defaults with `.codex/reviewer.yml` inside the target repository.

You can start by copying [`.codex/reviewer.yml.example`](./.codex/reviewer.yml.example).

Example:

```yaml
base: origin/dev
mode: full
engine: auto
review_depth: balanced
max_findings: 12
focus_areas:
  - security
  - regression
  - compatibility
  - payments
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
  - Webhook changes should be reviewed with strict verification expectations.
```

CLI flags override config values.

## Recommended Config For Fluent Forms Pro

```yaml
base: origin/dev
engine: auto
review_depth: thorough
max_findings: 12
focus_areas:
  - security
  - payments
  - regression
paths:
  ignore:
    - public/mix-manifest.json
    - builds/**
    - vendor/**
  high_risk:
    - src/Payments/**
    - src/Integrations/**
    - src/classes/**
notes:
  - Payment path changes should include verification for strict and non-strict flows.
```

## Current Limitations

- Large diffs may force Codex review to focus on a narrowed subset of files.
- Heuristic mode is intentionally WordPress/WPManageNinja biased and can be noisy outside that context.
- The tool does not post to GitHub. It is strictly a local pre-PR review tool.

## Troubleshooting

### Codex review does not run

Check:

- Codex CLI is installed
- Codex CLI is authenticated
- you are inside a git repository

If needed, force heuristic mode:

```bash
codex-review --engine heuristic
```

### Review is using the wrong base branch

Pass the base explicitly:

```bash
codex-review --base origin/dev
```

Or set it in `.codex/reviewer.yml`.

### Review is too broad or too slow

Use:

- `--engine heuristic` for a fast pass
- `--files ...` to constrain scope
- repo config `paths.ignore` to skip generated artifacts

## Internal Notes

This repository is meant for WPManageNinja internal use. The intended usage model is:

- clone privately
- `npm install`
- `npm link`
- run `codex-review` inside WPManageNinja repos

See [CODEX_REVIEWER_PLAN.md](./CODEX_REVIEWER_PLAN.md) for the broader implementation direction.
