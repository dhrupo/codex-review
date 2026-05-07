# Codex Review Docs

Back to the short entry point: [README.md](./README.md)

## Overview

`codex-review` is a local pre-PR reviewer for WPManageNinja WordPress plugin repositories.

It is maintained in this repo and is meant to read like a concise PR review, not a raw linter dump.

## Two Normal Commands

```bash
codex-review
```

```bash
codex-review > pr-review.md
```

Use the first command when you want the review in the terminal. Use the second when you want the same output captured in a Markdown file.

That is the main workflow. The docs below only explain how that command behaves and where to tweak it when needed.

## What The Default Run Does

By default, `codex-review` tries to:

- review the current diff against the configured base branch
- print PR-review style output to stdout
- use Codex for deeper review when available
- use `code-review-graph` for impact scoping on every diff review
- fall back to local review logic when Codex is unavailable or fails
- include extra configured checks when the repo enables them

Internally, the tool may still use multiple passes and optional helper stages, but you should not need extra commands for normal use.

## Output Shape

The normal output is intentionally short:

- `Summary`
- `Key changes`
- `Findings`
- `Confidence Score`
- merge stance

If you run `--format json`, the report now includes an `issueTracking` section designed for universal issue ingestion. Each exported finding carries a stable ID, dedupe key, category, severity, confidence, origin, fix hint, and re-review status.

## Installation

```bash
git clone https://github.com/dhrupo/codex-review.git
cd codex-review
npm install
npm link
```

Recommended:

```bash
npm run install:graph
```

`code-review-graph` is required. The install command provisions it in a repo-local virtualenv so linked `codex-review` runs can always find the same CLI.

## Recommended Workflow

1. Make your code changes.
2. Run `codex-review`.
3. Fix the findings.
4. Commit the fix.
5. Run `codex-review` again.
6. If you need to share or keep the result, run `codex-review > pr-review.md`.

The follow-up run is intended to behave like a re-review, not a brand-new review.

## Score Meaning

- `5/5`: very narrow clean diff, safe to merge
- `4/5`: clean review, safe to merge
- `3/5`: not safe to merge; changes still need review fixes
- `2/5`: major issues

## Repo Config

Each target repo can include `.codex/reviewer.yml`.

Start from:

- [`.codex/reviewer.yml.example`](./.codex/reviewer.yml.example)

Typical bootstrap:

```bash
mkdir -p .codex
cp /path/to/codex-review/.codex/reviewer.yml.example .codex/reviewer.yml
```

Useful config areas:

- `base`
- `code_review_graph`
- `accessibility`

Example:

```yaml
base: origin/dev

code_review_graph:
  enabled: true
  timeout_ms: 120000

accessibility:
  urls:
    - https://forms.test/wp-admin/admin.php?page=fluent_forms
  timeout_ms: 30000
```

## Compact Advanced Notes

- If Codex CLI is unavailable, `codex-review` can still fall back to heuristic review.
- If you want to force local-only review, `--engine heuristic` is the main escape hatch.
- If you want to change the base branch, set `base` in `.codex/reviewer.yml` or pass `--base`.
- If you need machine-readable output, `--format json` exists, but it is not the normal day-to-day mode.
- If `code-review-graph` is missing or broken, rerun `npm run install:graph` in the `codex-review` checkout before reviewing again.

## Re-Review State

Local state is stored in:

```bash
~/.codex/codex-review/state/
```

This lets later runs compare what was cleared, what remains, and what is newly introduced.

Re-review memory now also tracks:

- unchanged findings
- findings that moved with the code path
- partially addressed findings
- regressions that were previously cleared and later reintroduced

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
