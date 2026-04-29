'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const axeCore = require('axe-core');

function normalizeImpact(impact) {
  if (impact === 'critical') {
    return 'critical';
  }

  if (impact === 'serious') {
    return 'important';
  }

  if (impact === 'moderate') {
    return 'medium';
  }

  return 'low';
}

function buildRuntimeFinding(url, violation) {
  const firstNode = violation.nodes[0] || {};
  const firstTarget = Array.isArray(firstNode.target) && firstNode.target.length
    ? firstNode.target.join(', ')
    : 'unknown target';
  const failureSummary = firstNode.failureSummary
    ? firstNode.failureSummary.replace(/\s+/g, ' ').trim()
    : 'Inspect the affected rendered node in the browser.';

  return {
    severity: normalizeImpact(violation.impact),
    confidence: 'high',
    file: url,
    line: 1,
    title: `Rendered accessibility violation: ${violation.help}`,
    evidence: `axe rule ${violation.id} affected ${violation.nodes.length} node(s) on ${url}. First target: ${firstTarget}.`,
    impact: `Rendered accessibility scan classified this as ${violation.impact || 'minor'} impact. ${failureSummary}`,
    explanation: violation.description || violation.help,
    verification: `Open ${url} and inspect the affected selector ${firstTarget}. Confirm the issue is resolved in the rendered UI, not only in source markup.`,
    fixDirection: `Apply the remediation described by axe for ${violation.id}: ${violation.helpUrl}`
  };
}

async function scanUrl(browser, config, url) {
  const contextOptions = {
    ignoreHTTPSErrors: true
  };

  if (config.storageStatePath) {
    contextOptions.storageState = config.storageStatePath;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: config.timeoutMs
    });

    if (config.waitForSelector) {
      await page.waitForSelector(config.waitForSelector, {
        timeout: config.timeoutMs
      });
    }

    await page.addScriptTag({ content: axeCore.source });
    const result = await page.evaluate(async () => {
      return window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
        }
      });
    });

    return {
      url,
      title: await page.title(),
      violations: result.violations || []
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];

  if (!inputPath || !outputPath) {
    throw new Error('Expected input and output file paths.');
  }

  const config = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const browser = await chromium.launch({
    headless: config.headless !== false
  });

  try {
    const pages = [];
    const findings = [];

    for (const url of config.urls) {
      const pageResult = await scanUrl(browser, config, url);
      pages.push({
        url: pageResult.url,
        title: pageResult.title,
        violations: pageResult.violations.length
      });

      pageResult.violations.forEach((violation) => {
        findings.push(buildRuntimeFinding(url, violation));
      });
    }

    const output = {
      pages,
      findings,
      notes: [
        `Ran Playwright + axe accessibility scan against ${pages.length} rendered page(s).`,
        ...pages.map((page) => `A11y scan: ${page.url} (${page.violations} violation(s))`)
      ]
    };

    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
