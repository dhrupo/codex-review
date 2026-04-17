# Setup

Quick setup for WPManageNinja developers.

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

Now this should work from any repository:

```bash
codex-review --help
```

## 4. Confirm Codex CLI is available

If you want the Codex-backed review path:

```bash
codex --help
```

If Codex is not available, `codex-review --engine heuristic` still works.

## 5. Add repo config to the target repository

Inside the target plugin repository:

```bash
mkdir -p .codex
cp /path/to/codex-review/.codex/reviewer.yml.example .codex/reviewer.yml
```

Then adjust the config if needed.

## 6. Run the reviewer

Recommended command for WPManageNinja plugin repos:

```bash
codex-review --base origin/dev --engine codex --thorough
```

Fast first pass:

```bash
codex-review --base origin/dev --engine heuristic
```

## 7. Optional markdown report

```bash
codex-review --base origin/dev --engine codex --format markdown --report codex-review.md
```

## Notes

- Use `origin/dev` for repos that flow into dev before PR merge.
- Use `--thorough` for payment, webhook, auth, and persistence changes.
- Use `--files` when you only want to review a narrow slice of a large branch.
