# Codex Review Docs

Back to the short entry point: [README.md](./README.md)

## Overview

`codex-review` is a local pre-PR reviewer for WPManageNinja WordPress plugin repositories.

It is a custom local reviewer maintained in this repo. It is not an official Codex review library.

It combines:

- heuristic review for fast local checks
- Codex CLI-backed review for deeper reasoning
- optional Semgrep, PHPStan, and ESLint stages
- optional Playwright + axe rendered accessibility checks
- re-review state so a later run after fix commits behaves like a follow-up review

## Default Command

```bash
codex-review
```

Default behavior:

- thorough review depth
- PR-review output format
- Codex review when available
- heuristic fallback when Codex is unavailable or fails
- extra static/runtime stages when available and enabled

## Installation

```bash
git clone https://github.com/dhrupo/codex-review.git
cd codex-review
npm install
npm link
```

Confirm:

```bash
codex-review --help
codex --help
```

If Codex CLI is unavailable, you can still use:

```bash
codex-review --engine heuristic
```

## Recommended Workflow

1. Make your code changes.
2. Run `codex-review`.
3. Fix the findings.
4. Commit the fix.
5. Run `codex-review` again.
6. Expect the second run to show only remaining blockers or mark the diff safe to merge.

## Score Meaning

- `5/5`: very narrow clean diff, safe to merge
- `4/5`: clean review, safe to merge
- `3/5`: not safe to merge; changes still need review fixes
- `2/5`: major issues

## Default Output

The normal output is intentionally PR-like:

- `Summary`
- `Key changes`
- `Findings`
- `Confidence Score`
- merge stance

This is the intended day-to-day format.

## Useful Commands

Base review against a specific branch:

```bash
codex-review --base origin/dev
```

Heuristic-only review:

```bash
codex-review --engine heuristic
```

Markdown report:

```bash
codex-review --format markdown --report codex-review.md
```

JSON report:

```bash
codex-review --format json
```

Review staged changes only:

```bash
codex-review --staged
```

Review only specific files:

```bash
codex-review --files app/Http/Routes/api.php,app/Services/Form/Updater.php
```

Rendered accessibility scan:

```bash
codex-review --mode accessibility \
  --a11y-url https://forms.test/wp-admin/admin.php?page=fluent_forms \
  --a11y-storage-state .playwright/auth.json
```

## Repo Config

Each target repo can include `.codex/reviewer.yml`.

Start from:

- [`.codex/reviewer.yml.example`](./.codex/reviewer.yml.example)

Typical bootstrap:

```bash
mkdir -p .codex
cp /path/to/codex-review/.codex/reviewer.yml.example .codex/reviewer.yml
```

Important config areas:

- `base`
- `engine`
- `review_depth`
- `focus_areas`
- `critical_paths`
- `review_signals`
- `context_files`
- `context_rules`
- `paths.high_risk`
- `edge_cases`
- `accessibility`
- `codex.focus_paths`

Example:

```yaml
base: origin/dev
engine: codex
review_depth: thorough

focus_areas:
  - lifecycle
  - performance
  - persistence
  - accessibility

critical_paths:
  - route or ajax entry -> capability or nonce -> sanitizer -> persistence -> reload -> render
  - admin editor change -> save -> sanitize -> load -> frontend bootstrap or runtime

review_signals:
  lifecycle:
    - mounted, reset, teardown, reopen, async completion
  performance:
    - repeated find/includes, duplicate fetches, repeated DOM queries

context_files:
  - app/Services/Form/Updater.php
  - app/Helpers/Helper.php

context_rules:
  - when:
      - resources/assets/**
    include:
      - app/Services/Form/Updater.php
      - app/Helpers/Helper.php
    reason: UI changes often depend on unchanged sanitizers and validators.

paths:
  high_risk:
    - app/Http/**
    - app/Services/**
    - resources/assets/**

edge_cases:
  lifecycle:
    - Recheck setup, reset, success, teardown, and reopen paths when stateful UI helpers change.
  performance:
    - Recheck hot paths for repeated find/includes scans, duplicate fetches, repeated DOM queries, and full-list class resets.

accessibility:
  urls:
    - https://forms.test/wp-admin/admin.php?page=fluent_forms
  timeout_ms: 30000

codex:
  focus_paths:
    - app/Http/**
    - app/Services/**
    - resources/assets/**
```

## How The Pipeline Works

- repo-local config is loaded from `.codex/reviewer.yml`
- local git diff is computed once
- a heuristic seed runs first
- Codex deep review scope is selected from the changed files
- Semgrep, PHPStan, ESLint, and rendered accessibility can run alongside the main review
- final findings are merged into one report
- previous local review state is used for follow-up comparison

## Timeout Behavior

Codex has no default timeout now.

If you want one, set it explicitly:

```yaml
codex:
  timeout_ms: 900000
```

Semgrep, PHPStan, ESLint, and accessibility stages still support their own timeouts through config.

## Advanced Workflows

These still exist, but they are optional:

Debugger workflow:

```bash
codex-review --workflow debugger
```

Plugin-audit workflow:

```bash
codex-review --workflow plugin-audit
```

Use them when you want longer structured reports instead of the default PR-review format.

## Engine Modes

- `auto`: prefer Codex, fall back when needed
- `codex`: require Codex
- `heuristic`: local checks only

## Output Formats

- `pr-review`: default concise PR-style format
- `text`
- `markdown`
- `github`
- `json`
- `rdjson`

## Re-Review State

State is stored locally in:

```bash
~/.codex/codex-review/state/
```

This is used so a later run can report:

- cleared findings
- remaining findings
- newly introduced findings

The comparison is only used for compatible runs, so unrelated workflow/scope changes do not get mixed into follow-up reviews.

## Supported WPManageNinja Repos

Common targets:

- `fluentform`
- `fluentformpro`
- `fluent-conversational-js`
- `fluentforms-pdf`
- `multilingual-forms-fluent-forms-wpml`
- `fluentform-signature`
- `fluent-player`
- `fluent-player-pro`

Repo-specific behavior should live in each plugin’s `.codex/reviewer.yml`.

## Team Recommendation

For most developers:

1. install once with `npm link`
2. keep the repo updated
3. run `codex-review` before opening or updating a PR
4. rerun it after fixes until the follow-up review is clean enough
