'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const DEFAULT_MAX_FINDINGS = 15;
const DEFAULT_IGNORES = ['.git/', 'node_modules/', '.playwright-mcp/'];
const HIGH_RISK_PATHS = [
  'app/http/',
  'app/services/',
  'includes/',
  'src/',
  'controllers/',
  'routes/',
  'payments/',
  'subscriptions/'
];
const MUTATION_CALLS = [
  'update_option',
  'delete_option',
  'add_option',
  'update_post_meta',
  'delete_post_meta',
  'wp_insert_post',
  'wp_update_post'
];
const DEFAULT_CONFIG = {
  mode: 'full',
  engine: 'auto',
  model: null,
  maxFindings: DEFAULT_MAX_FINDINGS,
  focusAreas: [],
  ignorePaths: [],
  highRiskPaths: [],
  notes: []
};
const CODEX_FILE_LIMIT = 12;
const REVIEW_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['APPROVE', 'COMMENT', 'REQUEST_CHANGES']
    },
    confidence_score: {
      type: 'integer',
      minimum: 1,
      maximum: 5
    },
    summary: {
      type: 'string'
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'important', 'medium', 'low']
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low']
          },
          file: {
            type: 'string'
          },
          line: {
            type: 'integer',
            minimum: 1
          },
          title: {
            type: 'string'
          },
          evidence: {
            type: 'string'
          },
          impact: {
            type: 'string'
          },
          fix_direction: {
            type: 'string'
          }
        },
        required: ['severity', 'confidence', 'file', 'line', 'title', 'evidence', 'impact', 'fix_direction'],
        additionalProperties: false
      }
    }
  },
  required: ['verdict', 'confidence_score', 'summary', 'findings'],
  additionalProperties: false
};

function runGit(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: options.cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024
    }).trimEnd();
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    throw new Error(stderr || error.message);
  }
}

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    input: options.input || undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024
  });
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    return false;
  }
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return '';
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function parseArgs(argv) {
  const options = {
    base: null,
    head: 'HEAD',
    staged: false,
    files: [],
    mode: 'full',
    format: 'text',
    report: null,
    maxFindings: DEFAULT_MAX_FINDINGS,
    failOn: null,
    engine: 'auto',
    model: null,
    help: false,
    version: false,
    _explicit: {}
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      options.version = true;
      continue;
    }

    if (arg === '--staged') {
      options.staged = true;
      options._explicit.staged = true;
      continue;
    }

    if (arg === '--base' && argv[i + 1]) {
      options.base = argv[i + 1];
      options._explicit.base = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--base=')) {
      options.base = arg.slice('--base='.length);
      options._explicit.base = true;
      continue;
    }

    if (arg === '--head' && argv[i + 1]) {
      options.head = argv[i + 1];
      options._explicit.head = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--head=')) {
      options.head = arg.slice('--head='.length);
      options._explicit.head = true;
      continue;
    }

    if (arg === '--files' && argv[i + 1]) {
      options.files = argv[i + 1].split(',').map((item) => item.trim()).filter(Boolean);
      options._explicit.files = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--files=')) {
      options.files = arg.slice('--files='.length).split(',').map((item) => item.trim()).filter(Boolean);
      options._explicit.files = true;
      continue;
    }

    if (arg === '--mode' && argv[i + 1]) {
      options.mode = argv[i + 1];
      options._explicit.mode = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length);
      options._explicit.mode = true;
      continue;
    }

    if (arg === '--format' && argv[i + 1]) {
      options.format = argv[i + 1];
      options._explicit.format = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--format=')) {
      options.format = arg.slice('--format='.length);
      options._explicit.format = true;
      continue;
    }

    if (arg === '--report' && argv[i + 1]) {
      options.report = argv[i + 1];
      options._explicit.report = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--report=')) {
      options.report = arg.slice('--report='.length);
      options._explicit.report = true;
      continue;
    }

    if (arg === '--max-findings' && argv[i + 1]) {
      options.maxFindings = Math.max(1, parseInt(argv[i + 1], 10) || DEFAULT_MAX_FINDINGS);
      options._explicit.maxFindings = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--max-findings=')) {
      options.maxFindings = Math.max(1, parseInt(arg.slice('--max-findings='.length), 10) || DEFAULT_MAX_FINDINGS);
      options._explicit.maxFindings = true;
      continue;
    }

    if (arg === '--fail-on' && argv[i + 1]) {
      options.failOn = argv[i + 1];
      options._explicit.failOn = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--fail-on=')) {
      options.failOn = arg.slice('--fail-on='.length);
      options._explicit.failOn = true;
      continue;
    }

    if (arg === '--engine' && argv[i + 1]) {
      options.engine = argv[i + 1];
      options._explicit.engine = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--engine=')) {
      options.engine = arg.slice('--engine='.length);
      options._explicit.engine = true;
      continue;
    }

    if (arg === '--model' && argv[i + 1]) {
      options.model = argv[i + 1];
      options._explicit.model = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--model=')) {
      options.model = arg.slice('--model='.length);
      options._explicit.model = true;
    }
  }

  return options;
}

function resolveDefaultBase(cwd) {
  const candidates = ['origin/main', 'origin/master', 'origin/development', 'main', 'master', 'development'];

  for (const candidate of candidates) {
    try {
      runGit(['rev-parse', '--verify', candidate], { cwd });
      return candidate;
    } catch (error) {
      continue;
    }
  }

  throw new Error('Unable to determine a base ref automatically. Pass --base <ref>.');
}

function isArray(value) {
  return Array.isArray(value);
}

function normalizeStringArray(value) {
  if (!isArray(value)) {
    return [];
  }

  return value.map((item) => String(item).trim()).filter(Boolean);
}

function loadRepoConfig(cwd) {
  const configPath = path.join(cwd, '.codex', 'reviewer.yml');

  if (!fileExists(configPath)) {
    return {
      config: { ...DEFAULT_CONFIG },
      configPath: null
    };
  }

  const raw = safeReadFile(configPath);
  let parsed = {};

  try {
    parsed = yaml.load(raw) || {};
  } catch (error) {
    throw new Error(`Invalid .codex/reviewer.yml: ${error.message}`);
  }

  return {
    configPath,
    config: {
      mode: typeof parsed.mode === 'string' ? parsed.mode : DEFAULT_CONFIG.mode,
      engine: typeof parsed.engine === 'string' ? parsed.engine : DEFAULT_CONFIG.engine,
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_CONFIG.model,
      maxFindings: Math.max(1, parseInt(parsed.max_findings || parsed.maxFindings, 10) || DEFAULT_CONFIG.maxFindings),
      focusAreas: normalizeStringArray(parsed.focus_areas || parsed.focusAreas),
      ignorePaths: normalizeStringArray((parsed.paths && parsed.paths.ignore) || parsed.ignore_paths || parsed.ignorePaths),
      highRiskPaths: normalizeStringArray((parsed.paths && parsed.paths.high_risk) || parsed.high_risk_paths || parsed.highRiskPaths),
      notes: normalizeStringArray(parsed.notes)
    }
  };
}

function resolveOptions(rawOptions, repoConfig) {
  const options = {
    ...rawOptions,
    mode: rawOptions._explicit.mode ? rawOptions.mode : repoConfig.mode,
    engine: rawOptions._explicit.engine ? rawOptions.engine : repoConfig.engine,
    model: rawOptions._explicit.model ? rawOptions.model : repoConfig.model,
    maxFindings: rawOptions._explicit.maxFindings ? rawOptions.maxFindings : repoConfig.maxFindings
  };

  options.focusAreas = repoConfig.focusAreas;
  options.ignorePaths = Array.from(new Set([...DEFAULT_IGNORES, ...repoConfig.ignorePaths]));
  options.highRiskPaths = Array.from(new Set([...HIGH_RISK_PATHS, ...repoConfig.highRiskPaths])).map((item) => item.toLowerCase());
  options.configNotes = repoConfig.notes;

  return options;
}

function shouldIgnore(filePath, ignorePaths) {
  return ignorePaths.some((ignore) => filePath === ignore.slice(0, -1) || filePath.startsWith(ignore));
}

function truncateText(text, limit) {
  if (!text || text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n...[truncated]`;
}

function getRepoInstructions(cwd, repoConfigPath) {
  const instructions = [];
  const files = ['AGENTS.md', 'README.md'];

  for (const relativePath of files) {
    const absolutePath = path.join(cwd, relativePath);
    if (fileExists(absolutePath)) {
      instructions.push({
        path: relativePath,
        content: truncateText(safeReadFile(absolutePath), 12000)
      });
    }
  }

  if (repoConfigPath && fileExists(repoConfigPath)) {
    instructions.push({
      path: path.relative(cwd, repoConfigPath),
      content: truncateText(safeReadFile(repoConfigPath), 8000)
    });
  }

  return instructions;
}

function parseStatusLine(line) {
  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;

  return {
    status,
    path: filePath
  };
}

function runGitQuiet(args, options = {}) {
  try {
    return runGit(args, options);
  } catch (error) {
    return '';
  }
}

function buildFileEntries(filePaths, statusByPath, ignorePaths, cwd) {
  const expandedPaths = [];

  Array.from(filePaths).forEach((filePath) => {
    const absolutePath = path.join(cwd, filePath);

    try {
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        fs.readdirSync(absolutePath).forEach((child) => {
          expandedPaths.push(path.posix.join(filePath.replace(/\/$/, ''), child));
        });
        return;
      }
    } catch (error) {
      // Keep the original path when stat fails.
    }

    expandedPaths.push(filePath);
  });

  return Array.from(expandedPaths)
    .filter(Boolean)
    .filter((filePath) => !shouldIgnore(filePath, ignorePaths))
    .map((filePath) => ({
      path: filePath,
      status: statusByPath.get(filePath) || ' M'
    }));
}

function listChangedFiles(cwd, options, baseRef) {
  if (options.files.length) {
    return buildFileEntries(options.files, new Map(), options.ignorePaths, cwd);
  }

  if (options.staged) {
    const stagedFiles = runGitQuiet(['diff', '--name-only', '--cached'], { cwd })
      .split('\n')
      .filter(Boolean);
    return buildFileEntries(stagedFiles, new Map(), options.ignorePaths, cwd);
  }

  const statusOutput = runGitQuiet(['status', '--porcelain'], { cwd });
  const statusEntries = statusOutput
    ? statusOutput.split('\n').filter(Boolean).map(parseStatusLine)
    : [];
  const statusByPath = new Map(statusEntries.map((entry) => [entry.path, entry.status]));
  const filePaths = new Set(statusEntries.map((entry) => entry.path));

  if (baseRef) {
    runGitQuiet(['diff', '--name-only', `${baseRef}...${options.head}`], { cwd })
      .split('\n')
      .filter(Boolean)
      .forEach((filePath) => filePaths.add(filePath));
  }

  if (!baseRef) {
    return buildFileEntries(filePaths, statusByPath, options.ignorePaths, cwd);
  }

  runGitQuiet(['diff', '--name-only'], { cwd })
    .split('\n')
    .filter(Boolean)
    .forEach((filePath) => filePaths.add(filePath));

  runGitQuiet(['diff', '--name-only', '--cached'], { cwd })
    .split('\n')
    .filter(Boolean)
    .forEach((filePath) => filePaths.add(filePath));

  return buildFileEntries(filePaths, statusByPath, options.ignorePaths, cwd);
}

function buildDiffSegments(cwd, baseRef, options, filePaths) {
  const segments = [];
  const pathArgs = filePaths.length ? ['--', ...filePaths] : [];

  if (options.staged) {
    const stagedDiff = runGitQuiet(['diff', '--unified=3', '--cached', ...pathArgs], { cwd });
    if (stagedDiff) {
      segments.push(stagedDiff);
    }
    return segments;
  }

  if (baseRef) {
    const branchDiff = runGitQuiet(['diff', '--unified=3', `${baseRef}...${options.head}`, ...pathArgs], { cwd });
    if (branchDiff) {
      segments.push(branchDiff);
    }
  }

  const cachedDiff = runGitQuiet(['diff', '--unified=3', '--cached', ...pathArgs], { cwd });
  if (cachedDiff) {
    segments.push(cachedDiff);
  }

  const worktreeDiff = runGitQuiet(['diff', '--unified=3', ...pathArgs], { cwd });
  if (worktreeDiff) {
    segments.push(worktreeDiff);
  }

  return segments;
}

function getUnifiedDiff(cwd, baseRef, options, filePaths) {
  if (!filePaths.length) {
    return '';
  }

  return buildDiffSegments(cwd, baseRef, options, filePaths).join('\n');
}

function getBaseContent(cwd, baseRef, filePath) {
  if (!baseRef) {
    return '';
  }

  try {
    return runGit(['show', `${baseRef}:${filePath}`], { cwd });
  } catch (error) {
    return '';
  }
}

function getCurrentContent(cwd, filePath) {
  return safeReadFile(path.join(cwd, filePath));
}

function extractChangedLines(diffText, filePath) {
  const lines = diffText.split('\n');
  const changedLines = [];
  let currentFile = null;
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      currentLine = 0;
      continue;
    }

    if (line.startsWith('@@')) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      if (match) {
        currentLine = parseInt(match[1], 10);
      }
      continue;
    }

    if (currentFile !== filePath) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      changedLines.push({
        line: currentLine,
        text: line.slice(1)
      });
      currentLine += 1;
      continue;
    }

    if (!line.startsWith('-')) {
      currentLine += 1;
    }
  }

  return changedLines;
}

function findLineNumber(content, pattern) {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) {
      return i + 1;
    }
  }

  return 1;
}

function isHighRiskPath(filePath, highRiskPaths) {
  const normalized = filePath.toLowerCase();
  return highRiskPaths.some((segment) => normalized.includes(segment));
}

function getChangedTestFiles(fileEntries) {
  return fileEntries.filter((entry) => /(^|\/)(test|tests|__tests__)\//i.test(entry.path) || /\.(test|spec)\./i.test(entry.path));
}

function pushFinding(findings, finding) {
  const key = [finding.file, finding.line, finding.title].join(':');
  if (findings.some((item) => [item.file, item.line, item.title].join(':') === key)) {
    return;
  }
  findings.push(finding);
}

function analyzeFile(context) {
  const findings = [];
  const { filePath, currentContent, baseContent, changedLines, mode, highRiskPaths } = context;
  const isPhpFile = filePath.endsWith('.php');

  if (!currentContent) {
    return findings;
  }

  if (isPhpFile && /register_rest_route\s*\(/.test(currentContent) && !/permission_callback\s*=>/.test(currentContent)) {
    pushFinding(findings, {
      severity: 'important',
      confidence: 'high',
      file: filePath,
      line: findLineNumber(currentContent, /register_rest_route\s*\(/),
      title: 'REST route is missing permission_callback',
      evidence: 'The file registers a REST route without an explicit permission callback.',
      impact: 'WordPress REST routes can become callable without the intended authorization boundary.',
      fixDirection: 'Add a strict permission_callback for each registered route.'
    });
  }

  if (isPhpFile && MUTATION_CALLS.some((call) => currentContent.includes(`${call}(`)) && /\$_(POST|GET|REQUEST|FILES)\s*\[/.test(currentContent)) {
    const hasCapabilityCheck = /current_user_can\s*\(/.test(currentContent) || /user_can\s*\(/.test(currentContent);
    const hasNonceCheck = /check_ajax_referer\s*\(|wp_verify_nonce\s*\(/.test(currentContent);

    if (!hasCapabilityCheck) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'medium',
        file: filePath,
        line: findLineNumber(currentContent, /(update_option|update_post_meta|wp_insert_post|wp_update_post)\s*\(/),
        title: 'Mutation path does not show a capability check',
        evidence: 'The file mutates WordPress state and also reads request input, but no capability check was detected nearby.',
        impact: 'Request validation may rely only on routing or nonce checks, which is often too weak for admin mutations.',
        fixDirection: 'Add an explicit current_user_can() check before mutation logic.'
      });
    }

    if (!hasNonceCheck && mode !== 'performance') {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'medium',
        file: filePath,
        line: findLineNumber(currentContent, /\$_(POST|GET|REQUEST|FILES)\s*\[/),
        title: 'Request-driven mutation path does not show nonce verification',
        evidence: 'The file reads request input and mutates state, but no nonce verification helper was detected.',
        impact: 'Cross-site request risks increase when privileged state changes are not bound to a nonce.',
        fixDirection: 'Add check_ajax_referer() or wp_verify_nonce() at the request boundary.'
      });
    }
  }

  if (isPhpFile && /\$wpdb->(query|get_results|get_row|get_var)\s*\(/.test(currentContent) && !/\$wpdb->prepare\s*\(/.test(currentContent)) {
    pushFinding(findings, {
      severity: 'important',
      confidence: 'medium',
      file: filePath,
      line: findLineNumber(currentContent, /\$wpdb->(query|get_results|get_row|get_var)\s*\(/),
      title: 'Raw database query does not show prepare() usage',
      evidence: 'A $wpdb query call was found without a matching $wpdb->prepare() in the file.',
      impact: 'Interpolated SQL is easy to get wrong and can create injection or malformed query risks.',
      fixDirection: 'Route dynamic SQL values through $wpdb->prepare() before execution.'
    });
  }

  if (isPhpFile && /str_contains\s*\(/.test(currentContent)) {
    pushFinding(findings, {
      severity: 'medium',
      confidence: 'medium',
      file: filePath,
      line: findLineNumber(currentContent, /str_contains\s*\(/),
      title: 'str_contains() may break older PHP targets',
      evidence: 'str_contains() requires newer PHP versions than some WordPress plugins still support.',
      impact: 'If the plugin still supports older PHP versions, this can become a fatal runtime error.',
      fixDirection: 'Confirm the minimum PHP version or use a compatibility-safe substring check.'
    });
  }

  const unescapedEcho = changedLines.find((entry) => /echo\s+\$_(GET|POST|REQUEST)/.test(entry.text));
  if (isPhpFile && unescapedEcho) {
    pushFinding(findings, {
      severity: 'important',
      confidence: 'high',
      file: filePath,
      line: unescapedEcho.line,
      title: 'Changed code echoes request input directly',
      evidence: 'A changed line outputs a request variable directly with echo.',
      impact: 'Direct output of request data is a common XSS path.',
      fixDirection: 'Sanitize on input and escape on output with the right WordPress helper.'
    });
  }

  const unsanitizedInput = changedLines.find((entry) => /\$_(GET|POST|REQUEST|FILES)\s*\[/.test(entry.text) && !/(sanitize_|absint|intval|floatval|wp_unslash|esc_url_raw)/.test(entry.text));
  if (isPhpFile && unsanitizedInput && mode !== 'performance') {
    pushFinding(findings, {
      severity: 'medium',
      confidence: 'medium',
      file: filePath,
      line: unsanitizedInput.line,
      title: 'Changed code reads request input without visible sanitization',
      evidence: 'A changed line accesses a request superglobal without a sanitizer on the same line.',
      impact: 'This often leads to unsafe persistence, unsafe SQL parameters, or unsafe rendering later.',
      fixDirection: 'Sanitize request data as close to the boundary as possible.'
    });
  }

  if (mode !== 'security') {
    const addedLoop = changedLines.find((entry) => /for(each)?\s*\(|while\s*\(/.test(entry.text));
    if (addedLoop && /(get_posts|wp_remote_get|wp_remote_post|query|find|fetch)/i.test(currentContent)) {
      pushFinding(findings, {
        severity: 'medium',
        confidence: 'low',
        file: filePath,
        line: addedLoop.line,
        title: 'Review looped I/O or query work in changed logic',
        evidence: 'The changed code adds iteration in a file that also performs fetch, query, or remote work.',
        impact: 'Looped I/O often creates avoidable performance regressions or request fan-out.',
        fixDirection: 'Check whether expensive work can be cached, batched, or moved outside the loop.'
      });
    }
  }

  if (!baseContent && isHighRiskPath(filePath, highRiskPaths) && !/(^|\/)(test|tests|__tests__)\//i.test(filePath) && mode === 'full') {
    pushFinding(findings, {
      severity: 'low',
      confidence: 'medium',
      file: filePath,
      line: 1,
      title: 'New high-risk file should get focused review coverage',
      evidence: 'The change introduces a new high-risk path in the repository.',
      impact: 'New auth, routing, service, or persistence code usually deserves targeted verification before merge.',
      fixDirection: 'Add or update tests and manually verify the changed path before opening a PR.'
    });
  }

  return findings;
}

function summarizeScope(fileEntries, instructions) {
  return {
    reviewedFiles: fileEntries.map((entry) => entry.path),
    instructions: instructions.map((item) => item.path)
  };
}

function rankFindings(findings) {
  const severityOrder = {
    critical: 0,
    important: 1,
    medium: 2,
    low: 3
  };
  const confidenceOrder = {
    high: 0,
    medium: 1,
    low: 2
  };

  return findings.sort((left, right) => {
    const severityDelta = severityOrder[left.severity] - severityOrder[right.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const confidenceDelta = confidenceOrder[left.confidence] - confidenceOrder[right.confidence];
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }

    return left.file.localeCompare(right.file) || left.line - right.line;
  });
}

function buildVerdict(findings) {
  if (findings.some((item) => item.severity === 'critical')) {
    return 'REQUEST_CHANGES';
  }

  if (findings.some((item) => item.severity === 'important' && item.confidence !== 'low')) {
    return 'COMMENT';
  }

  if (findings.length) {
    return 'COMMENT';
  }

  return 'APPROVE';
}

function buildConfidence(findings) {
  if (!findings.length) {
    return 4;
  }

  if (findings.some((item) => item.confidence === 'high')) {
    return 4;
  }

  return 3;
}

function buildSummary(findings, scope, options) {
  if (!scope.reviewedFiles.length) {
    return 'No local changes were found for review.';
  }

  if (!findings.length) {
    return `Reviewed ${scope.reviewedFiles.length} changed file(s) against ${options.base} with no blocker-level findings.`;
  }

  const severities = findings.reduce((accumulator, finding) => {
    accumulator[finding.severity] = (accumulator[finding.severity] || 0) + 1;
    return accumulator;
  }, {});

  const parts = Object.keys(severities).map((severity) => `${severities[severity]} ${severity}`);
  return `Reviewed ${scope.reviewedFiles.length} changed file(s) against ${options.base}. Found ${parts.join(', ')} issue(s).`;
}

function renderText(report) {
  const lines = [
    `Verdict: ${report.verdict}`,
    `Confidence: ${report.confidenceScore}/5`,
    `Base: ${report.baseRef}`,
    `Mode: ${report.mode}`,
    `Engine: ${report.engine}${report.fallbackUsed ? ' (heuristic fallback)' : ''}`,
    '',
    report.summary
  ];

  if (report.scope.reviewedFiles.length) {
    lines.push('', 'Files Reviewed:');
    report.scope.reviewedFiles.forEach((filePath) => lines.push(`- ${filePath}`));
  }

  if (report.notes.length) {
    lines.push('', 'Notes:');
    report.notes.forEach((note) => lines.push(`- ${note}`));
  }

  if (report.findings.length) {
    const grouped = {
      critical: [],
      important: [],
      medium: [],
      low: []
    };

    report.findings.forEach((finding) => grouped[finding.severity].push(finding));

    Object.keys(grouped).forEach((severity) => {
      if (!grouped[severity].length) {
        return;
      }

      lines.push('', `${severity[0].toUpperCase()}${severity.slice(1)} Findings`);
      grouped[severity].forEach((finding, index) => {
        lines.push(`${index + 1}. ${finding.title}`);
        lines.push(`   File: ${finding.file}:${finding.line}`);
        lines.push(`   Confidence: ${finding.confidence}`);
        lines.push(`   Why: ${finding.impact}`);
        lines.push(`   Evidence: ${finding.evidence}`);
        lines.push(`   Fix: ${finding.fixDirection}`);
      });
    });
  } else {
    lines.push('', 'No findings.');
  }

  return lines.join('\n');
}

function renderMarkdown(report) {
  const lines = [
    '# Codex Review Report',
    '',
    `- Verdict: \`${report.verdict}\``,
    `- Confidence: \`${report.confidenceScore}/5\``,
    `- Base: \`${report.baseRef}\``,
    `- Mode: \`${report.mode}\``,
    `- Engine: \`${report.engine}${report.fallbackUsed ? ' (heuristic fallback)' : ''}\``,
    '',
    report.summary
  ];

  if (report.scope.reviewedFiles.length) {
    lines.push('', '## Files Reviewed', '');
    report.scope.reviewedFiles.forEach((filePath) => lines.push(`- \`${filePath}\``));
  }

  if (report.scope.instructions.length) {
    lines.push('', '## Repo Context', '');
    report.scope.instructions.forEach((filePath) => lines.push(`- \`${filePath}\``));
  }

  if (report.notes.length) {
    lines.push('', '## Notes', '');
    report.notes.forEach((note) => lines.push(`- ${note}`));
  }

  if (!report.findings.length) {
    lines.push('', '## Findings', '', 'No findings.');
    return lines.join('\n');
  }

  lines.push('', '## Findings', '');
  report.findings.forEach((finding, index) => {
    lines.push(`### ${index + 1}. ${finding.title}`);
    lines.push('');
    lines.push(`- Severity: \`${finding.severity}\``);
    lines.push(`- Confidence: \`${finding.confidence}\``);
    lines.push(`- File: \`${finding.file}:${finding.line}\``);
    lines.push(`- Evidence: ${finding.evidence}`);
    lines.push(`- Impact: ${finding.impact}`);
    lines.push(`- Fix direction: ${finding.fixDirection}`);
    lines.push('');
  });

  return lines.join('\n');
}

function shouldFail(report, failOn) {
  if (!failOn) {
    return false;
  }

  const order = {
    low: 0,
    medium: 1,
    important: 2,
    critical: 3
  };
  const threshold = order[failOn];

  if (threshold === undefined) {
    return false;
  }

  return report.findings.some((finding) => order[finding.severity] >= threshold);
}

function normalizeCodexFinding(finding) {
  return {
    severity: finding.severity,
    confidence: finding.confidence,
    file: finding.file,
    line: Math.max(1, parseInt(finding.line, 10) || 1),
    title: finding.title,
    evidence: finding.evidence,
    impact: finding.impact,
    fixDirection: finding.fix_direction
  };
}

function commandExists(command) {
  try {
    runCommand(command, ['--version']);
    return true;
  } catch (error) {
    return false;
  }
}

function collectFileContexts(cwd, fileEntries, baseRef, diffText, highRiskPaths) {
  return fileEntries.map((entry) => {
    const filePath = entry.path;
    return {
      path: filePath,
      highRisk: isHighRiskPath(filePath, highRiskPaths),
      base: truncateText(getBaseContent(cwd, baseRef, filePath), 8000),
      current: truncateText(getCurrentContent(cwd, filePath), 12000),
      changedLines: extractChangedLines(diffText, filePath).slice(0, 80)
    };
  });
}

function buildPrompt(payload) {
  return [
    'You are performing a local pre-PR code review for a WordPress-oriented repository.',
    'Review only the supplied local diff and file context.',
    'Prioritize real bugs, security issues, compatibility risks, data integrity problems, and missing verification around risky changes.',
    'Do not emit style-only feedback.',
    'Do not speculate without evidence from the provided diff or file contents.',
    'If there are no meaningful findings, return an empty findings array and APPROVE.',
    '',
    'Severity rules:',
    '- critical: confirmed security issue, destructive data corruption, or severe payment flaw',
    '- important: confirmed auth/nonce/capability bug, high-confidence regression, major compatibility or persistence issue',
    '- medium: likely bug with bounded impact, meaningful performance issue, risky unverified change',
    '- low: minor but worthwhile maintainability or verification gap',
    '',
    'Confidence rules:',
    '- high: directly supported by code evidence',
    '- medium: likely from nearby code evidence but still somewhat inferential',
    '- low: weak signal; avoid unless still useful',
    '',
    `Review mode: ${payload.mode}`,
    `Base ref: ${payload.baseRef}`,
    '',
    'Priority focus areas:',
    JSON.stringify(payload.focusAreas, null, 2),
    '',
    'Repo instructions:',
    JSON.stringify(payload.instructions, null, 2),
    '',
    'Heuristic hotspots:',
    JSON.stringify(payload.heuristicHotspots, null, 2),
    '',
    'Diff stats:',
    JSON.stringify(payload.diffStats, null, 2),
    '',
    'Unified diff:',
    payload.diffText || '(no diff text)',
    '',
    'Changed file context:',
    JSON.stringify(payload.fileContexts, null, 2),
    '',
    'Return only JSON matching the schema.'
  ].join('\n');
}

function isGeneratedOrBinaryPath(filePath) {
  return (
    /(^|\/)(build|builds|dist|coverage|vendor)\//i.test(filePath) ||
    /mix-manifest\.json$/i.test(filePath) ||
    /\.(zip|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|pdf|mp4|mp3|mov)$/i.test(filePath)
  );
}

function selectCodexFileEntries(reviewContext, heuristicSeed, options) {
  const selected = [];
  const seen = new Set();
  const fileMap = new Map(reviewContext.fileEntries.map((entry) => [entry.path, entry]));

  function tryAdd(filePath) {
    if (!filePath || seen.has(filePath)) {
      return;
    }

    const entry = fileMap.get(filePath);
    if (!entry || isGeneratedOrBinaryPath(filePath)) {
      return;
    }

    selected.push(entry);
    seen.add(filePath);
  }

  heuristicSeed.findings.forEach((finding) => tryAdd(finding.file));

  if (options.files.length) {
    options.files.forEach((filePath) => tryAdd(filePath));
  }

  reviewContext.fileEntries
    .filter((entry) => entry.status.trim() && entry.status !== '??')
    .forEach((entry) => tryAdd(entry.path));

  reviewContext.fileEntries
    .filter((entry) => isHighRiskPath(entry.path, options.highRiskPaths))
    .forEach((entry) => tryAdd(entry.path));

  reviewContext.fileEntries.forEach((entry) => tryAdd(entry.path));

  return selected.slice(0, CODEX_FILE_LIMIT);
}

function runCodexReview(payload, options, cwd) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-'));
  const schemaPath = path.join(tempDir, 'schema.json');
  const outputPath = path.join(tempDir, 'output.json');
  const prompt = buildPrompt(payload);

  writeJsonFile(schemaPath, REVIEW_SCHEMA);

  const args = [
    'exec',
    '-',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--output-schema',
    schemaPath,
    '-o',
    outputPath,
    '-C',
    cwd
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  try {
    runCommand('codex', args, {
      cwd,
      input: prompt,
      maxBuffer: 32 * 1024 * 1024
    });

    const parsed = JSON.parse(safeReadFile(outputPath));
    return {
      engine: 'codex',
      fallbackUsed: false,
      notes: [],
      verdict: parsed.verdict,
      confidenceScore: parsed.confidence_score,
      summary: parsed.summary,
      findings: (parsed.findings || []).map(normalizeCodexFinding)
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runHeuristicReview(options, reviewContext, notes = [], engine = 'heuristic', fallbackUsed = false) {
  const { baseRef, fileEntries, instructions, diffText } = reviewContext;
  const findings = [];
  const changedTestFiles = getChangedTestFiles(fileEntries);

  for (const entry of fileEntries) {
    const filePath = entry.path;
    const currentContent = getCurrentContent(reviewContext.cwd, filePath);
    const baseContent = getBaseContent(reviewContext.cwd, baseRef, filePath);
    const changedLines = extractChangedLines(diffText, filePath);
    const fileFindings = analyzeFile({
      filePath,
      currentContent,
      baseContent,
      changedLines,
      mode: options.mode,
      highRiskPaths: options.highRiskPaths
    });

    fileFindings.forEach((finding) => pushFinding(findings, finding));
  }

  if (!changedTestFiles.length && fileEntries.some((entry) => isHighRiskPath(entry.path, options.highRiskPaths)) && options.mode === 'full') {
    pushFinding(findings, {
      severity: 'medium',
      confidence: 'low',
      file: fileEntries.find((entry) => isHighRiskPath(entry.path, options.highRiskPaths)).path,
      line: 1,
      title: 'High-risk changes landed without matching test changes',
      evidence: 'The current diff touches high-risk paths but does not include test file changes.',
      impact: 'Risky changes are harder to trust before PR review when no targeted verification moves with them.',
      fixDirection: 'Add targeted tests or document the manual verification steps before opening the PR.'
    });
  }

  const rankedFindings = rankFindings(findings).slice(0, options.maxFindings);
  return {
    engine,
    fallbackUsed,
    notes,
    verdict: buildVerdict(rankedFindings),
    confidenceScore: buildConfidence(rankedFindings),
    summary: buildSummary(rankedFindings, summarizeScope(fileEntries, instructions), {
      base: baseRef || '--staged'
    }),
    findings: rankedFindings
  };
}

function createReviewContext(options, cwd) {
  const baseRef = options.staged ? null : (options.base || resolveDefaultBase(cwd));
  const fileEntries = listChangedFiles(cwd, options, baseRef);
  const instructions = getRepoInstructions(cwd, options.repoConfigPath);
  const diffText = getUnifiedDiff(cwd, baseRef, options, fileEntries.map((entry) => entry.path));

  return {
    cwd,
    baseRef,
    fileEntries,
    instructions,
    diffText
  };
}

function buildFinalReport(options, reviewContext, reviewResult) {
  const { baseRef, fileEntries, instructions } = reviewContext;
  const rankedFindings = rankFindings((reviewResult.findings || []).map((finding) => ({
    severity: finding.severity,
    confidence: finding.confidence,
    file: finding.file,
    line: finding.line,
    title: finding.title,
    evidence: finding.evidence,
    impact: finding.impact,
    fixDirection: finding.fixDirection
  }))).slice(0, options.maxFindings);
  const scope = summarizeScope(fileEntries, instructions);
  const report = {
    verdict: reviewResult.verdict || buildVerdict(rankedFindings),
    confidenceScore: reviewResult.confidenceScore || buildConfidence(rankedFindings),
    baseRef: baseRef || '--staged',
    mode: options.mode,
    engine: reviewResult.engine,
    fallbackUsed: Boolean(reviewResult.fallbackUsed),
    notes: reviewResult.notes || [],
    summary: reviewResult.summary || buildSummary(rankedFindings, scope, {
      base: baseRef || '--staged'
    }),
    scope,
    findings: rankedFindings,
    diffStats: {
      files: fileEntries.length,
      testsChanged: getChangedTestFiles(fileEntries).length
    }
  };

  if (options.format === 'json') {
    report.rendered = JSON.stringify(report, null, 2);
  } else if (options.format === 'markdown') {
    report.rendered = renderMarkdown(report);
  } else {
    report.rendered = renderText(report);
  }

  report.exitCode = shouldFail(report, options.failOn) ? 2 : 0;
  return report;
}

function createReviewReport(options, cwd = process.cwd()) {
  const loadedConfig = loadRepoConfig(cwd);
  const resolvedOptions = resolveOptions(options, loadedConfig.config);
  resolvedOptions.repoConfigPath = loadedConfig.configPath;
  const reviewContext = createReviewContext(resolvedOptions, cwd);
  const scope = summarizeScope(reviewContext.fileEntries, reviewContext.instructions);
  const baseNotes = [];

  if (loadedConfig.configPath) {
    baseNotes.push(`Loaded repo config from ${path.relative(cwd, loadedConfig.configPath)}`);
  }

  baseNotes.push(...resolvedOptions.configNotes);

  if (!scope.reviewedFiles.length) {
    return buildFinalReport(resolvedOptions, reviewContext, {
      engine: resolvedOptions.engine === 'codex' ? 'codex' : 'heuristic',
      fallbackUsed: false,
      notes: baseNotes,
      verdict: 'APPROVE',
      confidenceScore: 4,
      summary: 'No local changes were found for review.',
      findings: []
    });
  }

  const heuristicSeed = runHeuristicReview(resolvedOptions, reviewContext, baseNotes.slice(), 'heuristic', false);
  const shouldUseCodex = resolvedOptions.engine === 'codex' || resolvedOptions.engine === 'auto';

  if (shouldUseCodex) {
    const notes = baseNotes.slice();

    if (!commandExists('codex')) {
      if (resolvedOptions.engine === 'codex') {
        throw new Error('codex CLI is not available in PATH.');
      }

      notes.push('Codex CLI was not available, so the report used heuristic review only.');
      return buildFinalReport(resolvedOptions, reviewContext, runHeuristicReview(resolvedOptions, reviewContext, notes, 'heuristic', true));
    }

    const selectedEntries = selectCodexFileEntries(reviewContext, heuristicSeed, resolvedOptions);
    const selectedDiff = getUnifiedDiff(cwd, reviewContext.baseRef, resolvedOptions, selectedEntries.map((entry) => entry.path));

    if (selectedEntries.length < reviewContext.fileEntries.length) {
      notes.push(`Codex scope narrowed to ${selectedEntries.length} of ${reviewContext.fileEntries.length} changed files for prompt size control.`);
    }

    const payload = {
      mode: resolvedOptions.mode,
      baseRef: reviewContext.baseRef || '--staged',
      focusAreas: resolvedOptions.focusAreas,
      instructions: reviewContext.instructions,
      heuristicHotspots: heuristicSeed.findings.slice(0, 8).map((finding) => ({
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        title: finding.title
      })),
      diffStats: {
        files: reviewContext.fileEntries.length,
        codexScopedFiles: selectedEntries.length,
        testsChanged: getChangedTestFiles(reviewContext.fileEntries).length
      },
      diffText: truncateText(selectedDiff, 30000),
      fileContexts: collectFileContexts(cwd, selectedEntries, reviewContext.baseRef, selectedDiff, resolvedOptions.highRiskPaths)
    };

    try {
      const codexResult = runCodexReview(payload, resolvedOptions, cwd);
      codexResult.notes = notes.slice();
      return buildFinalReport(resolvedOptions, reviewContext, codexResult);
    } catch (error) {
      if (resolvedOptions.engine === 'codex') {
        throw new Error(`Codex review failed: ${error.message}`);
      }

      notes.push(`Codex review failed, so the report used heuristic fallback: ${error.message}`);
      return buildFinalReport(resolvedOptions, reviewContext, runHeuristicReview(resolvedOptions, reviewContext, notes, 'codex', true));
    }
  }

  return buildFinalReport(resolvedOptions, reviewContext, heuristicSeed);
}

module.exports = {
  createReviewReport,
  parseArgs
};
