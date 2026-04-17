# Setup

Quick setup for WPManageNinja developers.

## Supported Repos

This setup is intended for developers working on:

- `fluentform`
- `fluentformpro`
- `fluent-conversational-js`
- `fluentforms-pdf`
- `multilingual-forms-fluent-forms-wpml`
- `fluentform-signature`
- `fluent-player`
- `fluent-player-pro`

## 1. Clone the repo

```bash
git clone https://github.com/dhrupo/codex-review.git
cd codex-review
```

## 2. Install dependencies

```bash
npm install
```

## 3. Link the command globally

```bash
npm link
```

Now this should work from anywhere:

```bash
codex-review --help
```

## 4. Confirm Codex CLI is available

```bash
codex --help
```

If Codex is not installed yet, heuristic mode still works:

```bash
codex-review --engine heuristic
```

## 5. Optional repo config in the target repo

Inside the repo you want to review:

```bash
mkdir -p .codex
cp /path/to/codex-review/.codex/reviewer.yml.example .codex/reviewer.yml
```

Recommended defaults for most WPManageNinja repos:

- `base: origin/dev`
- `engine: codex`
- `review_depth: thorough`

## 6. Run the reviewer

Recommended command:

```bash
codex-review --base origin/dev --engine codex --thorough
```

Fast first pass:

```bash
codex-review --base origin/dev --engine heuristic
```

## 7. Use it before PR and after fixes

Recommended workflow:

1. Make changes
2. Run:

```bash
codex-review --base origin/dev --engine codex --thorough
```

3. Fix findings
4. Commit
5. Run the same command again
6. Read the `Recheck Status` section
7. Push or request PR review after blockers are cleared

## 8. Optional markdown report

```bash
codex-review --base origin/dev --engine codex --format markdown --report codex-review.md
```

## Notes

- For most WPManageNinja repos, `origin/dev` is the correct base.
- Use `--thorough` for payments, auth, uploader/crop flows, export/PDF flows, multilingual mapping, and player config changes.
- Review state is stored locally at:

```bash
~/.codex/codex-review/state/
```

- Update the tool later with:

```bash
cd /path/to/codex-review
git pull
npm install
```
