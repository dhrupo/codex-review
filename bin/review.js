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
    codex-review > pr-review.md

  Normal use:
    codex-review               Print the PR-review to the terminal
    codex-review > pr-review.md
                               Save the same PR-review output to a file

  Common flags:
    --base <ref>              Base ref to diff against
    --engine <name>           Review engine: auto, codex, heuristic
    --fail-on <severity>      Exit non-zero for low, medium, important, or critical findings
    -h, --help                Show help
    -v, --version             Show version

  Notes:
    Default output format is pr-review.
    Advanced flags still exist, but the normal workflow should stay on the two commands above.
    If you prefer built-in file writing over shell redirection, --report <path> is still available.
    Run npm run install:graph once in the codex-review checkout; code-review-graph is required.
    Repo-specific defaults belong in .codex/reviewer.yml.
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
