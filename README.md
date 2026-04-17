# Codex Review

Internal pre-PR reviewer for WPManageNinja repositories.

`codex-review` is meant to be installed once on a developer machine and then run locally inside any supported WPManageNinja repo before pushing code or opening a pull request.

It is optimized for WPManageNinja product workflows, not for public general-purpose use.

## Who Should Use This

WPManageNinja developers working on:

- `fluentform`
- `fluentformpro`
- `fluent-conversational-js`
- `fluentforms-pdf`
- `multilingual-forms-fluent-forms-wpml`
- `fluentform-signature`
- `fluent-player`
- `fluent-player-pro`

## What It Does

`codex-review` reviews your local branch or worktree against a base branch and produces a report designed to catch the kinds of regressions that matter in WPManageNinja products.

It combines:

- heuristic review for fast local product-aware checks
- Codex-backed review for deeper reasoning over the most relevant changed files
- recheck-aware output so a second run after fixes behaves like a follow-up review, not a fresh scan

The report includes:

- summary
- merge stance
- confidence score
- key changes
- findings
- outside-diff follow-ups
- prompt to fix each finding
- prompt to fix all findings
- recheck status against the previous local review

## Supported Product Awareness

The reviewer now applies repo-specific rules for WPManageNinja products.

Examples:

- `fluentform`
  checks upload/crop settings producers, save-time settings persistence, and form-setting round-trips
- `fluentformpro`
  checks payment processor changes, product-specific verification gaps, Pro uploader/bootstrap wiring, and shared image-flow risks
- `fluent-conversational-js`
  checks crop modal lifecycle and async image-load race conditions
- `fluentforms-pdf`
  checks template/data-map mismatches and PDF output verification gaps
- `multilingual-forms-fluent-forms-wpml`
  checks WPML package/string registration risks
- `fluentform-signature`
  checks signature payload-format and draw/save/render workflow risks
- `fluent-player`
  checks player config/bootstrap/playback verification gaps
- `fluent-player-pro`
  checks Pro player config plus shared free/pro compatibility risks

## Requirements

- Node.js 18+
- `git`
- Codex CLI installed and authenticated if you want model-backed review

Heuristic mode works without Codex CLI, but the recommended team workflow is to use the Codex engine.

## Team Installation

Each WPManageNinja developer should do this once on their machine.

### 1. Clone the repo

```bash
git clone https://github.com/dhrupo/codex-review.git
cd codex-review
```

### 2. Install dependencies

```bash
npm install
```

### 3. Link the command globally

```bash
npm link
```

Now this should work from any supported repo:

```bash
codex-review --help
```

### 4. Confirm Codex CLI is installed

```bash
codex --help
```

If Codex CLI is not available yet, developers can still use:

```bash
codex-review --engine heuristic
```

For a shorter setup checklist, see [SETUP.md](./SETUP.md).

## First Run

Go into the target repository and run:

```bash
codex-review --base origin/dev --engine codex --thorough
```

Example:

```bash
cd /path/to/fluentformpro
codex-review --base origin/dev --engine codex --thorough
```

Recommended default for most WPManageNinja repos:

- base: `origin/dev`
- engine: `codex`
- depth: `--thorough`

## Recommended WPManageNinja Workflow

Use this before asking for review or opening a PR.

1. Make your code changes.
2. Run:

```bash
codex-review --base origin/dev --engine codex --thorough
```

3. Fix the findings.
4. Commit your changes.
5. Run the same command again.
6. Read the recheck section:
   - cleared findings
   - still-present findings
   - newly introduced findings
7. When the report is clean enough, push and open/update the PR.

This mirrors the same workflow you already use with PR bots, but locally before the PR.

## Common Commands

Basic review:

```bash
codex-review --base origin/dev
```

Codex-backed review:

```bash
codex-review --base origin/dev --engine codex
```

Thorough review:

```bash
codex-review --base origin/dev --engine codex --thorough
```

Fast heuristic pass:

```bash
codex-review --base origin/dev --engine heuristic
```

Review only staged changes:

```bash
codex-review --staged --engine codex
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

## When Developers Should Run It

Run it before PR for any meaningful change.

Especially important for:

- payment and subscription logic
- route, AJAX, REST, nonce, or capability changes
- settings persistence and sanitization changes
- uploader, crop, export, PDF, or attachment flows
- multilingual/WPML mapping changes
- signature capture or render changes
- player config/bootstrap/playback changes

## Understanding The Report

The report is not just a pass/fail output.

Important sections:

- `Summary`
  quick top-level judgment
- `Merge stance`
  `APPROVE`, `COMMENT`, or `REQUEST_CHANGES`
- `Confidence score`
  calibrated to behave similarly to the current WPManageNinja PR bot pattern
- `Key Changes`
  what looks correct or intentional in the patch
- `Findings`
  actionable issues in the changed code
- `Outside Diff Follow-ups`
  closely related issues that may live outside the current diff
- `Recheck Status`
  what cleared, what remains, what is new

## Confidence Score Meaning

The confidence score is intentionally calibrated to feel similar to the existing review bot behavior in Fluent Forms repos.

- `3/5`
  the common case; reviewed code with some issues or meaningful caution
- `4/5`
  clean review with no meaningful issues, but not an extremely narrow trivial change
- `5/5`
  rare; very narrow and clean change with strong confidence
- `2/5`
  indicates significantly worse review health

Do not read `3/5` as “bad.” In this workflow it is often the normal score.

## Recheck Behavior

`codex-review` stores previous review state locally so the next run can behave like a follow-up review.

State location:

```bash
~/.codex/codex-review/state/
```

That lets the tool report:

- cleared findings
- still-present findings
- new findings introduced since the previous run

This is especially useful after:

- fixing issues
- making a new commit
- running review again before re-requesting PR review

## Repo Config

Each target repo can include `.codex/reviewer.yml` for local defaults.

Start from:

- [`.codex/reviewer.yml.example`](./.codex/reviewer.yml.example)

Typical usage:

```bash
mkdir -p .codex
cp /path/to/codex-review/.codex/reviewer.yml.example .codex/reviewer.yml
```

For most WPManageNinja repos, the main useful defaults are:

- `base: origin/dev`
- `engine: codex`
- `review_depth: thorough`

## Base Branch Behavior

If `--base` is not provided, the tool prefers:

1. repo config `base`
2. `origin/dev`
3. `origin/development`
4. `origin/main`
5. `origin/master`

For WPManageNinja product repos, `origin/dev` is usually correct.

## Engine Modes

- `auto`
  prefer Codex, fall back to heuristics
- `codex`
  require Codex review
- `heuristic`
  local checks only

Recommended team default:

```bash
codex-review --base origin/dev --engine codex --thorough
```

## Output Formats

Text output is the normal default.

Markdown output is useful for sharing:

```bash
codex-review --base origin/dev --engine codex --format markdown --report codex-review.md
```

JSON output is useful for automation or experiments:

```bash
codex-review --base origin/dev --format json
```

## Team Recommendation

For WPManageNinja developers, the easiest adoption path is:

1. install once with `npm link`
2. keep `codex-review` updated with `git pull`
3. run it locally before PRs
4. rerun after fixes until the recheck report looks acceptable

That gives the team a local reviewer that behaves much closer to your PR bot workflow, but catches issues before the PR is opened.
