# Codex Review

Local pre-PR reviewer for WPManageNinja WordPress plugin repositories.

`codex-review` is a local reviewer that prints a concise PR-style review before you open or update a pull request.

Full documentation: [docs.md](./docs.md)  
Setup guide: [SETUP.md](./SETUP.md)

## Normal Use

```bash
codex-review
```

If you want the same review saved to a file:

```bash
codex-review > pr-review.md
```

That is the intended day-to-day workflow.

By default, `codex-review` aims to:

- review the current diff against the repo base branch
- print PR-review style output to stdout
- use Codex when available
- fall back safely when Codex is unavailable
- use `code-review-graph` for file impact and scoping on every review

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

Install the required graph companion once in the `codex-review` checkout:

```bash
npm run install:graph
```

## Daily Workflow

1. Make your code changes.
2. Run `codex-review`.
3. Fix the findings.
4. Commit.
5. Run `codex-review` again or save it with `codex-review > pr-review.md`.

The follow-up run is meant to behave like a re-review: remaining blockers stay visible, cleared findings drop out, and clean diffs should read as safe to merge.

## Score Meaning

- `5/5` or `4/5`: safe to merge
- `3/5`: not safe to merge; changes still need review fixes
- `2/5`: major issues

## Output Shape

The default output is intentionally short and PR-like:

- `Summary`
- `Key changes`
- `Findings`
- `Confidence Score`
- merge stance

JSON output now also includes a universal `issueTracking` payload with stable finding IDs, categories, severities, origins, fix hints, and re-review status such as `introduced`, `moved`, `partially-addressed`, and `regressed`.

## Repo Config

Each target repo can define local defaults in `.codex/reviewer.yml`.

Start from:

- [`.codex/reviewer.yml.example`](./.codex/reviewer.yml.example)

Repo-local config is where you tune:

- base branch
- code-review-graph timeout
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

## Notes

- Most users should stop at `codex-review`.
- `code-review-graph` is required; if it is missing, run `npm run install:graph` from the `codex-review` checkout.
- Saving to Markdown does not need a separate flag; shell redirection is the simplest pattern.
- If you need compact notes on config, fallback behavior, or advanced modes, use [docs.md](./docs.md).
