#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const { createReviewReport, parseArgs } = require('../reviewer.js');

function printHelp() {
  console.log(`
  Codex Review — Local pre-PR review for the current git checkout

  Usage:
    codex-review

  Options:
    --base <ref>           Base ref to diff against
    --head <ref>           Head ref to diff against (default: HEAD)
    --staged               Review staged changes only
    --files <a,b,c>        Review only specific files
    --workflow <name>      Advanced workflow preset: debugger or plugin-audit
    --mode <name>          Review mode: full, security, performance, compatibility, accessibility
    --engine <name>        Review engine: auto, codex, heuristic
    --model <name>         Codex model override for engine=auto or codex
    --thorough             Explicitly force thorough review depth
    --review-depth <name>  Review depth: balanced or thorough (default: thorough)
    --semgrep              Force-enable Semgrep if the CLI is installed
    --no-semgrep           Disable the Semgrep stage
    --semgrep-config <id>  Semgrep config to run alongside Codex (default: auto)
    --semgrep-timeout <ms> Timeout for the Semgrep scan
    --phpstan              Force-enable PHPStan if vendor/bin or global phpstan exists
    --no-phpstan           Disable the PHPStan stage
    --phpstan-config <id>  PHPStan config file path (default: auto)
    --phpstan-timeout <ms> Timeout for the PHPStan scan
    --eslint               Force-enable ESLint if node_modules/.bin or global eslint exists
    --no-eslint            Disable the ESLint stage
    --eslint-config <id>   ESLint config file path (default: auto)
    --eslint-timeout <ms>  Timeout for the ESLint scan
    --a11y-url <url>       Scan one rendered URL with Playwright + axe (repeatable)
    --a11y-urls <a,b>      Scan multiple rendered URLs with Playwright + axe
    --a11y-wait-for <sel>  Wait for a selector before running the accessibility scan
    --a11y-timeout <ms>    Timeout for page load and selector waits during a11y scan
    --a11y-storage-state <path>
                           Optional Playwright storage state JSON for authenticated scans
    --reviewdog-report <path>
                           Write merged findings as reviewdog rdjson
    --format <name>        Output format: pr-review, text, markdown, github, json, rdjson
    --report <path>        Write the rendered report to a file
    --max-findings <n>     Limit the number of findings in the output
    --fail-on <severity>   Exit non-zero for low, medium, important, or critical findings
    -h, --help             Show help
    -v, --version          Show version

  Default behavior:
    codex-review
      deep local pre-PR review with the PR-review format, Codex when available, and all enabled static/runtime stages

  Advanced optional workflows:
    codex-review --workflow debugger
    codex-review --workflow plugin-audit
`);
}

function archiveExistingReportIfNeeded(reportPath, workflow) {
  if (!reportPath || workflow !== 'plugin-audit' || !fs.existsSync(reportPath)) {
    return;
  }

  const dirname = path.dirname(reportPath);
  const ext = path.extname(reportPath);
  const basename = path.basename(reportPath, ext);
  const date = new Date().toISOString().slice(0, 10);
  const archivePath = path.join(dirname, `${basename}-${date}${ext}`);
  fs.copyFileSync(reportPath, archivePath);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.version) {
    const pkg = require('../package.json');
    console.log(pkg.version);
    process.exit(0);
  }

  try {
    const report = await createReviewReport(options, process.cwd());

    if (report.reportPath) {
      const resolvedReportPath = path.resolve(process.cwd(), report.reportPath);
      archiveExistingReportIfNeeded(resolvedReportPath, report.workflow);
      fs.writeFileSync(resolvedReportPath, report.rendered);
    }

    if (report.reviewdogReportPath) {
      const resolvedReviewdogPath = path.resolve(process.cwd(), report.reviewdogReportPath);
      fs.writeFileSync(resolvedReviewdogPath, report.reviewdogRendered);
    }

    console.log(report.rendered);
    process.exit(report.exitCode);
  } catch (error) {
    console.error(`codex-review error: ${error.message}`);
    process.exit(1);
  }
}

main();
