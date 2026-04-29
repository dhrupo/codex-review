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
- WordPress-plugin-specific checks for permission, persistence, public endpoint, and accessibility regressions
- optional Playwright + axe scans against rendered plugin/admin URLs for dynamic accessibility issues
- recheck-aware output so a second run after fixes behaves like a follow-up review, not a fresh scan

The report includes:

- summary
- merge stance
- confidence score
- table of contents for confirmed findings
- key changes
- confirmed findings grouped by severity
- needs manual verification follow-ups
- prioritized fix backlog
- prompt to fix each finding
- prompt to fix all findings
- recheck status against the previous local review

## Supported Product Awareness

The reviewer now applies repo-specific rules for WPManageNinja products.
Its rendered review output also follows the evidence-first WPManageNinja `agent-skills` review shape rather than a flat lint-style report.

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
  checks Pro player config, subtitle-service sanitization and payload limits, managed attachment deletion, and shared free/pro compatibility risks

For repos that are not hardcoded yet, such as `fluent-cart` or `fluent-crm`, you can calibrate the reviewer locally with `.codex/reviewer.yml`.

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

## Canonical Commands

Use these first. Everything else is override detail.

Standard local pre-PR review:

```bash
codex-review
```

Debugger-style bug sweep:

```bash
codex-review --workflow debugger
```

Plugin-audit-style deep review:

```bash
codex-review --workflow plugin-audit
```

What those workflow presets do:

- `--workflow debugger`
  runs a local Finder -> Verifier -> Feedback style bug sweep and writes `debugger-report.md` by default
- `--workflow plugin-audit`
  runs a broader five-workstream audit plus verification pass and writes `plugin-audit.md` by default
- both presets switch to markdown output and thorough review depth unless you explicitly override them

Rendered accessibility review using repo-local defaults:

```bash
codex-review --mode accessibility --engine codex
```

## More Examples

Base review against a specific branch:

```bash
codex-review --base origin/dev
```

Codex-backed review:

```bash
codex-review --base origin/dev --engine codex
```

Fast heuristic pass:

```bash
codex-review --base origin/dev --engine heuristic
```

Rendered accessibility scan:

```bash
codex-review --mode accessibility \
  --a11y-url https://forms.test/wp-admin/admin.php?page=fluent_forms \
  --a11y-url https://forms.test/wp-admin/admin.php?page=fluent_forms_settings \
  --a11y-storage-state .playwright/auth.json
```

Rendered accessibility scan with repo-local defaults:

```bash
codex-review --mode accessibility --engine codex
```

Review only staged changes:

```bash
codex-review --staged --engine codex
```

Write a custom markdown report:

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
- frontend form, modal, block, or settings UI changes that can affect keyboard or screen-reader accessibility

## Understanding The Report

The report is not just a pass/fail output.

Important sections:

- `Summary`
  quick top-level judgment
- `Merge stance`
  `APPROVE`, `COMMENT`, or `REQUEST_CHANGES`
- `Confidence score`
  calibrated to behave similarly to the current WPManageNinja PR bot pattern
- `Table of Contents`
  anchors each confirmed finding for faster navigation
- `Key Changes`
  what looks correct or intentional in the patch
- `Confirmed Findings By Severity`
  evidence-backed issues grouped as critical, important, medium, and low
- `Needs Manual Verification`
  closely related follow-ups that should be checked before merge or in adjacent files
- `Prioritized Fix Backlog`
  implementation-ready fix directions ordered by review priority
- `Rendered Accessibility Scan`
  URLs scanned with Playwright + axe and their violation counts
- `Recheck Status`
  what cleared, what remains, what is new

## Confidence Score Meaning

The confidence score is intentionally calibrated to feel similar to the existing review bot behavior in Fluent Forms repos.

- `5/5`
  very narrow clean change; safe to merge based on the reviewed diff
- `3/5`
  there are some issues or meaningful cautions to resolve before merge
- `4/5`
  clean review with no meaningful issues; safe to merge
- `2/5`
  major issues or blocker-level review health problems

Workflow reports use the same meaning:

- `4/5` and `5/5` mean the reviewed diff is safe to merge
- `3/5` means there are issues to address
- `2/5` means the review found major problems

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

You can also preconfigure rendered accessibility scan targets there:

```yaml
accessibility:
  urls:
    - https://forms.test/wp-admin/admin.php?page=fluent_forms
    - https://forms.test/wp-admin/admin.php?page=fluent_forms_settings
  wait_for: .ff_form_wrap
  timeout_ms: 30000
  storage_state: .playwright/auth.json
```

## Plugin Repo Workflow

This tool is meant to be installed once and then run from inside a plugin repo.

Standard review:

```bash
cd /Volumes/Projects/forms/wp-content/plugins/fluent-player-pro
codex-review
```

Debugger workflow:

```bash
cd /Volumes/Projects/forms/wp-content/plugins/fluent-player-pro
codex-review --workflow debugger
```

Plugin audit workflow:

```bash
cd /Volumes/Projects/forms/wp-content/plugins/fluent-player-pro
codex-review --workflow plugin-audit
```

For rendered accessibility checks:

```bash
cd /Volumes/Projects/forms/wp-content/plugins/fluentform
codex-review --mode accessibility --engine codex
```

How it works:

- it detects the current git repo and applies any built-in product profile for that repo
- it loads repo-local defaults from `.codex/reviewer.yml` if present
- CLI flags override repo-local config when both are supplied
- `--workflow debugger` auto-switches to the debugger preset and writes `debugger-report.md`
- `--workflow plugin-audit` auto-switches to the deeper audit preset and writes `plugin-audit.md`
- the debugger workflow emulates `Finder -> Verifier -> Feedback` sequentially in one local run when no literal sub-agents are used
- the plugin-audit workflow emulates the five audit workstreams plus a final verification pass sequentially in one local run
- heuristic and Codex review use the repo profile plus local `focus_areas`, `paths.high_risk`, and `notes`
- rendered accessibility scanning runs only when `accessibility.urls` are configured in `.codex/reviewer.yml` or when `--a11y-url` / `--a11y-urls` are passed explicitly

That means plugin-specific `.codex/reviewer.yml` files are the right place to store:

- high-risk directories for that repo
- repeated regression reminders for that plugin
- default admin/frontend URLs for Playwright + axe scans
- storage-state paths for authenticated wp-admin scans

For workflow reports:

- `debugger-report.md` keeps confirmed bugs, rejected candidates, manual-verification items, and feedback-loop updates
- `plugin-audit.md` keeps severity-grouped findings, a prioritized implementation backlog, and manual-verification items
- if `plugin-audit.md` already exists, the CLI archives it to `plugin-audit-YYYY-MM-DD.md` before overwriting

For most WPManageNinja repos, the main useful defaults are:

- `base: origin/dev`
- `engine: codex`
- `review_depth: thorough`

You can also define a repo-specific product profile there. This is the calibration path for teams working on repos that are not built into `codex-review` yet.

Example for a repo like `fluent-cart`:

```yaml
base: origin/dev
engine: codex
review_depth: thorough
product_profile:
  name: Fluent Cart
  focus:
    - checkout, cart totals, coupon, and order-state regressions
    - payment callback, webhook, and persisted order amount consistency
    - frontend cart config and API payload compatibility
  regression_checks:
    - checkout changes must preserve totals, discounts, taxes, and final persisted order values
    - payment/webhook changes must be checked against success, failure, retry, and duplicate-callback paths
    - cart or checkout UI changes must keep frontend payloads aligned with backend validation
focus_areas:
  - payments
  - checkout
  - persistence
paths:
  high_risk:
    - src/Payments/**
    - src/Checkout/**
    - src/Orders/**
    - app/Http/**
notes:
  - Checkout and payment changes should be verified with coupon, tax, and retry scenarios.
```

Example for a repo like `fluent-crm`:

```yaml
base: origin/dev
engine: codex
review_depth: thorough
product_profile:
  name: FluentCRM
  focus:
    - contact sync, automation state, and campaign/event regressions
    - segment/filter logic, background jobs, and idempotent processing
    - email or workflow config round-trips between UI, API, and persistence
  regression_checks:
    - automation changes must preserve re-entry, retry, and duplicate-processing behavior
    - contact or segment changes must be checked against query filters and background sync paths
    - campaign or email config changes must survive save/load and scheduled execution
focus_areas:
  - automation
  - background-jobs
  - persistence
paths:
  high_risk:
    - app/Services/**
    - app/Http/**
    - app/Models/**
    - app/Hooks/**
notes:
  - Automation changes should be reviewed for duplicate processing and scheduler/idempotency risks.
```

That lets each WPManageNinja team tune review priorities in their own repo without waiting for a codex-review release.

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
