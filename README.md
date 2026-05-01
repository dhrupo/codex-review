# Codex Review

Local pre-PR reviewer for WPManageNinja WordPress plugin repositories.

`codex-review` is a custom wrapper around local heuristics, Codex CLI, and optional static/runtime checks. It is designed to behave like a concise PR review before you open or update the PR.

Full documentation: [docs.md](./docs.md)  
Setup guide: [SETUP.md](./SETUP.md)

## What To Run

```bash
codex-review
```

That is the normal command now. It defaults to:

- thorough review depth
- PR-review style output
- Codex review when available
- heuristic fallback when Codex is unavailable or fails
- Semgrep, PHPStan, ESLint, and rendered accessibility checks when enabled/configured

## Install

```bash
git clone https://github.com/dhrupo/codex-review.git
cd codex-review
npm install
npm link
```

Then from any supported repo:

```bash
codex-review
```

## Daily Workflow

1. Make your code changes.
2. Run `codex-review`.
3. Fix the findings.
4. Commit.
5. Run `codex-review` again.
6. Read the follow-up review.

The second run is meant to behave like a re-review after fix commits: only the remaining blockers should stay visible, or the diff should be marked safe to merge.

## Score Meaning

- `5/5` or `4/5`: safe to merge
- `3/5`: issues remain
- `2/5`: major issues

## Output Shape

The default output is intentionally short and PR-like:

- `Summary`
- `Key changes`
- `Findings`
- `Confidence Score`
- merge stance

## Repo Config

Each target repo can define local defaults in `.codex/reviewer.yml`.

Start from:

- [`.codex/reviewer.yml.example`](./.codex/reviewer.yml.example)

Repo-local config is where you tune:

- base branch
- accessibility URLs
- high-risk paths
- critical paths
- context files/rules
- lifecycle/performance/persistence/security/accessibility review guidance

## Supported Repos

Typical WPManageNinja repos include:

- `fluentform`
- `fluentformpro`
- `fluent-conversational-js`
- `fluentforms-pdf`
- `multilingual-forms-fluent-forms-wpml`
- `fluentform-signature`
- `fluent-player`
- `fluent-player-pro`

## Advanced Use

Most users should stop at `codex-review`.

If you need the full reference, examples, config guide, output details, advanced workflows, and architecture notes, use [docs.md](./docs.md).
