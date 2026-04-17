#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const { createReviewReport, parseArgs } = require('../reviewer.js');

function printHelp() {
  console.log(`
  Codex Review — Local pre-PR review for the current git checkout

  Usage:
    codex-review --base origin/main
    codex-review --staged
    codex-review --mode security --report codex-review.md

  Options:
    --base <ref>           Base ref to diff against
    --head <ref>           Head ref to diff against (default: HEAD)
    --staged               Review staged changes only
    --files <a,b,c>        Review only specific files
    --mode <name>          Review mode: full, security, performance, compatibility
    --engine <name>        Review engine: auto, codex, heuristic
    --model <name>         Codex model override for engine=auto or codex
    --format <name>        Output format: text, markdown, json
    --report <path>        Write the rendered report to a file
    --max-findings <n>     Limit the number of findings in the output
    --fail-on <severity>   Exit non-zero for low, medium, important, or critical findings
    -h, --help             Show help
    -v, --version          Show version
`);
}

function main() {
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
    const report = createReviewReport(options, process.cwd());

    if (options.report) {
      fs.writeFileSync(path.resolve(process.cwd(), options.report), report.rendered);
    }

    console.log(report.rendered);
    process.exit(report.exitCode);
  } catch (error) {
    console.error(`codex-review error: ${error.message}`);
    process.exit(1);
  }
}

main();
