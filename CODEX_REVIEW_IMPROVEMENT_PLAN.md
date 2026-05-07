# Codex Review Universal Improvement Plan

## Goal

Improve `codex-review` so it catches more real PR issues with less plugin-specific tuning.

The key constraint is deliberate:

- `codex-review` must stay **universal**
- improvements should target **reusable review patterns**
- repo-specific config may refine behavior, but the core engine should not depend on plugin-only logic

This plan is based on the findings summarized in [autharif-review-report-2026-03-06-to-2026-05-06.md](./autharif-review-report-2026-03-06-to-2026-05-06.md).

## What The Report Shows

Across the reviewed repositories, the same issue shapes repeated:

- contract drift between producer and consumer changes
- unsafe output rendering and escaping gaps
- keyboard and focus accessibility regressions
- missing failure-state handling in admin/runtime flows
- authorization and scope mismatches
- background job, migration, and async correctness gaps
- hot-path performance regressions
- data normalization and state integrity issues

These are not plugin-specific categories. They are general software review patterns.

That means `codex-review` should improve by getting better at:

- tracing contracts
- tracing trust boundaries
- tracing state transitions
- tracing auth scope
- tracing async/idempotent flows
- tracing hot-path repetition

## Current Base To Build On

The current implementation already has the right structural pieces:

- local diff collection
- repo config loading
- `focusAreas`, `criticalPaths`, `contextRules`, `reviewSignals`, and `edgeCases`
- structured review schema with `outside_diff_findings`
- multi-pass Codex review flow
- heuristic fallback
- Semgrep, PHPStan, and ESLint stages
- rendered accessibility scanning with Playwright

The improvement work should extend these primitives, not replace them.

## Design Principles

### 1. Universal First

Add capabilities in terms of general review signals:

- provider/consumer mismatch
- unescaped output
- stale derived state
- missing failure recovery
- missing authorization binding
- repeated expensive lookups
- non-idempotent retry path

Do not encode plugin names, product modules, or repository-specific workflows into the core engine.

### 2. Evidence Before Severity

The engine should only produce high-severity findings when it can point to:

- a concrete changed path
- a concrete companion path
- a concrete broken invariant

If the engine has a suspicion but not enough proof, it should place it in `outside_diff_findings` or a lower-confidence bucket.

### 3. Companion Tracing Beats Diff-Only Review

A large share of missed issues happen because the changed file looks fine in isolation but its consumer or caller was not traced.

`codex-review` should treat changed files as entrypoints into a companion graph:

- routes to handlers
- handlers to policy/auth checks
- serializers to renderers
- schema producers to schema consumers
- UI controls to error/loading/reset logic
- async triggers to retry/cleanup paths

### 4. Re-Review Must Understand Fix Cycles

The report shows many PRs with:

- `CHANGES_REQUESTED`
- later `COMMENTED`
- finally `APPROVED`

`codex-review` should get better at re-review behavior:

- keep unresolved findings visible
- drop cleared findings
- identify newly introduced blockers after partial fixes

## Improvement Areas

## 1. Universal Contract Drift Detection

### Problem

Many blockers came from one side of a contract changing without the corresponding consumer change:

- backend emits new fields
- frontend still assumes old shape
- producer normalizes values differently than validator/renderer
- one package updates a shared contract but the sibling package does not

### Improvement

Add a generic contract-tracing stage that looks for changed:

- JSON-like payload keys
- request/response field names
- event names and hook names
- shortcode/filter/action signatures
- exported config object shapes
- enum-like option names and operator names

Then force companion inspection for likely consumers:

- same repo consumers via imports, string references, route names, hook names, or field names
- optionally configured companion repos in the future, but without hardcoding product pairs into the core engine

### Implementation Notes

Use the existing:

- `criticalPaths`
- `contextRules`
- multi-pass payload builder

Add:

- generic producer/consumer pattern extraction
- “contract changed, consumer not traced” warning logic
- a dedicated prompt section for changed contracts and unresolved companions

## 2. Trust Boundary And Output Safety Review

### Problem

Unsafe output patterns repeated across repos:

- raw HTML insertion
- preview rendering without sanitization
- translated or user-generated strings injected into markup
- inconsistent escaping between runtime and admin preview

### Improvement

Add a universal “trust boundary” pass that classifies values as:

- user input
- translated content
- remote payload
- database content
- runtime-generated HTML

Then look for sinks such as:

- DOM insertion
- HTML string concatenation
- template interpolation into unsafe contexts
- email/shortcode/render output paths

### Implementation Notes

This should combine:

- heuristics
- Semgrep rules
- Codex prompt instructions that explicitly ask for source-to-sink tracing

This is broader than XSS. It should also cover:

- unsafe filesystem/path consumption
- unsafe URL/path concatenation
- unsafe header/output generation

## 3. Accessibility Regression Detection Beyond Axe

### Problem

Axe catches only part of the report’s accessibility issues.

Many blockers were interaction regressions:

- keyboard traps
- hover-only functionality
- mouse-only controls
- unlabeled action buttons
- stale focus behavior after UI state changes

### Improvement

Extend runtime and static accessibility review to cover interaction heuristics:

- `keydown` handlers that trap `Tab`
- focus movement without escape path
- hover-only popovers/tooltips
- clickable non-button/non-link controls without keyboard parity
- icon-only controls lacking accessible name
- `v-html`/dynamic markup paths lacking semantic wrappers

### Implementation Notes

Keep Axe, but add:

- static UI heuristics in JS/Vue/React templates
- Codex prompt focus on keyboard path verification
- optional lightweight interaction scripts in Playwright for configured pages

## 4. Failure-State And Recovery Analysis

### Problem

A recurring issue shape was “success path works, failure path is broken”:

- loading state never resets
- button remains disabled forever
- console-only error handling
- stale status view after async completion
- cancellation race after modal close

### Improvement

Add a universal state-machine review pass for changed async UI flows:

- request start
- success
- failure
- cancellation
- retry
- cleanup

### Implementation Notes

Look for patterns like:

- `loading = true` without guaranteed reset
- rejected promises with no UI recovery
- empty catch branches
- optimistic state cleared before refresh finishes
- cleanup that races async callbacks

This should feed both:

- heuristics
- Codex review prompts

## 5. Authorization And Scope Binding Analysis

### Problem

Several important findings came from scope mismatches:

- route param vs body param disagreement
- write path weaker than read path
- fallback permissions broader than intended
- missing binding between target object and capability check

### Improvement

Add a generic authorization review pass that traces:

- request target source
- permission check location
- object lookup
- mutation target

And flags patterns like:

- auth check not bound to the same identifier that is mutated
- broad fallback role/capability path
- falsy or missing identifier bypass
- custom route path that skips scoped auth logic

### Implementation Notes

This is a strong fit for:

- `criticalPaths`
- `contextRules`
- Semgrep rules for common route/policy anti-patterns

The core engine should reason in generic terms:

- target binding
- scope narrowing
- write authorization parity

## 6. Async, Background, And Idempotency Review

### Problem

The report repeatedly surfaced:

- replay issues
- missing locks
- non-idempotent retries
- long synchronous work in request path
- missing progress guarantees after partial failure

### Improvement

Add a generic async correctness pass for:

- cron jobs
- queue workers
- migrations
- imports/exports
- webhooks
- long-running admin actions

### Implementation Notes

Review for:

- lock acquisition and release
- duplicate processing protection
- resume/checkpoint strategy
- bounded batch size
- retry safety
- cleanup on interruption

This should become a standard prompt section whenever changed files touch:

- schedulers
- migrations
- webhooks
- batch processors

## 7. Hot-Path Performance Review

### Problem

Several findings were not algorithmically exotic. They were repeated hot-path mistakes:

- repeated DB lookups inside loops
- repeated form/config fetches in render hooks
- full-table defaults
- repeated registration work on every request

### Improvement

Upgrade the heuristic stage to identify likely hot-path regressions:

- repeated model lookup inside function called per item/render
- repeated option/config loading inside request-global hooks
- lack of caching on repeated derived mappings
- query patterns suggesting N+1 behavior

### Implementation Notes

This does not require deep static cost modeling.

A practical version is enough:

- loop-aware suspicious call detection
- hook/render-path suspicious lookup detection
- “expensive operation in repeated callback” prompts

## 8. Data Integrity And Normalization Checks

### Problem

A broad class of issues involved inconsistent normalization:

- duplicate option values
- translated label collisions
- grouped option flattening mismatch
- edit-time state differing from submit-time state
- reset flows leaving stale derived classes or cached mappings

### Improvement

Add a universal data-shape integrity pass focused on:

- canonical vs display values
- uniqueness assumptions
- round-trip invariants
- reset invariants
- serialization/deserialization integrity

### Implementation Notes

Prompt the model to ask:

- what is the canonical stored value
- what is the displayed value
- what happens on re-open/reload/reset
- what happens if labels collide
- what happens if empty and duplicate values exist

This should be standard whenever option collections or payload mappers change.

## 9. Finding Memory And Re-Review State

### Problem

The report shows many review cycles where blockers were partially fixed and new blockers appeared.

### Improvement

Extend the existing local state model so `codex-review` can:

- fingerprint findings by invariant, not only by file line
- compare current findings to prior run
- mark findings as resolved, persistent, or newly introduced
- explicitly call out “fix addressed X but introduced Y”

### Implementation Notes

This should improve user trust and reduce churn in repeated runs.

The engine should preserve:

- issue identity
- supporting evidence
- resolution status

even if line numbers shift.

## 10. Universal Rule Packs Instead Of Plugin Rules

### Problem

The fastest way to improve detection would be to hardcode product-specific rules, but that would make the tool brittle and narrow.

### Improvement

Introduce **universal rule packs** organized by concern, not by plugin:

- `contracts`
- `auth-scope`
- `output-safety`
- `async-correctness`
- `ui-state`
- `a11y-interaction`
- `hot-path-performance`
- `data-normalization`

Repo config can enable or emphasize packs, but the packs themselves stay generic.

### Implementation Notes

This fits the current config surface well:

- `focusAreas`
- `reviewSignals`
- `edgeCases`
- `contextRules`

The repo should describe *where* to look harder, not *what the engine fundamentally knows how to review*.

## Engine Changes

## Prompt Layer

Improve the Codex prompt so each pass explicitly asks for:

- contract producer/consumer mismatches
- trust boundary tracing
- failure path coverage
- authorization target binding
- async/idempotency invariants
- stale/reset state issues

Also require the model to classify findings under the universal categories above.

## Heuristic Layer

Add fast pre-Codex detectors for:

- unsafe DOM/HTML sinks
- suspicious `Tab` trapping and hover-only triggers
- loading state set without symmetric reset
- catch branches with no user-visible recovery
- route/body identifier mismatch patterns
- repeated lookup inside loops/hooks
- changed payload keys with no obvious same-repo consumer update

## Static Tool Layer

Keep Semgrep/PHPStan/ESLint, but add universal review-oriented rules:

- auth-scope rules
- output-escaping rules
- async-state rules
- repeated-lookup rules

These should support the reviewer, not replace it.

## Report Layer

Improve final report rendering so findings include:

- universal category
- evidence path
- whether it is direct diff or companion-path derived
- whether it is persistent from prior run or newly introduced

## CLI And Config Additions

Suggested additions that stay universal:

- `--trace-contracts`
- `--trace-auth`
- `--trace-async`
- `--trace-state`
- `--category <name>`
- `--recheck-from <previous-report-or-state>`

Suggested config additions:

- `companion_patterns`
- `contract_markers`
- `trust_boundaries`
- `stateful_components`
- `async_paths`
- `authorization_paths`

These should remain optional.

## Delivery Plan

## Phase 1: Normalize Finding Taxonomy

Ship first:

- universal finding categories
- improved report schema
- better re-review state matching
- prompt updates for category-based reasoning

Success criteria:

- reports become easier to compare across repos
- repeated findings stabilize across reruns

## Phase 2: Add Universal Heuristics

Ship next:

- contract drift heuristics
- output safety heuristics
- async failure-state heuristics
- auth-scope heuristics
- hot-path lookup heuristics

Success criteria:

- more blocker-class issues are caught before Codex or highlighted to Codex with better context

## Phase 3: Add Companion Tracing

Ship next:

- changed-symbol extraction
- consumer lookup
- companion context injection
- “changed producer without changed consumer” reasoning

Success criteria:

- better detection of cross-file and cross-layer regressions

## Phase 4: Improve Accessibility Coverage

Ship next:

- keyboard/focus interaction heuristics
- better runtime accessibility checks
- structured accessibility findings beyond Axe output

Success criteria:

- keyboard traps and hover-only regressions become first-class review findings

## Phase 5: Evaluate Against Real Review History

Use the `autharif` report and future reports as a benchmark set:

- which findings would current `codex-review` catch
- which would new heuristics catch
- which still require stronger companion tracing

Success criteria:

- measurable increase in recall on real historical review findings
- no major increase in low-signal noise

## Acceptance Criteria

`codex-review` improvement work is successful when:

- it catches issue categories from the report without knowing the target plugin
- it explains findings in reusable language
- it can trace changed code into companion code paths
- it performs useful re-reviews after partial fixes
- it raises trust in pre-PR review instead of producing more noise

## Non-Goals

This plan does not aim to make `codex-review`:

- a product-specific linter
- a replacement for framework-specific static analysis
- dependent on GitHub PR metadata for core behavior
- tied to one repository family

The target is a stronger **universal pre-PR reviewer** that learns from real review history without becoming plugin-bound.
