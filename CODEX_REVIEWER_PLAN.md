# Codex Pre-PR Reviewer Plan

## Goal

Build a local Codex-powered reviewer that runs before a pull request is created.

This reviewer should help a developer review their own branch against a base branch, find real security and regression issues, and produce a high-signal report that can be fixed before opening a PR.

GitHub connectivity is not required for the first version.

## Why This Changes the Design

If the tool runs before PR creation, then:

- no GitHub App is required
- no webhook receiver is required
- no PR comment posting is required
- no repository installation flow is required
- no GitHub auth dependency is required for the core product

This makes the first version much simpler and faster to ship.

It also fits internal engineering workflows better:

- run locally before commit
- run locally before push
- run locally before PR
- optionally wire into a repo script, Git hook, or CI later

## What The Existing Claude Workflow Suggests

The existing Claude setup appears to do this conceptually:

- inspect the diff
- inspect repo context and repo-specific instructions
- apply a review rubric
- produce a structured summary

That exact pattern can be reproduced locally with Codex without GitHub.

## Product Shape

The first version should be a local CLI tool.

Suggested command shape:

```bash
codex-review --base origin/main
```

Optional forms:

```bash
codex-review
codex-review --base main
codex-review --base origin/development
codex-review --staged
codex-review --files app/Http/Controllers/Foo.php,resources/js/bar.js
codex-review --mode security
codex-review --mode full
codex-review --report review.md
```

## User Workflow

### Primary Workflow

1. Developer checks out a feature branch.
2. Developer makes code changes.
3. Developer runs `codex-review --base origin/main`.
4. Tool analyzes diff plus surrounding repo context.
5. Tool outputs:
   - verdict
   - prioritized findings
   - suggested fix directions
   - optional markdown report
6. Developer fixes issues.
7. Developer opens PR only after the branch is clean enough.

### Optional Workflow Modes

- pre-commit review
- pre-push review
- pre-PR review
- targeted file review
- security-only review
- performance-only review

## Core Requirements

The local reviewer should:

- work from a local git checkout
- compare current work against a chosen base branch
- understand repo-local rules and instruction files
- understand WordPress and WPManageNinja patterns
- produce low-noise, evidence-based findings
- support markdown and terminal output
- support different review modes
- run without GitHub connectivity

## Non-Goals

The first version should not try to:

- post comments to GitHub
- approve or request changes on a PR
- act as a full static analyzer replacement
- auto-fix code
- analyze the entire repo every time

## Recommended Architecture

Build this as a local CLI plus review engine.

### High-Level Components

1. CLI entrypoint
2. Git diff collector
3. Context loader
4. Risk classifier
5. Codex review runner
6. Findings synthesizer
7. Report renderer

## Detailed Design

### 1. CLI Layer

Responsibilities:

- parse arguments
- determine base ref
- determine review mode
- choose output format
- choose file scope

Suggested flags:

- `--base <ref>`
- `--head <ref>`
- `--staged`
- `--files <csv>`
- `--mode <full|security|performance|compatibility>`
- `--format <text|markdown|json>`
- `--report <path>`
- `--max-comments <n>`
- `--fail-on <severity>`

### 2. Git Diff Layer

The tool should gather:

- changed files list
- unified diff
- base blob content for changed files
- head/working-tree content for changed files

Primary commands:

- `git diff --name-only <base>...HEAD`
- `git diff --unified=3 <base>...HEAD`
- `git show <base>:path`
- local file reads for current content

It should support:

- committed changes
- uncommitted changes
- staged-only mode

### 3. Context Loader

Load only the files needed for review.

Priority sources:

- `AGENTS.md`
- `README.md`
- repo-local instruction files
- `.claude/skills/**`
- `.codex/**`
- architecture docs
- adjacent code for changed files

The reviewer should not blindly load the whole repo.

It should pull:

- changed file contents
- nearby related files
- route/controller/service pairs when relevant
- model/schema files when relevant

### 4. Risk Classifier

Before expensive deep review, classify changed files by risk.

High-risk categories:

- authentication/authorization
- REST routes
- AJAX handlers
- settings persistence
- payment/subscription code
- DB writes or schema changes
- file upload logic
- cron/scheduler logic
- public rendering/output paths
- migration code

Medium-risk categories:

- service logic
- UI state logic
- caching
- data formatting
- compatibility-sensitive integrations

Low-risk categories:

- docs
- tests only
- copy changes
- simple styling

### 5. Review Engine

Use staged review rather than a single prompt.

#### Pass A: Triage

Inputs:

- changed file list
- diff summary
- repo rules

Outputs:

- risk-ranked file list
- review mode decision
- files needing deep inspection

#### Pass B: Deep Review

Inspect risky files with surrounding context.

Focus:

- security issues
- logic regressions
- compatibility risks
- persistence/data-shape issues
- missing tests around risky changes
- performance issues where relevant

#### Pass C: Synthesis

Combine candidate findings into a final structured result.

Each finding should contain:

- severity
- confidence
- file
- line
- title
- evidence
- impact
- fix direction

The synthesis pass must drop weak, duplicate, or speculative findings.

## WordPress Review Rules

This is where the tool becomes better than a generic reviewer.

### Security Review

Check for:

- missing capability checks
- missing nonce verification
- unsafe superglobal use
- insufficient sanitization
- insufficient escaping
- unsafe raw SQL
- unsafe file handling
- secret/token leakage
- permission gaps in routes or actions

### Data Integrity Review

Check for:

- settings shape drift
- broken option/meta updates
- inconsistent normalization
- migration breakage
- cache invalidation gaps
- scheduler duplication or missed cleanup

### Compatibility Review

Check for:

- PHP version compatibility
- WordPress API compatibility
- integration regressions with Elementor, Beaver, Oxygen, WooCommerce, or Fluent products
- backward compatibility risks in public hooks, options, meta, and data structures

### UI/Rendering Review

Check for:

- unescaped rendering paths
- template regressions
- broken builder rendering behavior
- asset loading regressions
- state drift between editor and frontend rendering

## Severity Model

### Critical

- confirmed security vulnerability
- destructive data corruption risk
- payment logic bug with serious financial impact

### Important

- confirmed auth/capability/nonce bug
- high-confidence behavior regression
- major compatibility issue
- broken persistence logic

### Medium

- likely bug with limited blast radius
- notable performance issue
- risky change missing enough test coverage

### Low

- maintainability issue
- readability issue
- minor suggestion

## Output Design

The tool should support three formats:

- terminal text
- markdown
- JSON

### Terminal Output

Good for local fast usage.

Example shape:

```text
Verdict: COMMENT
Confidence: 4/5
Base: origin/main

Important Findings
1. Missing capability check before settings mutation
   File: app/Http/Controllers/SettingsController.php:82
   Why: Untrusted callers can reach the mutation path through AJAX.

Medium Findings
2. Template output uses raw option value without escaping
   File: app/Views/settings.php:44
   Why: Stored admin content can render unsafely.
```

### Markdown Output

Good for sharing internally or attaching to task notes.

Suggested sections:

- summary
- verdict
- findings by severity
- files reviewed
- review scope
- open questions

### JSON Output

Good for future automation.

Suggested schema:

```json
{
  "verdict": "COMMENT",
  "confidence_score": 4,
  "base_ref": "origin/main",
  "mode": "full",
  "findings": [
    {
      "severity": "important",
      "confidence": "high",
      "file": "app/Http/Controllers/SettingsController.php",
      "line": 82,
      "title": "Missing capability check before settings mutation",
      "evidence": "update_option() is reachable after nonce check but without current_user_can()",
      "impact": "Privilege boundary may be weaker than intended",
      "fix_direction": "Add an explicit capability check before mutation"
    }
  ]
}
```

## Suggested Local Config

Add optional repo config at `.codex/reviewer.yml`:

```yaml
mode: balanced
focus_areas:
  - security
  - regression
  - compatibility
  - tests
wordpress:
  enabled: true
  enforce_nonce_checks: true
  enforce_capability_checks: true
paths:
  ignore:
    - "vendor/**"
    - "dist/**"
    - "build/**"
  high_risk:
    - "app/Http/**"
    - "app/Services/**"
    - "includes/**"
    - "src/**"
report:
  max_findings: 15
  inline_style: false
```

## Suggested Implementation Phases

### Phase 1: MVP

Build:

- CLI entrypoint
- base diff collection
- changed-file loading
- repo instruction loading
- single Codex review pass
- text and markdown output

Success criteria:

- can review current branch against `origin/main`
- produces a useful local report
- useful enough to run before PR creation

### Phase 2: High-Signal Review

Build:

- risk classifier
- multi-pass review
- WordPress-specific review rules
- JSON output
- severity/confidence filtering

Success criteria:

- fewer noisy findings
- better security and regression detection
- clearly better than a generic diff summary

### Phase 3: Workflow Integration

Build:

- optional pre-push hook
- optional pre-PR wrapper script
- optional CI mode
- optional GitHub output adapter later

Success criteria:

- developers actually run it before opening PRs
- report format is stable enough for team adoption

## Best First Delivery

The strongest first deliverable is:

```bash
codex-review --base origin/main --mode full --report codex-review.md
```

That gives:

- one clear entrypoint
- one clear workflow
- one shareable report
- no GitHub dependency

## Why This Will Help WPManageNinja

This tool would let engineers catch problems before review even starts.

That means:

- fewer avoidable PR comments
- fewer security and compatibility mistakes
- better self-review discipline
- faster human review
- higher confidence before merge

For a WordPress product company, that is meaningful because many bugs are not syntax bugs. They are capability, nonce, rendering, settings, migration, scheduler, or compatibility bugs. A reviewer tuned for those patterns is much more valuable than a generic AI review tool.

## Immediate Next Steps

1. Decide the exact command name.
2. Decide the first target repos.
3. Define the first output format.
4. Build the Phase 1 local CLI.
5. Test it on 5 to 10 recent feature branches and compare findings against human review results.

## Boss-Facing Summary

This plan creates a local AI reviewer that engineers run before opening a PR. It does not depend on GitHub integration, so it is faster to build and easier to adopt. The value is earlier detection of WordPress-specific bugs, cleaner PRs, and less reviewer time wasted on preventable issues.
