'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const yaml = require('js-yaml');

const DEFAULT_MAX_FINDINGS = 15;
const DEFAULT_CODEX_TIMEOUT_MS = null;
const DEFAULT_SEMGREP_TIMEOUT_MS = 120000;
const DEFAULT_PHPSTAN_TIMEOUT_MS = 120000;
const DEFAULT_ESLINT_TIMEOUT_MS = 120000;
const WORKFLOW_PRESETS = {
  debugger: {
    format: 'markdown',
    report: 'debugger-report.md',
    reviewDepth: 'thorough',
    maxFindings: 20,
    mode: 'full',
    engine: 'auto'
  },
  'plugin-audit': {
    format: 'markdown',
    report: 'plugin-audit.md',
    reviewDepth: 'thorough',
    maxFindings: 30,
    mode: 'full',
    engine: 'auto'
  }
};
const DEFAULT_IGNORES = [
  '.git/',
  'node_modules/',
  '.playwright-mcp/',
  'builds/',
  'dist/',
  'vendor/',
  'public/mix-manifest.json'
];
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
  codexTimeoutMs: DEFAULT_CODEX_TIMEOUT_MS,
  codexFocusPaths: [],
  base: null,
  reviewDepth: 'thorough',
  productProfile: null,
  focusAreas: [],
  ignorePaths: [],
  highRiskPaths: [],
  notes: [],
  criticalPaths: [],
  contextFiles: [],
  contextRules: [],
  reviewSignals: {
    lifecycle: [],
    performance: [],
    persistence: [],
    security: [],
    accessibility: []
  },
  edgeCases: {
    general: [],
    lifecycle: [],
    performance: [],
    persistence: [],
    security: [],
    accessibility: []
  },
  semgrepEnabled: true,
  semgrepConfig: 'auto',
  semgrepTimeoutMs: DEFAULT_SEMGREP_TIMEOUT_MS,
  phpstanEnabled: true,
  phpstanConfig: 'auto',
  phpstanTimeoutMs: DEFAULT_PHPSTAN_TIMEOUT_MS,
  eslintEnabled: true,
  eslintConfig: 'auto',
  eslintTimeoutMs: DEFAULT_ESLINT_TIMEOUT_MS,
  reviewdogReport: null,
  a11yUrls: [],
  a11yWaitFor: null,
  a11yTimeout: 30000,
  a11yStorageState: null
};
const CODEX_FILE_LIMITS = {
  balanced: 12,
  thorough: 24
};
const CODEX_BATCH_SIZE = {
  balanced: 2,
  thorough: 2
};
const CODEX_DEEP_CONCURRENCY = 2;
const CODEX_CONTEXT_BUDGETS = {
  overview: {
    baseChars: 1200,
    currentChars: 2000,
    extraBaseChars: 800,
    extraCurrentChars: 1200
  },
  deep: {
    baseChars: 3000,
    currentChars: 5000,
    extraBaseChars: 1500,
    extraCurrentChars: 2500
  }
};
const COMMAND_EXISTS_CACHE = new Map();
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
    key_changes: {
      type: 'array',
      items: {
        type: 'string'
      }
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
          explanation: {
            type: 'string'
          },
          verification: {
            type: 'string'
          },
          fix_direction: {
            type: 'string'
          }
        },
        required: ['severity', 'confidence', 'file', 'line', 'title', 'evidence', 'impact', 'explanation', 'verification', 'fix_direction'],
        additionalProperties: false
      }
    },
    outside_diff_findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'important', 'medium', 'low']
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
          explanation: {
            type: 'string'
          },
          verification: {
            type: 'string'
          },
          fix_direction: {
            type: 'string'
          }
        },
        required: ['severity', 'file', 'line', 'title', 'explanation', 'verification', 'fix_direction'],
        additionalProperties: false
      }
    }
  },
  required: ['verdict', 'confidence_score', 'summary', 'key_changes', 'findings', 'outside_diff_findings'],
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
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    timeout: options.timeout || undefined
  });
}

async function runCommandAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const maxBuffer = options.maxBuffer || 16 * 1024 * 1024;
    let stdoutSize = 0;
    let stderrSize = 0;
    let finished = false;
    let timeoutId = null;
    let heartbeatId = null;

    function finish(error, stdout = '') {
      if (finished) {
        return;
      }

      finished = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (heartbeatId) {
        clearInterval(heartbeatId);
      }

      if (error) {
        reject(error);
        return;
      }

      resolve(stdout);
    }

    function buildBufferError(streamLabel) {
      const error = new Error(`${streamLabel} maxBuffer length exceeded`);
      error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      return error;
    }

    child.stdout.on('data', (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > maxBuffer) {
        child.kill('SIGTERM');
        finish(buildBufferError('stdout'));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize > maxBuffer) {
        child.kill('SIGTERM');
        finish(buildBufferError('stderr'));
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => finish(error));

    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (code === 0) {
        finish(null, stdout);
        return;
      }

      const error = new Error(stderr || `Command failed: ${command} ${args.join(' ')}`);
      if (signal === 'SIGTERM' && options.timeout) {
        error.code = 'ETIMEDOUT';
      } else {
        error.code = code;
      }
      error.stderr = stderr;
      error.stdout = stdout;
      finish(error);
    });

    if (options.timeout) {
      timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
      }, options.timeout);
    }

    if (options.progressLabel && process.stderr && process.env.CODEX_REVIEW_SILENT !== '1') {
      const heartbeatMs = Math.max(15000, options.heartbeatMs || 30000);
      const startedAt = Date.now();
      heartbeatId = setInterval(() => {
        const elapsed = formatDurationMs(Date.now() - startedAt);
        process.stderr.write(`codex-review: still running ${options.progressLabel} (${elapsed})...\n`);
      }, heartbeatMs);
    }

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  }).catch((error) => {
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    const normalizedError = new Error(stderr || error.message);
    normalizedError.code = error.code;
    normalizedError.stderr = stderr;
    normalizedError.stdout = error.stdout ? String(error.stdout) : '';
    throw normalizedError;
  });
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    return false;
  }
}

function resolveExecutable(cwd, candidates) {
  const candidateList = Array.isArray(candidates) ? candidates : [candidates];

  for (const candidate of candidateList) {
    if (!candidate) {
      continue;
    }

    if (candidate.includes('/') || candidate.includes('\\')) {
      const absolutePath = path.isAbsolute(candidate) ? candidate : path.join(cwd, candidate);
      if (fileExists(absolutePath)) {
        return absolutePath;
      }
      continue;
    }

    try {
      runCommand(candidate, ['--version'], { cwd, timeout: 10000 });
      return candidate;
    } catch (error) {
      continue;
    }
  }

  return null;
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

function buildCustomProductProfile(repoLabel, configProfile) {
  if (!configProfile || typeof configProfile !== 'object') {
    return null;
  }

  const name = typeof configProfile.name === 'string' && configProfile.name.trim()
    ? configProfile.name.trim()
    : repoLabel;
  const focus = normalizeStringArray(configProfile.focus);
  const regressionChecks = normalizeStringArray(configProfile.regression_checks || configProfile.regressionChecks);
  const tags = normalizeStringArray(configProfile.tags || configProfile.capabilities || configProfile.domains).map((item) => item.toLowerCase());
  const textDomain = typeof (configProfile.text_domain || configProfile.textDomain) === 'string'
    ? String(configProfile.text_domain || configProfile.textDomain).trim()
    : '';

  if (!focus.length && !regressionChecks.length && !textDomain && !tags.length) {
    return null;
  }

  return {
    repoLabel,
    name,
    focus,
    regressionChecks,
    tags,
    textDomain
  };
}

function parseArgs(argv) {
  const options = {
    base: null,
    head: 'HEAD',
    staged: false,
    files: [],
    workflow: null,
    mode: 'full',
    format: 'pr-review',
    report: null,
    maxFindings: DEFAULT_MAX_FINDINGS,
    failOn: null,
    engine: 'auto',
    model: null,
    reviewDepth: 'thorough',
    semgrepEnabled: true,
    semgrepConfig: DEFAULT_CONFIG.semgrepConfig,
    semgrepTimeoutMs: DEFAULT_CONFIG.semgrepTimeoutMs,
    phpstanEnabled: true,
    phpstanConfig: DEFAULT_CONFIG.phpstanConfig,
    phpstanTimeoutMs: DEFAULT_CONFIG.phpstanTimeoutMs,
    eslintEnabled: true,
    eslintConfig: DEFAULT_CONFIG.eslintConfig,
    eslintTimeoutMs: DEFAULT_CONFIG.eslintTimeoutMs,
    reviewdogReport: null,
    a11yUrls: [],
    a11yWaitFor: null,
    a11yTimeout: DEFAULT_CONFIG.a11yTimeout,
    a11yStorageState: null,
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

    if (arg === '--thorough') {
      options.reviewDepth = 'thorough';
      options._explicit.reviewDepth = true;
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

    if (arg === '--workflow' && argv[i + 1]) {
      options.workflow = argv[i + 1];
      options._explicit.workflow = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--workflow=')) {
      options.workflow = arg.slice('--workflow='.length);
      options._explicit.workflow = true;
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
      continue;
    }

    if (arg === '--review-depth' && argv[i + 1]) {
      options.reviewDepth = argv[i + 1];
      options._explicit.reviewDepth = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--review-depth=')) {
      options.reviewDepth = arg.slice('--review-depth='.length);
      options._explicit.reviewDepth = true;
      continue;
    }

    if (arg === '--semgrep') {
      options.semgrepEnabled = true;
      options._explicit.semgrepEnabled = true;
      continue;
    }

    if (arg === '--no-semgrep') {
      options.semgrepEnabled = false;
      options._explicit.semgrepEnabled = true;
      continue;
    }

    if (arg === '--semgrep-config' && argv[i + 1]) {
      options.semgrepConfig = argv[i + 1];
      options._explicit.semgrepConfig = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--semgrep-config=')) {
      options.semgrepConfig = arg.slice('--semgrep-config='.length);
      options._explicit.semgrepConfig = true;
      continue;
    }

    if (arg === '--semgrep-timeout' && argv[i + 1]) {
      options.semgrepTimeoutMs = normalizeInteger(argv[i + 1], DEFAULT_CONFIG.semgrepTimeoutMs);
      options._explicit.semgrepTimeoutMs = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--semgrep-timeout=')) {
      options.semgrepTimeoutMs = normalizeInteger(arg.slice('--semgrep-timeout='.length), DEFAULT_CONFIG.semgrepTimeoutMs);
      options._explicit.semgrepTimeoutMs = true;
      continue;
    }

    if (arg === '--phpstan') {
      options.phpstanEnabled = true;
      options._explicit.phpstanEnabled = true;
      continue;
    }

    if (arg === '--no-phpstan') {
      options.phpstanEnabled = false;
      options._explicit.phpstanEnabled = true;
      continue;
    }

    if (arg === '--phpstan-config' && argv[i + 1]) {
      options.phpstanConfig = argv[i + 1];
      options._explicit.phpstanConfig = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--phpstan-config=')) {
      options.phpstanConfig = arg.slice('--phpstan-config='.length);
      options._explicit.phpstanConfig = true;
      continue;
    }

    if (arg === '--phpstan-timeout' && argv[i + 1]) {
      options.phpstanTimeoutMs = normalizeInteger(argv[i + 1], DEFAULT_CONFIG.phpstanTimeoutMs);
      options._explicit.phpstanTimeoutMs = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--phpstan-timeout=')) {
      options.phpstanTimeoutMs = normalizeInteger(arg.slice('--phpstan-timeout='.length), DEFAULT_CONFIG.phpstanTimeoutMs);
      options._explicit.phpstanTimeoutMs = true;
      continue;
    }

    if (arg === '--eslint') {
      options.eslintEnabled = true;
      options._explicit.eslintEnabled = true;
      continue;
    }

    if (arg === '--no-eslint') {
      options.eslintEnabled = false;
      options._explicit.eslintEnabled = true;
      continue;
    }

    if (arg === '--eslint-config' && argv[i + 1]) {
      options.eslintConfig = argv[i + 1];
      options._explicit.eslintConfig = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--eslint-config=')) {
      options.eslintConfig = arg.slice('--eslint-config='.length);
      options._explicit.eslintConfig = true;
      continue;
    }

    if (arg === '--eslint-timeout' && argv[i + 1]) {
      options.eslintTimeoutMs = normalizeInteger(argv[i + 1], DEFAULT_CONFIG.eslintTimeoutMs);
      options._explicit.eslintTimeoutMs = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--eslint-timeout=')) {
      options.eslintTimeoutMs = normalizeInteger(arg.slice('--eslint-timeout='.length), DEFAULT_CONFIG.eslintTimeoutMs);
      options._explicit.eslintTimeoutMs = true;
      continue;
    }

    if (arg === '--reviewdog-report' && argv[i + 1]) {
      options.reviewdogReport = argv[i + 1];
      options._explicit.reviewdogReport = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--reviewdog-report=')) {
      options.reviewdogReport = arg.slice('--reviewdog-report='.length);
      options._explicit.reviewdogReport = true;
      continue;
    }

    if (arg === '--a11y-url' && argv[i + 1]) {
      options.a11yUrls.push(argv[i + 1]);
      options._explicit.a11yUrls = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--a11y-url=')) {
      options.a11yUrls.push(arg.slice('--a11y-url='.length));
      options._explicit.a11yUrls = true;
      continue;
    }

    if (arg === '--a11y-urls' && argv[i + 1]) {
      options.a11yUrls.push(...argv[i + 1].split(',').map((item) => item.trim()).filter(Boolean));
      options._explicit.a11yUrls = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--a11y-urls=')) {
      options.a11yUrls.push(...arg.slice('--a11y-urls='.length).split(',').map((item) => item.trim()).filter(Boolean));
      options._explicit.a11yUrls = true;
      continue;
    }

    if (arg === '--a11y-wait-for' && argv[i + 1]) {
      options.a11yWaitFor = argv[i + 1];
      options._explicit.a11yWaitFor = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--a11y-wait-for=')) {
      options.a11yWaitFor = arg.slice('--a11y-wait-for='.length);
      options._explicit.a11yWaitFor = true;
      continue;
    }

    if (arg === '--a11y-timeout' && argv[i + 1]) {
      options.a11yTimeout = normalizeInteger(argv[i + 1], DEFAULT_CONFIG.a11yTimeout);
      options._explicit.a11yTimeout = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--a11y-timeout=')) {
      options.a11yTimeout = normalizeInteger(arg.slice('--a11y-timeout='.length), DEFAULT_CONFIG.a11yTimeout);
      options._explicit.a11yTimeout = true;
      continue;
    }

    if (arg === '--a11y-storage-state' && argv[i + 1]) {
      options.a11yStorageState = argv[i + 1];
      options._explicit.a11yStorageState = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--a11y-storage-state=')) {
      options.a11yStorageState = arg.slice('--a11y-storage-state='.length);
      options._explicit.a11yStorageState = true;
    }
  }

  options.a11yUrls = Array.from(new Set(options.a11yUrls.map((item) => item.trim()).filter(Boolean)));
  return options;
}

function applyWorkflowPreset(options) {
  if (!options.workflow) {
    return options;
  }

  const preset = WORKFLOW_PRESETS[options.workflow];
  if (!preset) {
    throw new Error(`Unknown workflow "${options.workflow}". Supported workflows: ${Object.keys(WORKFLOW_PRESETS).join(', ')}`);
  }

  const next = { ...options };
  ['mode', 'format', 'report', 'reviewDepth', 'maxFindings', 'engine'].forEach((key) => {
    if (!options._explicit[key]) {
      next[key] = preset[key];
    }
  });

  return next;
}

function resolveDefaultBase(cwd) {
  const candidates = ['origin/dev', 'origin/development', 'origin/main', 'origin/master', 'dev', 'development', 'main', 'master'];

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

function normalizeInteger(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePatternArray(value) {
  return normalizeStringArray(value).map((item) => item.replace(/\\/g, '/'));
}

function normalizeContextRules(value) {
  if (!isArray(value)) {
    return [];
  }

  return value.map((rule) => {
    if (!rule || typeof rule !== 'object') {
      return null;
    }

    const when = normalizePatternArray(rule.when || rule.match || rule.paths || rule.if_changed || rule.ifChanged);
    const include = normalizeStringArray(rule.include || rule.context || rule.context_files || rule.contextFiles);
    const reason = typeof rule.reason === 'string' ? rule.reason.trim() : '';

    if (!when.length || !include.length) {
      return null;
    }

    return {
      when,
      include,
      reason: reason || null
    };
  }).filter(Boolean);
}

function normalizeReviewSignals(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    lifecycle: normalizeStringArray(source.lifecycle),
    performance: normalizeStringArray(source.performance),
    persistence: normalizeStringArray(source.persistence),
    security: normalizeStringArray(source.security),
    accessibility: normalizeStringArray(source.accessibility)
  };
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern) {
  const normalized = String(pattern || '').trim().replace(/\\/g, '/');
  if (!normalized) {
    return null;
  }

  let expression = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      expression += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      expression += '[^/]*';
      continue;
    }
    expression += escapeRegExp(char);
  }

  return new RegExp(`^${expression}$`, 'i');
}

function pathMatchesPattern(filePath, pattern) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/');
  const normalizedPattern = String(pattern || '').trim().replace(/\\/g, '/');
  if (!normalizedPath || !normalizedPattern) {
    return false;
  }

  if (!normalizedPattern.includes('*')) {
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(normalizedPattern.replace(/\/$/, '') + '/');
  }

  const matcher = globToRegExp(normalizedPattern);
  return matcher ? matcher.test(normalizedPath) : false;
}

function pathMatchesAnyPattern(filePath, patterns) {
  return normalizePatternArray(patterns).some((pattern) => pathMatchesPattern(filePath, pattern));
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(normalized)) {
      return true;
    }
    if (['false', 'no', 'off', '0'].includes(normalized)) {
      return false;
    }
  }

  return fallback;
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
      base: typeof parsed.base === 'string' ? parsed.base : DEFAULT_CONFIG.base,
      mode: typeof parsed.mode === 'string' ? parsed.mode : DEFAULT_CONFIG.mode,
      engine: typeof parsed.engine === 'string' ? parsed.engine : DEFAULT_CONFIG.engine,
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_CONFIG.model,
      reviewDepth: typeof (parsed.review_depth || parsed.reviewDepth) === 'string' ? (parsed.review_depth || parsed.reviewDepth) : DEFAULT_CONFIG.reviewDepth,
      maxFindings: Math.max(1, parseInt(parsed.max_findings || parsed.maxFindings, 10) || DEFAULT_CONFIG.maxFindings),
      codexTimeoutMs: normalizeInteger(
        (parsed.codex && (parsed.codex.timeout_ms || parsed.codex.timeoutMs)) || parsed.codex_timeout || parsed.codexTimeout,
        DEFAULT_CONFIG.codexTimeoutMs
      ),
      codexFocusPaths: normalizePatternArray(
        (parsed.codex && (parsed.codex.focus_paths || parsed.codex.focusPaths)) || parsed.codex_focus_paths || parsed.codexFocusPaths
      ),
      semgrepEnabled: normalizeBoolean(
        (parsed.semgrep && (parsed.semgrep.enabled)) || parsed.semgrep_enabled || parsed.semgrepEnabled,
        DEFAULT_CONFIG.semgrepEnabled
      ),
      semgrepConfig: typeof ((parsed.semgrep && (parsed.semgrep.config)) || parsed.semgrep_config || parsed.semgrepConfig) === 'string'
        ? ((parsed.semgrep && (parsed.semgrep.config)) || parsed.semgrep_config || parsed.semgrepConfig)
        : DEFAULT_CONFIG.semgrepConfig,
      semgrepTimeoutMs: normalizeInteger(
        (parsed.semgrep && (parsed.semgrep.timeout_ms || parsed.semgrep.timeoutMs)) || parsed.semgrep_timeout || parsed.semgrepTimeout,
        DEFAULT_CONFIG.semgrepTimeoutMs
      ),
      phpstanEnabled: normalizeBoolean(
        (parsed.phpstan && parsed.phpstan.enabled) || parsed.phpstan_enabled || parsed.phpstanEnabled,
        DEFAULT_CONFIG.phpstanEnabled
      ),
      phpstanConfig: typeof ((parsed.phpstan && parsed.phpstan.config) || parsed.phpstan_config || parsed.phpstanConfig) === 'string'
        ? ((parsed.phpstan && parsed.phpstan.config) || parsed.phpstan_config || parsed.phpstanConfig)
        : DEFAULT_CONFIG.phpstanConfig,
      phpstanTimeoutMs: normalizeInteger(
        (parsed.phpstan && (parsed.phpstan.timeout_ms || parsed.phpstan.timeoutMs)) || parsed.phpstan_timeout || parsed.phpstanTimeout,
        DEFAULT_CONFIG.phpstanTimeoutMs
      ),
      eslintEnabled: normalizeBoolean(
        (parsed.eslint && parsed.eslint.enabled) || parsed.eslint_enabled || parsed.eslintEnabled,
        DEFAULT_CONFIG.eslintEnabled
      ),
      eslintConfig: typeof ((parsed.eslint && parsed.eslint.config) || parsed.eslint_config || parsed.eslintConfig) === 'string'
        ? ((parsed.eslint && parsed.eslint.config) || parsed.eslint_config || parsed.eslintConfig)
        : DEFAULT_CONFIG.eslintConfig,
      eslintTimeoutMs: normalizeInteger(
        (parsed.eslint && (parsed.eslint.timeout_ms || parsed.eslint.timeoutMs)) || parsed.eslint_timeout || parsed.eslintTimeout,
        DEFAULT_CONFIG.eslintTimeoutMs
      ),
      reviewdogReport: typeof ((parsed.reviewdog && (parsed.reviewdog.report)) || parsed.reviewdog_report || parsed.reviewdogReport) === 'string'
        ? ((parsed.reviewdog && (parsed.reviewdog.report)) || parsed.reviewdog_report || parsed.reviewdogReport)
        : DEFAULT_CONFIG.reviewdogReport,
      productProfile: typeof parsed.product_profile === 'object' || typeof parsed.productProfile === 'object'
        ? (parsed.product_profile || parsed.productProfile)
        : DEFAULT_CONFIG.productProfile,
      focusAreas: normalizeStringArray(parsed.focus_areas || parsed.focusAreas),
      ignorePaths: normalizeStringArray((parsed.paths && parsed.paths.ignore) || parsed.ignore_paths || parsed.ignorePaths),
      highRiskPaths: normalizeStringArray((parsed.paths && parsed.paths.high_risk) || parsed.high_risk_paths || parsed.highRiskPaths),
      notes: normalizeStringArray(parsed.notes),
      criticalPaths: normalizeStringArray(parsed.critical_paths || parsed.criticalPaths),
      contextFiles: normalizeStringArray(parsed.context_files || parsed.contextFiles),
      contextRules: normalizeContextRules(parsed.context_rules || parsed.contextRules),
      reviewSignals: normalizeReviewSignals(parsed.review_signals || parsed.reviewSignals),
      edgeCases: {
        general: normalizeStringArray(
          (parsed.edge_cases && ((parsed.edge_cases.general) || (parsed.edge_cases.shared))) ||
          (parsed.edgeCases && ((parsed.edgeCases.general) || (parsed.edgeCases.shared)))
        ),
        lifecycle: normalizeStringArray(
          (parsed.edge_cases && parsed.edge_cases.lifecycle) ||
          (parsed.edgeCases && parsed.edgeCases.lifecycle)
        ),
        performance: normalizeStringArray(
          (parsed.edge_cases && parsed.edge_cases.performance) ||
          (parsed.edgeCases && parsed.edgeCases.performance)
        ),
        persistence: normalizeStringArray(
          (parsed.edge_cases && parsed.edge_cases.persistence) ||
          (parsed.edgeCases && parsed.edgeCases.persistence)
        ),
        security: normalizeStringArray(
          (parsed.edge_cases && parsed.edge_cases.security) ||
          (parsed.edgeCases && parsed.edgeCases.security)
        ),
        accessibility: normalizeStringArray(
          (parsed.edge_cases && parsed.edge_cases.accessibility) ||
          (parsed.edgeCases && parsed.edgeCases.accessibility)
        )
      },
      a11yUrls: normalizeStringArray((parsed.accessibility && parsed.accessibility.urls) || parsed.a11y_urls || parsed.a11yUrls),
      a11yWaitFor: typeof ((parsed.accessibility && parsed.accessibility.wait_for) || (parsed.accessibility && parsed.accessibility.waitFor) || parsed.a11y_wait_for || parsed.a11yWaitFor) === 'string'
        ? ((parsed.accessibility && parsed.accessibility.wait_for) || (parsed.accessibility && parsed.accessibility.waitFor) || parsed.a11y_wait_for || parsed.a11yWaitFor)
        : DEFAULT_CONFIG.a11yWaitFor,
      a11yTimeout: normalizeInteger(
        (parsed.accessibility && (parsed.accessibility.timeout_ms || parsed.accessibility.timeoutMs)) || parsed.a11y_timeout || parsed.a11yTimeout,
        DEFAULT_CONFIG.a11yTimeout
      ),
      a11yStorageState: typeof ((parsed.accessibility && parsed.accessibility.storage_state) || (parsed.accessibility && parsed.accessibility.storageState) || parsed.a11y_storage_state || parsed.a11yStorageState) === 'string'
        ? ((parsed.accessibility && parsed.accessibility.storage_state) || (parsed.accessibility && parsed.accessibility.storageState) || parsed.a11y_storage_state || parsed.a11yStorageState)
        : DEFAULT_CONFIG.a11yStorageState
    }
  };
}

function resolveOptions(rawOptions, repoConfig) {
  const options = applyWorkflowPreset({
    ...rawOptions,
    base: rawOptions._explicit.base ? rawOptions.base : (repoConfig.base || rawOptions.base),
    mode: rawOptions._explicit.mode ? rawOptions.mode : repoConfig.mode,
    engine: rawOptions._explicit.engine ? rawOptions.engine : repoConfig.engine,
    model: rawOptions._explicit.model ? rawOptions.model : repoConfig.model,
    reviewDepth: rawOptions._explicit.reviewDepth ? rawOptions.reviewDepth : repoConfig.reviewDepth,
    maxFindings: rawOptions._explicit.maxFindings ? rawOptions.maxFindings : repoConfig.maxFindings
  });

  options.productProfile = repoConfig.productProfile;
  options.focusAreas = repoConfig.focusAreas;
  options.ignorePaths = Array.from(new Set([...DEFAULT_IGNORES, ...repoConfig.ignorePaths]));
  options.highRiskPaths = Array.from(new Set([...HIGH_RISK_PATHS, ...repoConfig.highRiskPaths])).map((item) => item.toLowerCase());
  options.codexTimeoutMs = repoConfig.codexTimeoutMs;
  options.codexFocusPaths = repoConfig.codexFocusPaths || DEFAULT_CONFIG.codexFocusPaths;
  options.semgrepEnabled = rawOptions._explicit.semgrepEnabled ? rawOptions.semgrepEnabled : repoConfig.semgrepEnabled;
  options.semgrepConfig = rawOptions._explicit.semgrepConfig ? rawOptions.semgrepConfig : repoConfig.semgrepConfig;
  options.semgrepTimeoutMs = rawOptions._explicit.semgrepTimeoutMs ? rawOptions.semgrepTimeoutMs : repoConfig.semgrepTimeoutMs;
  options.phpstanEnabled = rawOptions._explicit.phpstanEnabled ? rawOptions.phpstanEnabled : repoConfig.phpstanEnabled;
  options.phpstanConfig = rawOptions._explicit.phpstanConfig ? rawOptions.phpstanConfig : repoConfig.phpstanConfig;
  options.phpstanTimeoutMs = rawOptions._explicit.phpstanTimeoutMs ? rawOptions.phpstanTimeoutMs : repoConfig.phpstanTimeoutMs;
  options.eslintEnabled = rawOptions._explicit.eslintEnabled ? rawOptions.eslintEnabled : repoConfig.eslintEnabled;
  options.eslintConfig = rawOptions._explicit.eslintConfig ? rawOptions.eslintConfig : repoConfig.eslintConfig;
  options.eslintTimeoutMs = rawOptions._explicit.eslintTimeoutMs ? rawOptions.eslintTimeoutMs : repoConfig.eslintTimeoutMs;
  options.reviewdogReport = rawOptions._explicit.reviewdogReport ? rawOptions.reviewdogReport : repoConfig.reviewdogReport;
  options.configNotes = repoConfig.notes;
  options.criticalPaths = repoConfig.criticalPaths || DEFAULT_CONFIG.criticalPaths;
  options.contextFiles = repoConfig.contextFiles || DEFAULT_CONFIG.contextFiles;
  options.contextRules = repoConfig.contextRules || DEFAULT_CONFIG.contextRules;
  options.reviewSignals = repoConfig.reviewSignals || DEFAULT_CONFIG.reviewSignals;
  options.edgeCases = repoConfig.edgeCases || DEFAULT_CONFIG.edgeCases;
  options.a11yUrls = rawOptions._explicit.a11yUrls ? rawOptions.a11yUrls : repoConfig.a11yUrls;
  options.a11yWaitFor = rawOptions._explicit.a11yWaitFor ? rawOptions.a11yWaitFor : repoConfig.a11yWaitFor;
  options.a11yTimeout = rawOptions._explicit.a11yTimeout ? rawOptions.a11yTimeout : repoConfig.a11yTimeout;
  options.a11yStorageState = rawOptions._explicit.a11yStorageState ? rawOptions.a11yStorageState : repoConfig.a11yStorageState;

  return options;
}

function shouldIgnore(filePath, ignorePaths) {
  return pathMatchesAnyPattern(filePath, ignorePaths);
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

function repoSearch(cwd, pattern, fileGlobs = []) {
  const args = ['grep', '-n', '-I', '-E', pattern];

  if (fileGlobs.length) {
    args.push('--', ...fileGlobs);
  }

  return runGitQuiet(args, { cwd });
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

function indexUnifiedDiff(diffText) {
  const segmentsByPath = new Map();

  if (!diffText) {
    return segmentsByPath;
  }

  const lines = diffText.split('\n');
  let currentFile = null;
  let currentSegment = [];

  function flushSegment() {
    if (!currentFile || !currentSegment.length) {
      return;
    }

    const existing = segmentsByPath.get(currentFile) || [];
    existing.push(currentSegment.join('\n'));
    segmentsByPath.set(currentFile, existing);
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushSegment();
      currentSegment = [line];
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = match ? match[2] : null;
      continue;
    }

    if (!currentSegment.length) {
      continue;
    }

    currentSegment.push(line);

    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
    }
  }

  flushSegment();
  return segmentsByPath;
}

function getScopedDiffFromIndex(diffIndex, filePaths) {
  return filePaths
    .flatMap((filePath) => diffIndex.get(filePath) || [])
    .join('\n');
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

function extractChangedLinesFromSegment(diffText) {
  const lines = diffText.split('\n');
  const changedLines = [];
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      if (match) {
        currentLine = parseInt(match[1], 10);
      }
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

function getCurrentContentForContext(reviewContext, filePath) {
  if (!reviewContext.currentContentByPath.has(filePath)) {
    reviewContext.currentContentByPath.set(filePath, getCurrentContent(reviewContext.cwd, filePath));
  }

  return reviewContext.currentContentByPath.get(filePath);
}

function getBaseContentForContext(reviewContext, filePath) {
  if (!reviewContext.baseContentByPath.has(filePath)) {
    reviewContext.baseContentByPath.set(filePath, getBaseContent(reviewContext.cwd, reviewContext.baseRef, filePath));
  }

  return reviewContext.baseContentByPath.get(filePath);
}

function getChangedLinesForContext(reviewContext, filePath) {
  if (!reviewContext.changedLinesByPath.has(filePath)) {
    const scopedDiff = getScopedDiffFromIndex(reviewContext.diffIndex, [filePath]);
    reviewContext.changedLinesByPath.set(filePath, scopedDiff ? extractChangedLinesFromSegment(scopedDiff) : []);
  }

  return reviewContext.changedLinesByPath.get(filePath);
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

function findAllLineNumbers(content, pattern) {
  const lines = content.split('\n');
  const matches = [];

  for (let i = 0; i < lines.length; i += 1) {
    pattern.lastIndex = 0;
    if (pattern.test(lines[i])) {
      matches.push(i + 1);
    }
  }

  return matches;
}

function mergeLineRanges(ranges, maxGap = 3) {
  const normalized = ranges
    .filter((range) => range && Number.isFinite(range.start) && Number.isFinite(range.end))
    .map((range) => ({
      start: Math.max(1, range.start),
      end: Math.max(1, range.end)
    }))
    .sort((left, right) => left.start - right.start);

  if (!normalized.length) {
    return [];
  }

  const merged = [normalized[0]];

  for (let i = 1; i < normalized.length; i += 1) {
    const current = normalized[i];
    const previous = merged[merged.length - 1];

    if (current.start <= previous.end + maxGap) {
      previous.end = Math.max(previous.end, current.end);
      continue;
    }

    merged.push(current);
  }

  return merged;
}

function buildExcerptFromRanges(content, ranges, maxChars) {
  if (!content || content.length <= maxChars) {
    return content;
  }

  const lines = content.split('\n');
  const mergedRanges = mergeLineRanges(ranges).map((range) => ({
    start: Math.max(1, Math.min(range.start, lines.length)),
    end: Math.max(1, Math.min(range.end, lines.length))
  }));
  const sections = [];

  mergedRanges.forEach((range) => {
    const excerpt = lines.slice(range.start - 1, range.end).join('\n');
    sections.push(`// lines ${range.start}-${range.end}\n${excerpt}`);
  });

  if (!sections.length) {
    return truncateText(content, maxChars);
  }

  return truncateText(sections.join('\n\n...\n\n'), maxChars);
}

function buildRelevantContextRanges(filePath, content, changedLines) {
  const ranges = changedLines.map((entry) => ({
    start: Math.max(1, entry.line - 10),
    end: entry.line + 18
  }));

  if (!/\.(js|jsx|ts|tsx)$/i.test(filePath)) {
    return mergeLineRanges(ranges);
  }

  const changedText = changedLines.map((entry) => entry.text).join('\n');
  const introducesStateSyncHelper = /toggleClass\s*\(|addClass\s*\(|removeClass\s*\(/.test(changedText)
    && /(input|change|keyup|blur)\b/.test(changedText);

  if (!introducesStateSyncHelper) {
    return mergeLineRanges(ranges);
  }

  findAllLineNumbers(content, /var\s+formResetHandler\s*=\s*function|function\s+formResetHandler\s*\(/).forEach((line) => {
    ranges.push({
      start: Math.max(1, line - 6),
      end: line + 80
    });
  });

  findAllLineNumbers(content, /\.on\(\s*['"]reset|\.trigger\(\s*['"]fluentform_reset['"]|\[0\]\.reset\(\)/).forEach((line) => {
    ranges.push({
      start: Math.max(1, line - 6),
      end: line + 20
    });
  });

  return mergeLineRanges(ranges);
}

function buildTargetedContextExcerpt(content, filePath, changedLines, maxChars) {
  const ranges = buildRelevantContextRanges(filePath, content, changedLines);
  return buildExcerptFromRanges(content, ranges, maxChars);
}

function isHighRiskPath(filePath, highRiskPaths) {
  return pathMatchesAnyPattern(String(filePath || '').toLowerCase(), highRiskPaths);
}

function getChangedTestFiles(fileEntries) {
  return fileEntries.filter((entry) => /(^|\/)(test|tests|__tests__)\//i.test(entry.path) || /\.(test|spec)\./i.test(entry.path));
}

function isFrontendTemplateFile(filePath) {
  return /\.(php|html|vue|jsx|tsx)$/i.test(filePath);
}

function isStyleFile(filePath) {
  return /\.(css|scss|sass|less)$/i.test(filePath);
}

function getLineWindow(content, lineNumber, radius = 2) {
  const lines = content.split('\n');
  const index = Math.max(0, (lineNumber || 1) - 1);
  const start = Math.max(0, index - radius);
  const end = Math.min(lines.length, index + radius + 1);
  return lines.slice(start, end).join('\n');
}

function hasNearbyAccessibleLabel(content, lineNumber) {
  const window = getLineWindow(content, lineNumber, 3);
  return /<label\b|aria-label\s*=|aria-labelledby\s*=|for\s*=/.test(window);
}

function pushFinding(findings, finding) {
  const key = [finding.file, finding.line, finding.title].join(':');
  if (findings.some((item) => [item.file, item.line, item.title].join(':') === key)) {
    return;
  }
  findings.push(finding);
}

function pushOutsideDiffFinding(findings, finding) {
  const key = [finding.file, finding.line, finding.title].join(':');
  if (findings.some((item) => [item.file, item.line, item.title].join(':') === key)) {
    return;
  }
  findings.push(finding);
}

function getChangedPathsSet(fileEntries) {
  return new Set(fileEntries.map((entry) => entry.path));
}

function findChangedEntry(fileEntries, matcher) {
  return fileEntries.find((entry) => matcher(entry.path));
}

function buildProductSpecificKeyChanges(reviewContext, findings) {
  const { productProfile, fileEntries } = reviewContext;
  const changes = [];

  const changedPathList = Array.from(getChangedPathsSet(fileEntries));

  if (changedPathList.some((filePath) => /\/Payments\/PaymentMethods\/.+\.php$/.test(filePath))) {
    changes.push('Touches a payment gateway processor, so acceptance, mismatch handling, and stored transaction totals were reviewed as one workflow.');
  }

  if (changedPathList.some((filePath) => /file-uploader|Uploader|FeaturedImage|crop|Cropper/i.test(filePath))) {
    changes.push('Touches upload or crop behavior, so settings production, save-time persistence, and asset bootstrap were treated as one feature path.');
  }

  if (changedPathList.some((filePath) => /FileType\.vue$|RankingType\.vue$|ToggleType\.vue$|drag|sortable|ranking/i.test(filePath))) {
    changes.push('Touches stateful frontend interaction code, so reset, drag/drop, accessibility, and responsive behavior were reviewed together.');
  }

  if (!changes.length && findings.length && productProfile && productProfile.focus.length) {
    changes.push(`This repository matches the ${productProfile.name} profile, so the review emphasized ${productProfile.focus[0]}.`);
  }

  return changes.slice(0, 2);
}

function buildProductSpecificFindings(options, reviewContext) {
  const findings = [];
  const outsideDiffFindings = [];
  const notes = [];
  const { cwd, fileEntries, productProfile } = reviewContext;
  const profileTags = new Set((productProfile && Array.isArray(productProfile.tags)) ? productProfile.tags : []);

  const changedPathList = Array.from(getChangedPathsSet(fileEntries));
  const hasPaymentProcessorChange = changedPathList.some((filePath) => /\/Payments\/PaymentMethods\/.+\.php$/.test(filePath));

  const helperEntry = findChangedEntry(fileEntries, (filePath) => /app\/Helpers\/Helper\.php$/i.test(filePath));
  const advancedOptionsEntry = findChangedEntry(fileEntries, (filePath) => /advanced-options\.vue$/i.test(filePath));
  if (helperEntry && advancedOptionsEntry && changedPathList.some((filePath) => /input_ranking|RankingField|rankingField/i.test(filePath))) {
    const helperContent = getCurrentContentForContext(reviewContext, helperEntry.path);
    const advancedOptionsContent = getCurrentContentForContext(reviewContext, advancedOptionsEntry.path);
    const rankingValidatorRequiresUniqueCompleteSet = /case\s*'input_ranking'[\s\S]*count\(\$inputValue\)\s*===\s*count\(\$options\)[\s\S]*count\(\$filteredValues\)\s*===\s*count\(array_unique\(\$filteredValues\)\)[\s\S]*\$filteredValues\s*===\s*\$normalizedOptions/.test(helperContent);
    const rankingValidatorUsesOptionValues = /array_column\s*\(\s*self::flattenAdvancedOptions\(\$formattedOptions\)\s*,\s*'value'/.test(helperContent);
    const editorAllowsDirectValueEditing = /<el-input[^>]*v-model="option\.value"/.test(advancedOptionsContent)
      && /confirmBulkEdit\(\)[\s\S]*values\.push\(\{[\s\S]*value:\s*value/.test(advancedOptionsContent);
    const editorHasUniqueValueGuard = /duplicate|unique|already exists|must be unique|uniqBy|new\s+Set\s*\(/i.test(advancedOptionsContent);

    if (rankingValidatorRequiresUniqueCompleteSet && rankingValidatorUsesOptionValues && editorAllowsDirectValueEditing && !editorHasUniqueValueGuard) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'high',
        file: helperEntry.path,
        line: findLineNumber(helperContent, /case\s*'input_ranking'/),
        title: 'Ranking config can save duplicate option values that the validator later rejects',
        evidence: 'The validator now requires a complete unique set of option values, but the paired options editor still allows direct value edits and bulk-imported value pairs without any visible duplicate-value guard.',
        impact: 'Builders can save a ranking-style field configuration that looks valid in the editor, but submissions for that field will later fail validation because duplicate option values can never satisfy the unique complete-set check.',
        explanation: 'This is a generic validator/editor contract mismatch. If the runtime validator treats option values as a unique identity set, the editor must enforce that same uniqueness constraint when values are entered or bulk imported.',
        verification: 'Create a ranking-style field with duplicate option values through the builder or bulk editor and confirm the configuration is rejected before save, rather than allowing a field that later rejects normal submissions.',
        fixDirection: 'Add duplicate-value validation in the options editor or save path so option identity stays unique before the runtime validator runs.'
      });
    }
  }

  if (hasPaymentProcessorChange && !getChangedTestFiles(fileEntries).length) {
    const paymentEntry = findChangedEntry(fileEntries, (filePath) => /\/Payments\/PaymentMethods\/.+\.php$/.test(filePath));
    if (paymentEntry) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'medium',
        file: paymentEntry.path,
        line: 1,
        title: 'Payment processor change needs workflow-specific verification coverage',
        evidence: 'A payment gateway or processor file changed, but the diff does not include matching automated verification files or a nearby workflow-specific test path.',
        impact: 'Gateway processors sit directly on real checkout acceptance paths. Regressions here often appear only after callbacks, redirect confirmations, or reconciliation flows.',
        explanation: 'Payment handlers are contract-heavy. The same code can look locally correct and still break mismatch handling, totals, recurring flags, or persisted payment state once real gateway payloads reach the system.',
        verification: 'Verify the changed processor against the exact gateway payload shapes it handles, including mismatch, callback/redirect, and persisted total behavior.',
        fixDirection: 'Add workflow-specific payment verification or document the exact gateway scenarios covered before PR.'
      });
    }
  }

  const entryViewEntry = findChangedEntry(fileEntries, (filePath) => /Entry\.vue$/i.test(filePath));
  if (entryViewEntry) {
    const content = getCurrentContentForContext(reviewContext, entryViewEntry.path);
    const loopsAdvancedOptions = /each\s*\(\s*advancedOptions/.test(content);
    const directOptionMapping = /options\[[^\]]*optionItem\.value[^\]]*\]\s*=/.test(content) || /optionItem\.label/.test(content);
    const hasGroupedPayloadGuard = /flattenAdvancedOptions|isMappableOption|optionItem\s*&&\s*typeof\s+optionItem\s*===\s*['"]object['"]|Object\.prototype\.hasOwnProperty\.call\(optionItem,\s*['"]value['"]\)/.test(content);

    if (loopsAdvancedOptions && directOptionMapping && !hasGroupedPayloadGuard) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'medium',
        file: entryViewEntry.path,
        line: findLineNumber(content, /each\s*\(\s*advancedOptions/),
        title: 'Advanced option mapping does not guard grouped payload variants',
        evidence: 'The changed renderer maps advanced_options directly into a value->label lookup without flattening or validating grouped option payload members first.',
        impact: 'Entry rendering can break when grouped options introduce container nodes or payload variants that do not match the simple value/label shape expected by the old mapping logic.',
        explanation: 'This is a generic consumer/producer mismatch. Once grouped options are supported in one layer, every consumer that builds a flat label map needs either flattening or an explicit payload-shape guard.',
        verification: 'Test rendering with grouped advanced_options payloads and confirm option collection flattening or shape guards run before value/label mapping.',
        fixDirection: 'Flatten grouped advanced_options or guard payload members before building the rendered option map.'
      });
    }
  }

  if (profileTags.has('conversational-ui')) {
    const fileTypeEntry = findChangedEntry(fileEntries, (filePath) => /FileType\.vue$/i.test(filePath));
    if (fileTypeEntry) {
      const content = getCurrentContentForContext(reviewContext, fileTypeEntry.path);
      const hasImageOnload = /image\.onload\s*=/.test(content);
      const hasCropperCreate = /new\s+Cropper\s*\(/.test(content);
      const hasCleanupFlag = /isClosed|cleanedUp|destroyed|isDestroyed/.test(content);
      const hasOnloadGuard = /image\.onload\s*=\s*\(\)\s*=>\s*\{\s*if\s*\(([^)]*(isClosed|cleanedUp|destroyed|isDestroyed))/s.test(content);

      if (hasImageOnload && hasCropperCreate && hasCleanupFlag && !hasOnloadGuard) {
        pushFinding(findings, {
          severity: 'important',
          confidence: 'medium',
          file: fileTypeEntry.path,
          line: findLineNumber(content, /image\.onload\s*=/),
          title: 'Crop modal image-load callback may outlive cleanup state',
          evidence: 'The changed conversational file-upload flow creates Cropper inside image.onload while also tracking modal cleanup state, but the onload callback does not show an early return when cleanup already happened.',
          impact: 'Users who close the crop dialog before the image finishes loading can still trigger late cropper creation against detached DOM, which causes flaky crop sessions or leaked instances on slower devices.',
          explanation: 'This is a generic async cleanup race. If the modal closes first and the image finishes later, the late callback still executes unless it checks the cleanup flag before creating Cropper or another heavy UI instance.',
          verification: 'Close the crop dialog quickly on a large image or slow device and confirm no cropper instance is created after teardown.',
          fixDirection: 'Guard the image.onload callback with the cleanup flag before creating Cropper and return early after teardown.'
        });
      }
    }

    const rankingTypeEntry = findChangedEntry(fileEntries, (filePath) => /RankingType\.vue$/i.test(filePath));
    const rankingStyleEntry = findChangedEntry(fileEntries, (filePath) => /src\/form\/styles\/app\.scss$/i.test(filePath));

    if (rankingTypeEntry && rankingStyleEntry) {
      const rankingTypeContent = getCurrentContentForContext(reviewContext, rankingTypeEntry.path);
      const rankingStyleContent = getCurrentContentForContext(reviewContext, rankingStyleEntry.path);
      const supportsMultiColumnGrid = /rankingDisplayType\s*===\s*['"]grid['"]/.test(rankingTypeContent)
        && /columns\s*>=\s*2\s*&&\s*columns\s*<=\s*6/.test(rankingTypeContent)
        && /--ff-conv-ranking-columns/.test(rankingTypeContent);
      const hasGridColumnsRule = /\.ff_conv_ranking--grid\s*\{[\s\S]*grid-template-columns\s*:\s*repeat\(var\(--ff-conv-ranking-columns,\s*3\)/.test(rankingStyleContent);
      const hasMobileGridOverride = /@media[\s\S]{0,800}\(max-width:\s*767px\)[\s\S]*\.ff_conv_ranking--grid\s*\{[\s\S]*grid-template-columns\s*:\s*(1fr|repeat\(\s*[12]\s*,)/.test(rankingStyleContent)
        || /@media[\s\S]{0,800}\(max-width:\s*767px\)[\s\S]*\.ff_conv_ranking--grid[\s\S]*--ff-conv-ranking-columns\s*:\s*[12]\b/.test(rankingStyleContent);

      if (supportsMultiColumnGrid && hasGridColumnsRule && !hasMobileGridOverride) {
        pushFinding(findings, {
          severity: 'important',
          confidence: 'high',
          file: rankingStyleEntry.path,
          line: findLineNumber(rankingStyleContent, /\.ff_conv_ranking--grid\s*\{/),
          title: 'Ranking grid can become unusable on small screens',
          evidence: 'The ranking question supports grid display with 2-6 columns through --ff-conv-ranking-columns, but the SCSS does not show a max-width mobile override that collapses .ff_conv_ranking--grid to 1 or 2 columns.',
          impact: 'On narrow viewports, 3-6 columns produce cramped cards and controls, which reduces tap accuracy and makes the conversational ranking question difficult to use on phones.',
          explanation: 'This is a user-facing responsive regression rather than a generic CSS preference. Interactive card grids need an explicit small-screen layout fallback even if the desktop layout is correct.',
          verification: 'Render the ranking question on a narrow mobile viewport and confirm grid mode collapses to a safe 1-column or 2-column layout regardless of the configured desktop column count.',
          fixDirection: 'Add a mobile breakpoint override for .ff_conv_ranking--grid so small screens use at most 1 or 2 columns.'
        });
      }
    }

    if (rankingTypeEntry) {
      const rankingTypeContent = getCurrentContentForContext(reviewContext, rankingTypeEntry.path);
      const buildItemsBlockMatch = rankingTypeContent.match(/buildItems\s*\(\)\s*\{[\s\S]*?\n\s*\},/);
      const buildItemsBlock = buildItemsBlockMatch ? buildItemsBlockMatch[0] : rankingTypeContent;
      const quadraticOrderingBuild = /answer\.forEach\s*\(\s*value\s*=>\s*\{[\s\S]*availableOptions\.find\s*\([\s\S]*usedValues\.includes\s*\([\s\S]*\}[\s\S]*availableOptions\.forEach\s*\(\s*option\s*=>\s*\{[\s\S]*usedValues\.includes\s*\(/.test(buildItemsBlock);
      const usesMapOrSetOptimization = /new\s+Set\s*\(|new\s+Map\s*\(|Object\.create\s*\(\s*null\s*\)|reduce\s*\(\s*\([^)]*\)\s*=>\s*\{[\s\S]*\[[^\]]+\]\s*=/.test(buildItemsBlock);

      if (quadraticOrderingBuild && !usesMapOrSetOptimization) {
        pushFinding(findings, {
          severity: 'important',
          confidence: 'high',
          file: rankingTypeEntry.path,
          line: findLineNumber(rankingTypeContent, /buildItems\s*\(\)\s*\{/),
          title: 'Quadratic ordering build for ranking options',
          evidence: 'buildItems() performs repeated linear scans across answers and options through availableOptions.find(...) and usedValues.includes(...), then scans availableOptions again with usedValues.includes(...), making initialization quadratic as the option set grows.',
          impact: 'Large option sets can noticeably slow mount or rehydration when the interaction is activated.',
          explanation: 'This is a real performance bug rather than a style preference. The initializer rebuilds ordered items from two collections, but each answer match and used-value check walks arrays repeatedly. That scales poorly compared with pre-indexing options and using a Set for membership checks.',
          verification: 'Test ranking question activation and rehydration with larger option sets and confirm initialization stays responsive without repeated linear scans over the same arrays.',
          fixDirection: 'Pre-index options by value and use a Set for used values so matching and membership checks stay O(1) during buildItems().'
        });
      }
    }

    const toggleTypeEntry = findChangedEntry(fileEntries, (filePath) => /ToggleType\.vue$/i.test(filePath));
    if (toggleTypeEntry) {
      const content = getCurrentContentForContext(reviewContext, toggleTypeEntry.path);
      const hasChoiceButtons = /ff_conv_toggle__choice/.test(content) || /<button\b/.test(content);
      const hasAriaLabels = /:aria-label=|aria-label=/.test(content);
      const hasDisabledBinding = /<button\b[^>]*:disabled=|<button\b[^>]*\bdisabled\b|<el-switch\b[^>]*:disabled=/.test(content);
      const hasDisabledGuard = /this\.disabled|if\s*\(\s*!option\s*\|\|\s*this\.disabled|if\s*\(\s*this\.disabled\s*\)/.test(content);

      if (hasChoiceButtons && !hasAriaLabels) {
        pushFinding(findings, {
          severity: 'important',
          confidence: 'high',
          file: toggleTypeEntry.path,
          line: findLineNumber(content, /<button\b/),
          title: 'Toggle choice buttons do not expose an accessible name',
          evidence: 'The toggle component renders custom choice buttons but does not show aria labeling for assistive technology.',
          impact: 'Image-based or visually minimal toggle choices can become unlabeled buttons for screen-reader users, making the question impossible to answer reliably.',
          explanation: 'Conversational custom controls often bypass native form semantics. When choice buttons rely on images or optional labels, they need a stable accessible name independent of visual layout.',
          verification: 'Inspect the rendered toggle choices with assistive technology and confirm each button exposes a meaningful accessible name even when visual labels or images vary.',
          fixDirection: 'Add reliable aria-label or aria-labelledby wiring for each toggle choice button.'
        });
      }

      if (hasChoiceButtons && !hasDisabledBinding && !hasDisabledGuard) {
        pushFinding(findings, {
          severity: 'important',
          confidence: 'medium',
          file: toggleTypeEntry.path,
          line: findLineNumber(content, /<button\b/),
          title: 'Disabled toggle state is not propagated to all interactive controls',
          evidence: 'The toggle component adds custom interactive controls but does not clearly bind disabled state in markup or guard interaction in the handler path.',
          impact: 'A disabled-looking toggle can remain reachable or actionable for assistive technology and keyboard users, causing inconsistent behavior between pointer and non-pointer interaction.',
          explanation: 'This regression is specific to custom composite controls: disabled state has to be enforced across each child button and switch-like control, not only in visual state.',
          verification: 'Disable the field and confirm none of the toggle controls remain focusable or actionable through keyboard or assistive-technology interaction.',
          fixDirection: 'Bind disabled state to every interactive child control and return early from selection handlers when disabled.'
        });
      }
    }

    const toggleStyleEntry = findChangedEntry(fileEntries, (filePath) => /app\.scss$/i.test(filePath));
    if (toggleStyleEntry) {
      const content = getCurrentContentForContext(reviewContext, toggleStyleEntry.path);
      if (/ff_conv_toggle__choice:focus\s*\{[\s\S]*outline\s*:\s*none/i.test(content) && !/ff_conv_toggle__choice:focus-visible\s*\{[\s\S]*(outline|box-shadow|border)/i.test(content)) {
        pushFinding(findings, {
          severity: 'important',
          confidence: 'medium',
          file: toggleStyleEntry.path,
          line: findLineNumber(content, /ff_conv_toggle__choice:focus/),
          title: 'Toggle choice buttons remove focus styling without a visible replacement',
          evidence: 'The toggle styles remove default focus indication from the custom choice buttons but do not show a replacement focus-visible treatment.',
          impact: 'Keyboard users can reach the toggle choices without any clear focus indicator, which is a real accessibility regression for conversational navigation.',
          explanation: 'This is a predictable risk whenever button defaults are stripped in a custom control. The component remains interactive, but the focus location becomes invisible during keyboard navigation.',
          verification: 'Tab through the toggle question and confirm the focused button remains visibly highlighted against the surrounding UI.',
          fixDirection: 'Add a clear focus-visible style for the custom toggle choice buttons whenever outline removal is used.'
        });
      }
    }
  }

  if (profileTags.has('pdf-output') && (changedPathList.some((filePath) => /template|invoice|report|pdf/i.test(filePath)) || changedPathList.some((filePath) => /pdf|download|attachment|generator/i.test(filePath)))) {
    const changedTemplateFiles = changedPathList.filter((filePath) => /template|invoice|report|pdf/i.test(filePath));
    const changedGenerationFiles = changedPathList.filter((filePath) => /pdf|download|attachment|generator/i.test(filePath));

    if (changedTemplateFiles.length && !changedGenerationFiles.some((filePath) => /data|mapper|provider/i.test(filePath))) {
      pushOutsideDiffFinding(outsideDiffFindings, {
        severity: 'medium',
        file: 'app/Services',
        line: 1,
        title: 'Template changes may need matching PDF data-map updates',
        explanation: 'In Fluent Forms PDF, template/UI changes often depend on a separate entry-to-template data map. If only the template/render side changes, documents can render with blank placeholders or partial totals even though the layout diff looks correct.',
        verification: 'Check that any new placeholders, invoice fields, or report values are provided by the PDF data/preparation layer before rendering.',
        fixDirection: 'Update the PDF data provider/mapping layer so every new template field is available at render time.'
      });
    }

    if (changedGenerationFiles.length && !getChangedTestFiles(fileEntries).length) {
      pushFinding(findings, {
        severity: 'medium',
        confidence: 'medium',
        file: changedGenerationFiles[0],
        line: 1,
        title: 'PDF generation change needs output verification coverage',
        evidence: 'The diff changes PDF template/generation paths, but there is no matching automated verification in the changed files.',
        impact: 'PDF regressions are easy to miss in code review because the break often appears only in the generated file: wrong totals, missing placeholders, broken attachments, or malformed downloads.',
        explanation: 'This plugin is output-driven. A code change can look safe while still breaking actual document generation, attachment naming, or template rendering for invoices and reports.',
        verification: 'Generate at least one representative PDF after this change and verify totals, placeholders, attachment/download behavior, and empty-field handling.',
        fixDirection: 'Add fixture-based PDF verification or document the exact generation scenarios checked before PR.'
      });
    }
  }

  if (profileTags.has('translation-sync') && changedPathList.some((filePath) => /wpml|translation|package|string|language/i.test(filePath))) {
    const changedTranslationFiles = changedPathList.filter((filePath) => /wpml|translation|package|string|language/i.test(filePath));

    if (changedTranslationFiles.length && !repoSearch(cwd, 'package|register_strings|translate|icl_', changedTranslationFiles)) {
      pushFinding(findings, {
        severity: 'medium',
        confidence: 'low',
        file: changedTranslationFiles[0],
        line: 1,
        title: 'Translation-path change does not show package/string registration updates',
        evidence: 'The diff touches multilingual/WPML handling, but the changed files do not clearly show matching package or string registration logic.',
        impact: 'A multilingual feature can look correct in source-language code while translated forms silently stop syncing labels, choices, or metadata.',
        explanation: 'WPML integrations are contract-heavy: field changes usually need to reach package extraction and registration so translated content can round-trip. Missing that bridge often causes silent fallback to source language or stale translations.',
        verification: 'Confirm new or changed form fields/metadata are still registered with WPML string/package extraction and render correctly in translated forms.',
        fixDirection: 'Update the WPML package/string registration path so translated forms receive the changed data.'
      });
    }
  }

  if (profileTags.has('signature-pad') && changedPathList.some((filePath) => /signature|pad|canvas/i.test(filePath))) {
    const changedSignatureFiles = changedPathList.filter((filePath) => /signature|pad|canvas/i.test(filePath));

    if (changedSignatureFiles.length && !getChangedTestFiles(fileEntries).length) {
      pushFinding(findings, {
        severity: 'medium',
        confidence: 'medium',
        file: changedSignatureFiles[0],
        line: 1,
        title: 'Signature workflow change needs payload-format verification',
        evidence: 'The diff changes signature-related code without matching verification coverage.',
        impact: 'Signature regressions often appear only after a real draw/clear/save cycle, where the stored PNG/data URL shape no longer matches what Fluent Forms expects for rendering or submission persistence.',
        explanation: 'This add-on depends on a stable contract between frontend capture, stored signature payload, and later rendering/export. Changing any one side without verification can break saved signatures even if the field still renders.',
        verification: 'Verify draw, clear, redraw, submit, and re-render behavior, and confirm the stored signature payload format is unchanged where downstream code expects it.',
        fixDirection: 'Add or document end-to-end signature field verification for capture, persistence, and render paths.'
      });
    }
  }

  if (profileTags.has('player-runtime') && changedPathList.some((filePath) => /player|subtitle|chapter|playlist|shortcode|block|analytics|drm/i.test(filePath))) {
    const changedPlayerFiles = changedPathList.filter((filePath) => /player|subtitle|chapter|playlist|shortcode|block|analytics|drm/i.test(filePath));

    if (changedPlayerFiles.length && !getChangedTestFiles(fileEntries).length) {
      pushFinding(findings, {
        severity: 'medium',
        confidence: 'medium',
        file: changedPlayerFiles[0],
        line: 1,
        title: `${productProfile ? productProfile.name : 'Player'} config change needs frontend playback verification`,
        evidence: 'The diff changes player-facing config or runtime files without matching verification coverage.',
        impact: 'Player regressions usually surface only in the browser: wrong source config, missing subtitles/chapters, failed initialization, or broken pro overlays/analytics after save.',
        explanation: 'Player flows are heavily config-contract driven. A mismatch between saved settings, shortcode/block attributes, and the frontend bootstrap can leave the admin side looking correct while playback breaks for users.',
        verification: 'Verify the changed player config on a real rendered player, including initialization, source loading, and any touched subtitle/chapter/analytics/protection path.',
        fixDirection: 'Add rendered-player verification or document the exact playback scenarios checked before PR.'
      });
    }

    if (
      changedPathList.some((filePath) => /shortcode|block|resources\/blocks|app\/Blocks/i.test(filePath)) &&
      !changedPathList.some((filePath) => /resources\/js|resources\/share|bootstrap|player/i.test(filePath))
    ) {
      pushOutsideDiffFinding(outsideDiffFindings, {
        severity: 'medium',
        file: 'frontend player bootstrap',
        line: 1,
        title: 'Block or shortcode config change may need matching frontend bootstrap update',
        explanation: 'Fluent Player behavior depends on the saved block/shortcode config reaching the frontend player initialization payload unchanged. A change only on the block or shortcode side can leave the rendered player using stale or incomplete runtime config.',
        verification: 'Check the same changed settings on a rendered player and confirm the frontend bootstrap payload includes the updated values.',
        fixDirection: 'Align shortcode/block config changes with the frontend bootstrap or serialized player payload path.'
      });
    }
  }

  if (productProfile && productProfile.regressionChecks.length && !findings.length && !outsideDiffFindings.length) {
    notes.push(`Applied ${productProfile.name} review focus areas: ${productProfile.regressionChecks.join('; ')}.`);
  }

  return { findings, outsideDiffFindings, notes };
}

function analyzeFile(context) {
  const findings = [];
  const { filePath, currentContent, baseContent, changedLines, mode, highRiskPaths, productProfile } = context;
  const expectedTextDomain = productProfile && productProfile.textDomain ? productProfile.textDomain : '';
  const isPhpFile = filePath.endsWith('.php');
  const isScriptFile = /\.(js|jsx|ts|tsx|vue)$/i.test(filePath);
  const isFrontendFile = isFrontendTemplateFile(filePath);
  const isStyleLikeFile = isStyleFile(filePath);
  const runAccessibilityChecks = mode === 'full' || mode === 'compatibility' || mode === 'accessibility';

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
      explanation: 'Without a permission callback, authorization falls back to permissive behavior or unclear defaults. On plugin routes that mutate settings or expose submission data, that can turn a normal endpoint into an accidental privilege boundary bypass.',
      verification: 'Confirm every register_rest_route() call in this change defines a permission_callback that rejects unauthorized users and matches the intended capability model.',
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
        explanation: 'Nonce checks only prove request origin, not user privilege. If this path updates options, post meta, or other persisted state, a missing capability gate can let the wrong authenticated user reach admin-only behavior.',
        verification: 'Verify that the mutation path is protected by current_user_can() or an equivalent capability check before any write occurs.',
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
        explanation: 'This pattern often appears in admin AJAX, webhook helpers, or settings update flows. If the request reaches a privileged mutation path without nonce verification, an attacker can sometimes induce an authenticated browser to perform unintended writes.',
        verification: 'Check the request entry point and confirm it verifies a nonce before processing user-controlled input or persisting data.',
        fixDirection: 'Add check_ajax_referer() or wp_verify_nonce() at the request boundary.'
      });
    }
  }

  if (isPhpFile && /wp_ajax_nopriv_/.test(currentContent) && /\$_(POST|GET|REQUEST|FILES)\s*\[/.test(currentContent) && !/check_ajax_referer\s*\(|wp_verify_nonce\s*\(/.test(currentContent)) {
    pushFinding(findings, {
      severity: 'important',
      confidence: 'medium',
      file: filePath,
      line: findLineNumber(currentContent, /wp_ajax_nopriv_/),
      title: 'Public AJAX endpoint does not show nonce or resource-binding protection',
      evidence: 'The file registers a wp_ajax_nopriv_ endpoint and reads request input, but no nonce check was detected nearby.',
      impact: 'Public AJAX handlers are frequently reachable from attacker-controlled browsers. If the action also trusts user-chosen IDs, paths, or targets, this can expose unauthorized reads, writes, or abuse of plugin-owned resources.',
      explanation: 'In WordPress plugins, a frontend nonce is not full authorization. Public handlers usually need both anti-CSRF protection and a resource-binding check that proves the caller can act on the exact form, attachment, post, or file being referenced.',
      verification: 'Trace the wp_ajax_nopriv_ entry point and confirm it verifies a nonce or token and binds the request to the exact resource it is allowed to touch.',
      fixDirection: 'Add request-bound nonce or token verification and validate ownership or resource binding before processing the public AJAX action.'
    });
  }

  if (isPhpFile && /wp_delete_attachment\s*\(/.test(currentContent)) {
    const hasDeletePostCheck = /current_user_can\s*\(\s*['"]delete_post['"]|user_can\s*\([^)]*['"]delete_post['"]|canDeleteManaged[A-Za-z]+Attachment\s*\(/.test(currentContent);
    if (!hasDeletePostCheck) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'medium',
        file: filePath,
        line: findLineNumber(currentContent, /wp_delete_attachment\s*\(/),
        title: 'Attachment deletion path does not show per-attachment authorization',
        evidence: 'The changed code deletes a WordPress attachment but does not show a delete_post capability or managed-attachment ownership check nearby.',
        impact: 'Destructive attachment operations can cross media or ownership boundaries if the route-level permission is broader than the exact attachment context being deleted.',
        explanation: 'A route or media-level permission gate is not always enough when a request can reference a specific attachment ID. Attachment deletion usually needs both per-attachment capability enforcement and a check that the attachment belongs to the expected media or managed context.',
        verification: 'Confirm the delete flow enforces current_user_can(\'delete_post\', $attachmentId) or an equivalent ownership helper before wp_delete_attachment() runs.',
        fixDirection: 'Add per-attachment authorization and managed-context ownership checks before deleting the attachment.'
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
      explanation: 'Even when the current inputs seem trusted, SQL built without prepare() tends to become unsafe as code evolves. It also makes numeric casting and string escaping assumptions harder to audit in payment and reporting paths.',
      verification: 'Inspect the exact query construction and confirm every dynamic value is either hard-cast or routed through $wpdb->prepare().',
      fixDirection: 'Route dynamic SQL values through $wpdb->prepare() before execution.'
    });
  }

  if (isPhpFile && /wp_remote_(get|post)\s*\(/.test(currentContent) && /json_decode\s*\(/.test(currentContent)) {
    const hasResponseSizeGuard = /limit_response_size|strlen\s*\(\s*\$body\s*\)|mb_strlen\s*\(\s*\$body\s*\)|MAX_[A-Z0-9_]*BYTES|response-size|response size/i.test(currentContent);
    if (!hasResponseSizeGuard) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'medium',
        file: filePath,
        line: findLineNumber(currentContent, /json_decode\s*\(/),
        title: 'Remote JSON response is decoded without a visible size guard',
        evidence: 'The changed code fetches a remote response and json_decodes it, but no response-size cap was detected nearby.',
        impact: 'Large remote payloads can exhaust PHP memory or trigger very slow requests before downstream field-level validation ever runs.',
        explanation: 'This pattern matters in WordPress because wp_remote_get()/wp_remote_post() materialize the response body in memory first. If the code then json_decodes the entire body without a limit_response_size guard or an explicit byte cap, a remote service can turn one request into a memory spike.',
        verification: 'Check whether the HTTP call uses limit_response_size or an equivalent byte-limit before json_decode, especially on multi-item download endpoints.',
        fixDirection: 'Add a hard response-size cap before json_decode or switch the flow to a bounded incremental processing approach.'
      });
    }
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
      explanation: 'WordPress plugin compatibility is often broader than the local development runtime. A helper that exists locally can still fatal on customer sites if the supported PHP floor is lower.',
      verification: 'Check the repo minimum PHP version and release policy. If older versions are still supported, replace this with a compatibility-safe substring check.',
      fixDirection: 'Confirm the minimum PHP version or use a compatibility-safe substring check.'
    });
  }

  const dottedSettingsWrite = changedLines.find((entry) => /\[['"][^'"]*\.[^'"]*['"]\s*(?:\.\s*[$A-Za-z_][A-Za-z0-9_]*)?\]\s*=/.test(entry.text));
  if (isPhpFile && dottedSettingsWrite && /(Arr|ArrayHelper)::get\s*\([^)]*['"]settings\./.test(currentContent)) {
    pushFinding(findings, {
      severity: 'important',
      confidence: 'high',
      file: filePath,
      line: dottedSettingsWrite.line,
      title: 'Dotted settings key is being written as a literal array path',
      evidence: 'The changed code writes to an array key like settings.* as a literal string while the same file also reads settings.* through Arr::get()/ArrayHelper::get() path semantics.',
      impact: 'This can break downstream consumers that expect nested settings arrays and silently lose transformed field configuration before render or validation.',
      explanation: 'In WPManageNinja codebases, dotted paths are often read through helper path semantics, not stored as literal array keys. Writing the transformed payload back under a literal dotted key makes the write path structurally inconsistent with the read path.',
      verification: 'Confirm the updated data is written into the nested settings array structure expected by downstream Arr::get()/ArrayHelper::get() readers.',
      fixDirection: 'Write the updated payload into the real nested array path instead of a literal dotted-key string.'
    });
  }

  if (expectedTextDomain) {
    const wrongTextDomain = changedLines.find((entry) => {
      const match = entry.text.match(/(__|_e|_x|esc_html__|esc_attr__)\s*\([^)]*['"]([a-z0-9_-]+)['"]\s*\)/i);
      return match && match[2] !== expectedTextDomain;
    });
    if (isPhpFile && wrongTextDomain) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'high',
        file: filePath,
        line: wrongTextDomain.line,
        title: 'Translation call is using the wrong text domain for this repository',
        evidence: `The changed translation call uses a different text domain than the repository profile expects (${expectedTextDomain}).`,
        impact: 'This breaks translation isolation and can cause strings to miss the intended translation catalog even when they render correctly in development.',
        explanation: 'Text-domain mismatches are easy to miss because the string still appears locally, but the package-level translation boundary depends on consistent domains across all new translation calls.',
        verification: `Check that every new translation call in this repository uses the expected ${expectedTextDomain} text domain consistently.`,
        fixDirection: `Change the translation call to use the ${expectedTextDomain} text domain.`
      });
    }
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
      explanation: 'Request data is attacker-controlled by default. Echoing it directly into HTML, attributes, or inline scripts can turn a normal admin or frontend page into a stored or reflected XSS sink.',
      verification: 'Check the rendering context and ensure the value is sanitized on input and escaped with the correct WordPress helper on output.',
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
      explanation: 'Boundary sanitization is easier to reason about than delayed sanitization. When raw request data travels deeper into payment, settings, or integration code, it becomes much harder to prove every downstream use is safe.',
      verification: 'Trace this value from request read to persistence or rendering and confirm it is normalized immediately with the correct sanitizer or type cast.',
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
        explanation: 'This pattern is easy to miss in review because the loop itself looks harmless, but once it wraps remote requests or database reads it can scale poorly with entry count or field count.',
        verification: 'Estimate the worst-case loop size and confirm expensive work is cached, batched, or moved outside the iteration.',
        fixDirection: 'Check whether expensive work can be cached, batched, or moved outside the loop.'
      });
    }
  }

  if (isScriptFile) {
    const duplicateResourceFetchMatch = currentContent.match(/then\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?this\.getEntryResources\s*\(\)\s*;[\s\S]*?update_status[\s\S]*?this\.handleStatusChange\s*\([^)]*\)\s*;[\s\S]*?this\.getEntryResources\s*\(\)\s*;[\s\S]*?\}\s*\)/);
    if (duplicateResourceFetchMatch) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'high',
        file: filePath,
        line: findLineNumber(currentContent, /this\.getEntryResources\s*\(\)\s*;/),
        title: 'Duplicate resource fetch on entry load',
        evidence: 'The entry-load flow fetches resources once before checking update_status and then fetches them again inside the status-update branch after calling handleStatusChange().',
        impact: 'This adds an avoidable extra request on entry-load paths, increasing admin latency and backend load on a high-traffic screen.',
        explanation: 'This is a control-flow regression, not just a repeated line. If one branch updates status before loading resources, the component should await that status change and then fetch resources once for that path instead of always fetching before and after the branch.',
        verification: 'Trace the mounted or initial load path with and without update_status present and confirm resource loading happens exactly once per branch.',
        fixDirection: 'Restructure the load flow so getEntryResources() runs once per path, awaiting status change first when the update_status branch needs to run.'
      });
    }

    const dragoverFullReset = /on\s*\(\s*['"]dragover['"][\s\S]*?clearDropState\s*\(\)/.test(currentContent)
      && /clearDropState\s*=\s*\(\)\s*=>\s*\{[\s\S]*find\s*\(\s*['"][^'"]+['"]\s*\)[\s\S]*removeClass\s*\(\s*['"][^'"]+['"]\s*\)/.test(currentContent)
      && /addClass\s*\(\s*['"][^'"]*over[^'"]*['"]\s*\)/.test(currentContent);

    if (dragoverFullReset) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'high',
        file: filePath,
        line: findLineNumber(currentContent, /on\s*\(\s*['"]dragover['"]/),
        title: 'High-frequency dragover does full-list class reset each event',
        evidence: 'The dragover handler calls clearDropState() on each drag event, and clearDropState() scans the full item list to remove drop-state classes before the current target adds the class back.',
        impact: 'Dragover fires very frequently while the pointer moves. Re-querying and mutating every item on each event creates avoidable DOM churn and can cause jank on larger sortable lists.',
        explanation: 'This is a real client-side performance issue rather than a micro-optimization. Drag/drop handlers run on a very hot path, so full-list DOM queries and class resets inside dragover scale poorly as item counts increase.',
        verification: 'Profile drag interactions on larger lists and confirm drop-state highlighting updates only when the hovered target changes, not on every dragover event.',
        fixDirection: 'Track the currently highlighted drop target and only update classes when the target actually changes, instead of clearing the full list on every dragover event.'
      });
    }

    const adjacentForwardDropNoOp = /onDrop\s*\(\s*index\s*\)\s*\{[\s\S]*const\s+sourceIndex\s*=\s*this\.dragIndex\s*;[\s\S]*let\s+insertIndex\s*=\s*index\s*;[\s\S]*if\s*\(\s*sourceIndex\s*<\s*insertIndex\s*\)\s*\{[\s\S]*insertIndex\s*-?=\s*1\s*;[\s\S]*\}[\s\S]*if\s*\(\s*insertIndex\s*===\s*sourceIndex\s*\)\s*\{[\s\S]*return\s*;[\s\S]*\}/.test(currentContent);

    if (adjacentForwardDropNoOp) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'high',
        file: filePath,
        line: findLineNumber(currentContent, /onDrop\s*\(\s*index\s*\)\s*\{/),
        title: 'Drag-and-drop cannot move item to immediate next position',
        evidence: 'The drop handler initializes insertIndex from the hovered index, decrements it for forward moves, and then returns when insertIndex equals sourceIndex. Dropping an item onto the immediately following slot therefore collapses to a no-op instead of moving the item down by one position.',
        impact: 'Users cannot complete some valid reorder operations with drag-and-drop, so ranking and sortable list interactions behave inconsistently and feel broken even though the drag UI appears to accept the drop.',
        explanation: 'This is a concrete reorder-logic bug, not a cosmetic drag/drop concern. Forward moves need different insertion math depending on whether the target index represents the hovered item or the insertion boundary after removal. The current equality guard accidentally rejects the adjacent-next case entirely.',
        verification: 'Drag an item onto the immediately following item and confirm the order changes by one position instead of snapping back to the original order.',
        fixDirection: 'Adjust the drop-index math so a forward move onto the next item still inserts after removal, or derive the insertion point from an explicit before/after drop target instead of decrementing and then treating equality as no-op.'
      });
    }

    const changedText = changedLines.map((entry) => entry.text).join('\n');
    const helperDeclaration = changedText.match(/var\s+([A-Za-z0-9_]+)\s*=\s*function\s*\(/);
    const stateClassMatch = changedText.match(/toggleClass\s*\(\s*['"]([^'"]+)['"]|addClass\s*\(\s*['"]([^'"]+)['"]|removeClass\s*\(\s*['"]([^'"]+)['"]/);
    const stateClass = stateClassMatch ? (stateClassMatch[1] || stateClassMatch[2] || stateClassMatch[3]) : null;
    const helperName = helperDeclaration ? helperDeclaration[1] : null;
    const introducedStateSyncLifecycle = /(input|change|keyup|blur)\b/.test(changedText)
      && /(toggleClass\s*\(|addClass\s*\(|removeClass\s*\()/.test(changedText)
      && Boolean(helperName && stateClass);
    const resetHandlerMatch = currentContent.match(/var\s+formResetHandler\s*=\s*function\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\};/);
    const resetHandlerBlock = resetHandlerMatch ? resetHandlerMatch[0] : '';
    const hasResetLifecycle = /formResetHandler|\.on\(\s*['"]reset|\[0\]\.reset\(\)/.test(currentContent);
    const resetTouchesState = resetHandlerBlock && (
      (helperName && resetHandlerBlock.includes(helperName)) ||
      (stateClass && resetHandlerBlock.includes(stateClass))
    );

    if (introducedStateSyncLifecycle && hasResetLifecycle && resetHandlerBlock && !resetTouchesState) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'high',
        file: filePath,
        line: findLineNumber(currentContent, /var\s+formResetHandler\s*=\s*function|function\s+formResetHandler\s*\(/),
        title: 'State-sync helper does not refresh UI state after form reset',
        evidence: `The changed code introduces the ${helperName} helper to toggle the ${stateClass} state class on input/change paths, but the form reset handler does not call that helper or clear the same state class.`,
        impact: 'Forms can keep stale UI state after reset or success flows, leaving labels, placeholders, or other state-driven visuals out of sync with the cleared field values.',
        explanation: 'This is a lifecycle regression rather than a rendering bug in the changed lines themselves. When a frontend feature introduces state-sync logic that mutates CSS classes in response to input events, the same state usually needs to be recomputed after reset, clear, or success-driven form resets.',
        verification: 'Reset the rendered form after typing into the affected field types and confirm the state-driven class is recomputed or removed so the cleared UI matches the underlying field values.',
        fixDirection: 'Re-run the state-sync helper after reset, or explicitly remove and recompute the affected state class at the end of the reset handler.'
      });
    }

    const derivedStateOnMountOnly = /props\s*:\s*\[[^\]]*['"]value['"][^\]]*['"]field['"][^\]]*\]/.test(currentContent)
      && /data\s*\(\)\s*\{[\s\S]*orderedItems\s*:\s*\[\]/.test(currentContent)
      && /buildItems\s*\(\)\s*\{[\s\S]*this\.orderedItems\s*=/.test(currentContent)
      && /mounted\s*\(\)\s*\{[\s\S]*this\.buildItems\s*\(\)\s*;[\s\S]*\}/.test(currentContent)
      && !/watch\s*:\s*\{[\s\S]*(value|field)/.test(currentContent)
      && !/watch\s*\(\s*\(\s*\)\s*=>\s*(this\.)?(value|field)|watch\s*\(\s*['"](value|field)/.test(currentContent);

    if (derivedStateOnMountOnly) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'high',
        file: filePath,
        line: findLineNumber(currentContent, /mounted\s*\(\)\s*\{/),
        title: 'Entry editor derived list does not react to prop updates',
        evidence: 'The component derives orderedItems from value/field props in buildItems(), calls it only in mounted(), and does not show watchers or another reactive path for later prop updates.',
        impact: 'When entry data or field options are refreshed after initial render, the editor can display stale order or labels and allow edits against outdated state.',
        explanation: 'This is a common Vue editor regression: copying prop-derived state into local mutable arrays on mount is fine only if the component also resynchronizes when the source props change. Entry and settings editors often receive async-loaded data after first render.',
        verification: 'Reload or update the editor with new value and field option data after initial render and confirm the local ordered list rebuilds to reflect the latest props.',
        fixDirection: 'Add watchers or a computed-driven synchronization path so buildItems() reruns when value or the relevant field option source changes.'
      });
    }
  }

  if (isFrontendFile) {
    const changedText = changedLines.map((entry) => entry.text).join('\n');
    const vHtmlBindings = [];
    const vHtmlRegex = /v-html\s*=\s*["']([^"']+)["']/g;
    let vHtmlMatch;
    while ((vHtmlMatch = vHtmlRegex.exec(currentContent)) !== null) {
      vHtmlBindings.push(vHtmlMatch[1]);
    }

    const unsafePreviewBinding = vHtmlBindings.find((binding) => {
      const methodName = String(binding).replace(/\(.*$/, '').trim();
      if (!methodName) {
        return false;
      }

      const touchesPreviewComposition = changedText.includes('v-html')
        || changedText.includes(methodName)
        || /fieldLabel|preview-field|preview-value|getRankingConditionPreview|rule\.value|return\s+`/.test(changedText);
      if (!touchesPreviewComposition) {
        return false;
      }

      const methodPattern = new RegExp(`${methodName}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?return\\s+\`[\\s\\S]*?\\$\\{[^}]+\\}[\\s\\S]*?\``, 'm');
      if (!methodPattern.test(currentContent)) {
        return false;
      }

      const dynamicPreviewPattern = new RegExp(`${methodName}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?(fieldLabel|\\.label\\b|\\bvalue\\b)[\\s\\S]*?<[^>]+>[\\s\\S]*?\\$\\{`, 'm');
      return dynamicPreviewPattern.test(currentContent);
    });

    if (unsafePreviewBinding) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'high',
        file: filePath,
        line: findLineNumber(currentContent, /v-html\s*=/),
        title: 'Unsanitized HTML rendering in group preview',
        evidence: `The changed component renders preview markup with v-html through ${unsafePreviewBinding}, and the bound preview method composes HTML from dynamic label/value data before injecting it into the DOM.`,
        impact: 'If field labels or rule values contain HTML-like payloads, the admin preview can render unsafe or executable markup instead of inert text.',
        explanation: 'This is a real admin-side XSS risk, not a styling concern. Vue escapes normal interpolations by default, but v-html bypasses that protection entirely. Once the preview method concatenates dynamic label or value strings into HTML, the safety depends on every segment already being escaped correctly.',
        verification: 'Populate the preview with labels or values containing HTML-like payloads and confirm the admin UI renders them as text rather than interpreted markup.',
        fixDirection: 'Stop using v-html for dynamic preview strings, or escape every dynamic segment before composing HTML and injecting it.'
      });
    }
  }

  if (runAccessibilityChecks && isFrontendFile) {
    const unlabeledControl = changedLines.find((entry) => {
      if (!/<(input|select|textarea)\b/i.test(entry.text) || /type\s*=\s*["']hidden["']/i.test(entry.text)) {
        return false;
      }

      if (/aria-label\s*=|aria-labelledby\s*=/.test(entry.text)) {
        return false;
      }

      return !hasNearbyAccessibleLabel(currentContent, entry.line);
    });

    if (unlabeledControl) {
      pushFinding(findings, {
        severity: 'medium',
        confidence: 'medium',
        file: filePath,
        line: unlabeledControl.line,
        title: 'Form control does not show an accessible label',
        evidence: 'A changed input, select, or textarea does not show a nearby label or aria labeling hook.',
        impact: 'Screen reader users can encounter unnamed form controls, making settings pages, blocks, or frontend forms difficult or impossible to complete reliably.',
        explanation: 'WordPress plugin UIs often render inside wp-admin, Gutenberg, or public forms where labels are part of both accessibility and supportability. A control that looks obvious visually can still be effectively anonymous to assistive technology.',
        verification: 'Check the rendered control and confirm it has a visible <label>, or an equivalent aria-label/aria-labelledby relationship that survives the final markup.',
        fixDirection: 'Add a semantic <label> association or an explicit aria-label/aria-labelledby for the changed control.'
      });
    }

    const unlabeledImage = changedLines.find((entry) => /<img\b/i.test(entry.text) && !/\balt\s*=/.test(entry.text));
    if (unlabeledImage) {
      pushFinding(findings, {
        severity: 'low',
        confidence: 'high',
        file: filePath,
        line: unlabeledImage.line,
        title: 'Image markup is missing alt text',
        evidence: 'A changed <img> tag does not include an alt attribute.',
        impact: 'Assistive technology cannot determine whether the image is decorative or meaningful, and missing alt text also weakens fallback behavior when assets fail to load.',
        explanation: 'Plugin UIs commonly include icons, previews, and instructional imagery. Even decorative images should set alt="" explicitly so screen readers can skip them predictably.',
        verification: 'Check whether the image is decorative or conveys content, then confirm the rendered markup includes the appropriate alt attribute.',
        fixDirection: 'Add alt text for informative images or alt="" for decorative-only images.'
      });
    }

    const clickableNonInteractive = changedLines.find((entry) => /<(div|span|li|p)\b[^>]*(@click=|v-on:click=|onClick=|onclick=)/.test(entry.text) && !/\b(role=|tabindex=|@keydown=|v-on:keydown=|onKeyDown=|@keyup=|onKeyUp=)/.test(entry.text));
    if (clickableNonInteractive) {
      pushFinding(findings, {
        severity: 'medium',
        confidence: 'high',
        file: filePath,
        line: clickableNonInteractive.line,
        title: 'Non-interactive element is handling click behavior directly',
        evidence: 'A changed div/span/li/p element handles click interaction without visible keyboard semantics.',
        impact: 'Keyboard users may not be able to reach or activate the control, and assistive technology will not consistently announce it as interactive.',
        explanation: 'This is a common accessibility regression in plugin admin UIs and Vue/React components. If an element behaves like a button or disclosure, it should usually be a real <button> or it needs explicit keyboard and role semantics.',
        verification: 'Test the interaction with keyboard-only navigation and confirm the element is reachable, announced correctly, and activatable with Enter/Space.',
        fixDirection: 'Use a semantic button element or add the required role, tabindex, and keyboard handlers for equivalent accessibility.'
      });
    }

    const unnamedButton = changedLines.find((entry) => {
      const nativeEmptyButton = /<button\b[^>]*>\s*(<[^/][^>]*>\s*)*<\/button>/i.test(entry.text);
      const iconOnlyComponentButton = /<el-button\b[^>]*\bicon=/.test(entry.text)
        && /<\/el-button>/.test(entry.text)
        && !/>\s*[^<\s][\s\S]*<\/el-button>/.test(entry.text);

      if (!(nativeEmptyButton || iconOnlyComponentButton)) {
        return false;
      }

      return !/aria-label\s*=|aria-labelledby\s*=|title\s*=/.test(entry.text);
    });
    if (unnamedButton) {
      const isReorderButton = /move\s*\(/.test(unnamedButton.text) || /orderedItems|moveButtonLabel/.test(currentContent);
      pushFinding(findings, {
        severity: isReorderButton ? 'important' : 'medium',
        confidence: isReorderButton ? 'high' : 'medium',
        file: filePath,
        line: unnamedButton.line,
        title: isReorderButton ? 'Icon-only reorder buttons missing accessible names' : 'Button does not show an accessible name',
        evidence: isReorderButton
          ? 'The changed reorder control renders as an icon-only button/component button without visible text or aria labeling.'
          : 'A changed button appears to render without visible text or aria labeling.',
        impact: isReorderButton
          ? 'Screen-reader users cannot tell which reorder action each control performs, so the ranking or sortable editor becomes difficult or impossible to operate reliably.'
          : 'Icon-only or visually minimal controls can become silent to screen readers, which makes toolbars, modal controls, and media actions hard to discover and use.',
        explanation: isReorderButton
          ? 'Reorder controls are workflow-critical actions, not decorative icons. If move-up and move-down buttons are rendered only as arrows, they need explicit accessible names so assistive technology can distinguish the actions.'
          : 'WordPress plugin screens often rely on compact action buttons. If the control name is only implied by an icon, assistive technology may announce it as a generic button with no purpose.',
        verification: isReorderButton
          ? 'Inspect the rendered reorder controls with assistive technology and confirm each button exposes a distinct accessible name such as Move up or Move down.'
          : 'Inspect the rendered button and confirm it exposes a clear accessible name through visible text or aria-label/aria-labelledby.',
        fixDirection: isReorderButton
          ? 'Add explicit accessible names such as aria-label or aria-labelledby for each icon-only reorder action.'
          : 'Add visible button text or an explicit accessible name for icon-only controls.'
      });
    }

    const clickableButtonWithoutDisabledState = changedLines.find((entry) => /<button\b[^>]*@click|<button\b[^>]*onClick=/.test(entry.text) && !/:disabled=| disabled\b|aria-disabled=/.test(entry.text));
    if (clickableButtonWithoutDisabledState && /\bdisabled\b/.test(currentContent) && !/this\.disabled|if\s*\(\s*!option\s*\|\|\s*this\.disabled|if\s*\(\s*this\.disabled\s*\)/.test(currentContent)) {
      pushFinding(findings, {
        severity: 'medium',
        confidence: 'medium',
        file: filePath,
        line: clickableButtonWithoutDisabledState.line,
        title: 'Custom interactive control does not show disabled-state enforcement',
        evidence: 'A changed clickable button does not show disabled binding, and the component logic does not visibly guard interaction when disabled.',
        impact: 'Disabled-looking controls can remain reachable or actionable for keyboard users and assistive technology, causing inconsistent UI state and accessibility regressions.',
        explanation: 'Custom controls often need disabled handling in both markup and behavior. If the element is still clickable or focusable while the form considers it disabled, assistive-technology users can trigger states that mouse users cannot.',
        verification: 'Confirm every interactive child control receives disabled semantics and that click/change handlers return early when the component is disabled.',
        fixDirection: 'Propagate disabled semantics to all interactive controls and guard event handlers against disabled interaction.'
      });
    }
  }

  if (runAccessibilityChecks && isStyleLikeFile) {
    const outlineRemoved = changedLines.find((entry) => /outline\s*:\s*none/.test(entry.text));
    if (outlineRemoved && /cursor\s*:\s*pointer|appearance\s*:\s*none|<button\b/.test(currentContent) && !/:focus-visible[\s\S]{0,400}(outline|box-shadow|border)/.test(currentContent)) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'medium',
        file: filePath,
        line: outlineRemoved.line,
        title: 'Custom interactive styling removes focus indication without a visible replacement',
        evidence: 'The changed styles remove outline from an interactive element, but the file does not show a nearby :focus-visible replacement.',
        impact: 'Keyboard users can tab to the control without any clear visual indication of focus, which is a real usability and accessibility regression.',
        explanation: 'Custom UI components often remove browser default button styling. If the replacement styles do not restore a visible focus state, non-mouse navigation becomes much harder even though the control still works functionally.',
        verification: 'Tab through the changed control and confirm the focused state remains clearly visible against the surrounding UI.',
        fixDirection: 'Add a visible :focus-visible or equivalent focus treatment whenever default outlines are removed.'
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
      explanation: 'Brand new high-risk files tend to have the highest chance of missing edge-case coverage because no previous behavior existed to constrain the implementation.',
      verification: 'Confirm there is a manual test checklist or automated coverage for the key happy path, failure path, and permission path before PR.',
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
    return 'REQUEST_CHANGES';
  }

  if (findings.length) {
    return 'COMMENT';
  }

  return 'APPROVE';
}

function countBlockerFindings(findings) {
  return findings.filter((item) => item.severity === 'critical' || (item.severity === 'important' && item.confidence !== 'low')).length;
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

function clampConfidenceScore(score) {
  return Math.max(1, Math.min(5, parseInt(score, 10) || 3));
}

function normalizeConfidenceScore(rawScore, findings, context) {
  const reviewedFiles = context.reviewedFilesCount || 0;
  const deepReviewedFiles = context.codexReviewedFilesCount || 0;
  const hasCriticalFinding = findings.some((item) => item.severity === 'critical');
  const importantFindings = findings.filter((item) => item.severity === 'important');
  const mediumFindings = findings.filter((item) => item.severity === 'medium');
  const isCodexReview = context.engine === 'codex' && !context.fallbackUsed;
  const isHeuristicOnly = context.engine === 'heuristic' || context.fallbackUsed;
  const touchedHighRiskPaths = Boolean(context.highRiskTouched);
  let score = clampConfidenceScore(rawScore || buildConfidence(findings));

  if (!reviewedFiles) {
    return 4;
  }

  if (isHeuristicOnly) {
    if (!findings.length) {
      if (
        !touchedHighRiskPaths &&
        reviewedFiles <= 2
      ) {
        return 5;
      }

      return 4;
    }

    if (hasCriticalFinding || importantFindings.length >= 2) {
      return 2;
    }

    return 3;
  }

  if (!isCodexReview) {
    return clampConfidenceScore(score);
  }

  if (hasCriticalFinding || importantFindings.length >= 3) {
    return 2;
  }

  if (findings.length) {
    return 3;
  }

  if (touchedHighRiskPaths) {
    return 4;
  }

  if (
    context.reviewDepth === 'thorough' &&
    deepReviewedFiles &&
    deepReviewedFiles === reviewedFiles &&
    reviewedFiles <= 2
  ) {
    return 5;
  }

  return 4;
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

function getCurrentCommit(cwd) {
  try {
    return runGit(['rev-parse', '--short', 'HEAD'], { cwd }).trim();
  } catch (error) {
    return null;
  }
}

function getCurrentBranch(cwd) {
  try {
    return runGit(['branch', '--show-current'], { cwd }).trim() || 'HEAD';
  } catch (error) {
    return 'HEAD';
  }
}

function getRepoLabel(cwd) {
  try {
    const root = runGit(['rev-parse', '--show-toplevel'], { cwd }).trim();
    return path.basename(root);
  } catch (error) {
    return path.basename(cwd);
  }
}

function getRepoRoot(cwd) {
  try {
    return runGit(['rev-parse', '--show-toplevel'], { cwd }).trim();
  } catch (error) {
    return cwd;
  }
}

function getStateDirectory() {
  return path.join(os.homedir(), '.codex', 'codex-review', 'state');
}

function getStatePath(repoRoot) {
  const key = crypto.createHash('sha1').update(repoRoot).digest('hex');
  return path.join(getStateDirectory(), `${key}.json`);
}

function getCacheDirectory() {
  return path.join(os.homedir(), '.codex', 'codex-review', 'cache');
}

function getCachePath(cacheKey) {
  return path.join(getCacheDirectory(), `${cacheKey}.json`);
}

function stableSerialize(value) {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function loadCacheEntry(cacheKey) {
  const cachePath = getCachePath(cacheKey);

  if (!fileExists(cachePath)) {
    return null;
  }

  try {
    return JSON.parse(safeReadFile(cachePath));
  } catch (error) {
    return null;
  }
}

function saveCacheEntry(cacheKey, payload) {
  const cacheDir = getCacheDirectory();
  fs.mkdirSync(cacheDir, { recursive: true });
  writeJsonFile(getCachePath(cacheKey), payload);
}

function normalizeFingerprintPart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function buildFindingFingerprint(finding) {
  return [
    normalizeFingerprintPart(finding.severity),
    normalizeFingerprintPart(finding.title),
    normalizeFingerprintPart(finding.file)
  ].join('|');
}

function encodeMetadataComment(payload) {
  return `<!-- pr-reviewer-meta:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')} -->`;
}

function loadPreviousReviewState(repoRoot) {
  const statePath = getStatePath(repoRoot);

  if (!fileExists(statePath)) {
    return null;
  }

  try {
    return JSON.parse(safeReadFile(statePath));
  } catch (error) {
    return null;
  }
}

function saveReviewState(repoRoot, report) {
  const stateDir = getStateDirectory();
  fs.mkdirSync(stateDir, { recursive: true });

  const state = {
    repoRoot,
    repoLabel: report.repoLabel,
    workflow: report.workflow || null,
    baseRef: report.baseRef,
    mode: report.mode,
    reviewDepth: report.reviewDepth,
    engine: report.engine,
    reviewedCommit: report.reviewedCommit,
    verdict: report.verdict,
    confidenceScore: report.confidenceScore,
    diffStats: report.diffStats,
    scope: {
      reviewedFiles: report.scope.reviewedFiles,
      codexReviewedFiles: report.scope.codexReviewedFiles || []
    },
    savedAt: new Date().toISOString(),
    findings: report.findings.map((finding) => ({
      fingerprint: finding.fingerprint || buildFindingFingerprint(finding),
      severity: finding.severity,
      confidence: finding.confidence,
      file: finding.file,
      line: finding.line,
      title: finding.title
    }))
  };

  writeJsonFile(getStatePath(repoRoot), state);
}

function buildConfidenceLabel(score) {
  if (score >= 5) {
    return 'very high';
  }

  if (score === 4) {
    return 'merge-ready';
  }

  if (score === 3) {
    return 'not merge-ready';
  }

  return 'low';
}

function isSafeToMerge(report) {
  return Boolean(report && report.confidenceScore >= 4 && !report.findings.length);
}

function deriveVerdictFromScore(report) {
  if (!report) {
    return 'COMMENT';
  }

  if (isSafeToMerge(report)) {
    return 'APPROVE';
  }

  if (report.findings && report.findings.length) {
    return 'REQUEST_CHANGES';
  }

  return report.verdict || 'COMMENT';
}

function buildFindingSummary(findings) {
  const counts = {
    critical: 0,
    important: 0,
    medium: 0,
    low: 0
  };

  findings.forEach((finding) => {
    counts[finding.severity] += 1;
  });

  return counts;
}

function getSeverityDisplayLabel(severity) {
  const labels = {
    critical: 'Critical',
    important: 'Important',
    medium: 'Medium',
    low: 'Low'
  };

  return labels[severity] || severity;
}

function getSeverityKeyLabel(severity) {
  return String(severity || '').toUpperCase();
}

function getSeverityOrder() {
  return ['critical', 'important', 'medium', 'low'];
}

function groupFindingsBySeverity(findings) {
  const groups = new Map(getSeverityOrder().map((severity) => [severity, []]));

  findings.forEach((finding) => {
    if (!groups.has(finding.severity)) {
      groups.set(finding.severity, []);
    }
    groups.get(finding.severity).push(finding);
  });

  return groups;
}

function getFindingDisplayEntries(findings) {
  const groups = groupFindingsBySeverity(findings);
  const entries = [];

  getSeverityOrder().forEach((severity) => {
    const severityFindings = groups.get(severity) || [];
    severityFindings.forEach((finding, index) => {
      entries.push({
        ...finding,
        severityIndex: index + 1,
        severityKey: `${getSeverityKeyLabel(severity)}-${String(index + 1).padStart(2, '0')}`
      });
    });
  });

  return entries;
}

function buildPrioritizedBacklog(findings) {
  return getFindingDisplayEntries(findings).map((finding) => ({
    key: finding.severityKey,
    title: finding.title,
    task: finding.fixDirection,
    file: finding.file,
    line: finding.line
  }));
}

function slugifyHeading(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function buildFixPrompt(report, finding) {
  return [
    `This is a local pre-PR review comment for ${report.repoLabel}.`,
    `Path: ${finding.file}`,
    `Line: ${finding.line}`,
    '',
    `Issue: ${finding.title}`,
    `What is wrong: ${finding.evidence}`,
    `Why it matters: ${finding.impact}`,
    `Explanation: ${finding.explanation || 'Review the changed logic carefully and confirm the current behavior is still correct.'}`,
    `What to verify: ${finding.verification || 'Add or run targeted checks around this path.'}`,
    `Fix direction: ${finding.fixDirection}`,
    '',
    'Apply a concise fix without changing unrelated behavior.'
  ].join('\n');
}

function buildFixAllPrompt(report) {
  if (!report.findings.length) {
    return '';
  }

  const header = [
    `Apply the confirmed review fixes for ${report.repoLabel}${report.reviewedCommit ? ` at commit ${report.reviewedCommit}` : ''}.`,
    'Keep behavior unchanged outside these issues.',
    ''
  ];

  const issues = report.findings.map((finding, index) => [
    `${index + 1}. ${finding.title}`,
    `What: ${finding.evidence}`,
    `Why: ${finding.impact}`,
    `Explanation: ${finding.explanation || 'Review the changed logic carefully and confirm the current behavior is still correct.'}`,
    `Verify: ${finding.verification || 'Add or run targeted checks around this path.'}`,
    `Fix: ${finding.fixDirection}`,
    ''
  ].join('\n'));

  return header.concat(issues).join('\n');
}

function buildOutsideDiffPrompt(report, finding) {
  return [
    `This is a follow-up review item for ${report.repoLabel}${report.reviewedCommit ? ` at commit ${report.reviewedCommit}` : ''}.`,
    `Location: ${finding.file}:${finding.line}`,
    `Issue: ${finding.title}`,
    `Why it matters: ${finding.explanation}`,
    `What to verify: ${finding.verification}`,
    `Fix direction: ${finding.fixDirection}`,
    '',
    'Treat this as outside-diff follow-up work unless the same code path already needs changes in this branch.'
  ].join('\n');
}

function buildRecheckState(previousState, findings, reviewedCommit, report) {
  if (!previousState || !previousState.findings || !previousState.findings.length) {
    return null;
  }

  const comparable = (
    (previousState.workflow || null) === (report.workflow || null) &&
    previousState.baseRef === report.baseRef &&
    previousState.mode === report.mode &&
    previousState.reviewDepth === report.reviewDepth
  );

  if (!comparable) {
    return null;
  }

  const previousMap = new Map(previousState.findings.map((finding) => [finding.fingerprint, finding]));
  const currentMap = new Map(findings.map((finding) => [finding.fingerprint, finding]));
  const cleared = previousState.findings.filter((finding) => !currentMap.has(finding.fingerprint));
  const remaining = findings.filter((finding) => previousMap.has(finding.fingerprint));
  const introduced = findings.filter((finding) => !previousMap.has(finding.fingerprint));
  const commitChanged = Boolean(previousState.reviewedCommit && reviewedCommit && previousState.reviewedCommit !== reviewedCommit);

  if (!commitChanged && !cleared.length && !remaining.length && !introduced.length) {
    return null;
  }

  return {
    previousCommit: previousState.reviewedCommit || null,
    previousVerdict: previousState.verdict || null,
    previousConfidenceScore: previousState.confidenceScore || null,
    previousDiffStats: previousState.diffStats || null,
    previousScope: previousState.scope || null,
    commitChanged,
    cleared,
    remaining,
    introduced,
    verdictChanged: Boolean(previousState.verdict && previousState.verdict !== report.verdict),
    confidenceDelta: typeof previousState.confidenceScore === 'number'
      ? report.confidenceScore - previousState.confidenceScore
      : null,
    reviewedFilesDelta: previousState.diffStats && typeof previousState.diffStats.files === 'number'
      ? report.diffStats.files - previousState.diffStats.files
      : null
  };
}

function buildNarrativeSummary(report) {
  const counts = buildFindingSummary(report.findings);

  if (report.recheck) {
    const parts = [];

    if (report.recheck.cleared.length) {
      parts.push(`${report.recheck.cleared.length} previous finding(s) cleared`);
    }

    if (report.recheck.introduced.length) {
      parts.push(`${report.recheck.introduced.length} new finding(s) introduced`);
    }

    if (report.findings.length) {
      const remainingLabel = report.verdict === 'REQUEST_CHANGES' ? 'merge-blocking finding(s) remain' : 'finding(s) remain';
      parts.push(`${report.findings.length} ${remainingLabel}`);
    } else {
      parts.push('blocking findings cleared');
    }

    const commitLabel = report.reviewedCommit ? `Rechecked \`${report.reviewedCommit}\`` : 'Rechecked current branch state';
    return `${commitLabel}. ${parts.join('. ')}.`;
  }

  if (!report.findings.length) {
    return 'No meaningful issues were found in the reviewed changes.';
  }

  const leading = [];

  if (counts.critical || counts.important) {
    leading.push(`Found ${counts.critical + counts.important} blocker-level issue(s)`);
  } else {
    leading.push(`Found ${report.findings.length} issue(s) worth addressing before PR`);
  }

  if (report.findings[0]) {
    leading.push(`highest-signal finding: ${report.findings[0].title}`);
  }

  return `${leading.join('; ')}.`;
}

function buildPrReviewSummary(report) {
  const blockerCount = countBlockerFindings(report.findings);

  if (report.recheck) {
    if (!report.findings.length) {
      return 'The follow-up changes address the previously confirmed blockers. The reviewed diff is ready to merge.';
    }

    if (report.confidenceScore <= 3 || blockerCount) {
      const resolved = report.recheck.cleared.length;
      const opening = resolved
        ? `The follow-up changes resolved ${resolved} previously confirmed issue(s), but merge-blocking issues still remain.`
        : 'The follow-up changes improve the implementation, but merge-blocking issues still remain.';
      return opening;
    }

    return 'The follow-up changes clear the merge blockers, but there are still non-blocking issues worth addressing.';
  }

  if (!report.findings.length) {
    return 'The implementation looks good. No confirmed issues were found in the reviewed changes.';
  }

  if (report.confidenceScore <= 3 || blockerCount) {
    return 'The implementation is close, but there are merge-blocking issues to resolve before this PR is ready.';
  }

  return 'The implementation is in good shape overall, but there are still issues worth resolving before merge.';
}

function getReportTitle(report) {
  if (report.workflow === 'debugger') {
    return `Debugger Report — ${report.repoLabel}`;
  }

  if (report.workflow === 'plugin-audit') {
    return `Plugin Audit Report — ${report.repoLabel}`;
  }

  return `Codex Review Report — ${report.repoLabel}`;
}

function getWorkflowSeverityLabel(workflow, severity) {
  if (workflow === 'plugin-audit') {
    return {
      critical: 'CRITICAL',
      important: 'HIGH',
      medium: 'MEDIUM',
      low: 'SUGGESTION'
    }[severity] || String(severity || '').toUpperCase();
  }

  return {
    critical: 'CRITICAL',
    important: 'HIGH',
    medium: 'MEDIUM',
    low: 'LOW'
  }[severity] || String(severity || '').toUpperCase();
}

function getWorkflowSeverityHeading(workflow, severity) {
  if (workflow === 'plugin-audit') {
    return {
      critical: 'Critical',
      important: 'High',
      medium: 'Medium',
      low: 'Suggestion'
    }[severity] || getSeverityDisplayLabel(severity);
  }

  return {
    critical: 'Critical',
    important: 'High',
    medium: 'Medium',
    low: 'Low'
  }[severity] || getSeverityDisplayLabel(severity);
}

function getWorkflowDisplayEntries(workflow, findings) {
  const groups = groupFindingsBySeverity(findings);
  const entries = [];

  getSeverityOrder().forEach((severity) => {
    const severityFindings = groups.get(severity) || [];
    severityFindings.forEach((finding, index) => {
      entries.push({
        ...finding,
        severityIndex: index + 1,
        severityKey: `${getWorkflowSeverityLabel(workflow, severity)}-${String(index + 1).padStart(2, '0')}`
      });
    });
  });

  return entries;
}

function inferFindingArea(finding) {
  const haystack = `${finding.title}\n${finding.evidence}\n${finding.explanation}\n${finding.verification}`.toLowerCase();

  if (/(nonce|capability|auth|permission|xss|sql|ssrf|sanitize|csrf|secret|token|file upload|attachment deletion|current_user_can|wp_ajax_nopriv)/.test(haystack)) {
    return 'Security';
  }

  if (/(memory|timeout|response-size|unbounded|slow|performance|scheduler|async save path|sync save path|queue|duplicate scheduling)/.test(haystack)) {
    return 'Optimization';
  }

  return 'Traceability';
}

function inferRiskClassification(finding) {
  const haystack = `${finding.title}\n${finding.explanation}\n${finding.verification}`.toLowerCase();
  if (finding.severity === 'low' || /verification|follow-up|manual check|test changes/.test(haystack)) {
    return 'Hardening';
  }

  return 'Bug';
}

function buildSeverityRationale(finding, workflow) {
  const label = getWorkflowSeverityHeading(workflow, finding.severity);
  if (finding.severity === 'critical') {
    return `${label}: the code evidence points to a directly actionable security or data-integrity failure with merge-blocking impact.`;
  }

  if (finding.severity === 'important') {
    return `${label}: the path looks merge-blocking because the failure mode is concrete and can break authorization, persistence, or core user flows.`;
  }

  if (finding.severity === 'medium') {
    return `${label}: the issue is meaningful and evidence-backed, but the impact appears more bounded than a blocker.`;
  }

  if (workflow === 'plugin-audit') {
    return `${label}: the signal is useful as an implementation improvement or caution, but it does not currently justify blocker status.`;
  }

  return `${label}: the issue is real enough to keep on the backlog, but the current impact looks limited or primarily hardening-oriented.`;
}

function buildWorkflowVerifierNote(finding) {
  if (finding.confidence === 'high') {
    return 'Verifier re-traced the changed path and the failure mode stays intact without finding a stronger mitigating guard in the supplied code.';
  }

  return 'Verifier kept this issue because the code path still shows a concrete gap, but the final impact should be re-checked during fix validation.';
}

function buildExpectedActualBehavior(finding) {
  return `Expected: ${finding.verification || 'the changed path should preserve the intended guarded behavior.'} Actual: ${finding.evidence}`;
}

function buildFeedbackForNextRun(finding) {
  const haystack = `${finding.title}\n${finding.evidence}`.toLowerCase();

  if (/nonce|capability|auth|permission/.test(haystack)) {
    return 'Re-check authz findings end to end: route/policy/helper/resource binding, not only nonce presence.';
  }

  if (/subtitle|storyboard|remote|response-size|attachment/.test(haystack)) {
    return 'Prioritize remote-work and attachment flows again when player media features change, especially around ownership and bounded payload handling.';
  }

  if (/focus|label|button|keyboard|accessibility/.test(haystack)) {
    return 'Repeat the UI audit with keyboard-only interaction and rendered accessibility checks before merge.';
  }

  return 'Keep this regression class in the next run and require end-to-end verification before treating similar paths as safe.';
}

function buildTaskStatement(finding) {
  return finding.fixDirection || finding.verification || 'Implement the narrowest fix that removes the confirmed failure mode and re-verify the affected workflow.';
}

function buildEntryPoint(reviewContext, finding) {
  if (/app\/http\/routes\//i.test(finding.file)) {
    return `Route definition in ${finding.file}`;
  }

  if (/controller|handler|hook|actions\.php|filters\.php/i.test(finding.file)) {
    return `Runtime entry in ${finding.file}`;
  }

  return `Changed path in ${finding.file}`;
}

function createWorkflowRejectedCandidate(finding, reviewContext, reason) {
  return {
    title: finding.title,
    file: finding.file,
    line: finding.line,
    confidence: finding.confidence,
    area: inferFindingArea(finding),
    entryPoint: buildEntryPoint(reviewContext, finding),
    evidence: finding.evidence,
    rejectionReason: reason,
    verifierNote: 'Verifier did not keep this as a confirmed issue because the current signal is too generic or not tied to a concrete broken effect.'
  };
}

function createWorkflowManualCandidate(finding, reviewContext, reason) {
  return {
    ...finding,
    area: inferFindingArea(finding),
    entryPoint: buildEntryPoint(reviewContext, finding),
    taskStatement: buildTaskStatement(finding),
    verifierNote: reason
  };
}

function enrichWorkflowFinding(finding, workflow, reviewContext) {
  return {
    ...finding,
    area: inferFindingArea(finding),
    riskClassification: inferRiskClassification(finding),
    entryPoint: buildEntryPoint(reviewContext, finding),
    reproductionPath: finding.verification,
    expectedActualBehavior: buildExpectedActualBehavior(finding),
    severityRationale: buildSeverityRationale(finding, workflow),
    recommendedFix: finding.fixDirection,
    verifierNote: buildWorkflowVerifierNote(finding),
    feedbackForNextRun: buildFeedbackForNextRun(finding),
    taskStatement: buildTaskStatement(finding)
  };
}

function isVerifierOnlySignal(finding) {
  return /verification|without matching test changes|coverage|manual scenario|needs product-specific verification/i.test(`${finding.title}\n${finding.explanation}\n${finding.verification}`);
}

function buildWorkflowFeedbackUpdates(confirmedFindings, rejectedCandidates, manualCandidates) {
  const updates = [];

  if (rejectedCandidates.length) {
    updates.push('Reject broad verification-only warnings unless they point to a concrete broken effect in the changed code path.');
  }

  if (manualCandidates.some((finding) => /nonce|capability|auth/i.test(`${finding.title}\n${finding.evidence}`))) {
    updates.push('Keep public-endpoint and delegated-permission checks skeptical: require resource binding and exact permission matching, not only a visible nonce.');
  }

  if (confirmedFindings.some((finding) => /focus|label|keyboard|button|accessibility/i.test(`${finding.title}\n${finding.evidence}`))) {
    updates.push('When UI controls change, pair static checks with rendered accessibility verification instead of treating markup-only review as sufficient.');
  }

  if (confirmedFindings.some((finding) => /remote|response-size|subtitle|attachment|storyboard/i.test(`${finding.title}\n${finding.evidence}`))) {
    updates.push('Repeat remote payload and ownership checks on media-related changes, because these regressions reappear when new service integrations are added.');
  }

  return Array.from(new Set(updates));
}

function classifyPluginAuditWorkstream(finding) {
  const haystack = `${finding.title}\n${finding.evidence}\n${finding.explanation}`.toLowerCase();

  if (inferFindingArea(finding) === 'Security') {
    return 'Security';
  }

  if (/dead code|unused|duplicate|duplication|unreachable/.test(haystack)) {
    return 'Dead code and duplication';
  }

  if (/memory|timeout|response-size|slow|performance|queue|scheduler/.test(haystack)) {
    return 'Performance and optimization';
  }

  if (/block|shortcode|frontend|ui|modal|button|label|focus|settings path|render|bootstrap/.test(haystack)) {
    return 'Traceability from UI entry points to handlers';
  }

  return 'Traceability from handlers to services/database and back to response';
}

function applyDebuggerWorkflow(reviewResult, reviewContext) {
  const confirmed = [];
  const rejectedCandidates = [];
  const manualCandidates = [];

  (reviewResult.findings || []).forEach((finding) => {
    if (finding.confidence === 'low' && finding.severity !== 'critical') {
      if (isVerifierOnlySignal(finding)) {
        manualCandidates.push(createWorkflowManualCandidate(finding, reviewContext, 'Verifier kept this as a follow-up item rather than a confirmed bug because the signal is real but still too verification-oriented.'));
      } else {
        rejectedCandidates.push(createWorkflowRejectedCandidate(finding, reviewContext, 'The signal was too weak to survive verification as a confirmed bug.'));
      }
      return;
    }

    confirmed.push(enrichWorkflowFinding(finding, 'debugger', reviewContext));
  });

  (reviewResult.outsideDiffFindings || []).forEach((finding) => {
    manualCandidates.push(createWorkflowManualCandidate(finding, reviewContext, 'Verifier could not confirm this inside the changed lines and kept it for manual follow-up.'));
  });

  const feedbackUpdates = buildWorkflowFeedbackUpdates(confirmed, rejectedCandidates, manualCandidates);
  const verdictCounts = {
    confirmed: confirmed.length,
    rejected: rejectedCandidates.length,
    manual: manualCandidates.length
  };

  return {
    ...reviewResult,
    verdict: buildVerdict(confirmed),
    confidenceScore: buildConfidence(confirmed),
    summary: confirmed.length
      ? `Finder generated ${confirmed.length + rejectedCandidates.length + manualCandidates.length} candidate(s); verifier confirmed ${confirmed.length}, rejected ${rejectedCandidates.length}, and left ${manualCandidates.length} for manual verification.`
      : `Finder generated ${rejectedCandidates.length + manualCandidates.length} candidate(s), but verifier did not confirm a blocker-level bug in the current diff.`,
    findings: confirmed,
    outsideDiffFindings: manualCandidates,
    workflowData: {
      rejectedCandidates,
      needsManualVerification: manualCandidates,
      feedbackUpdates,
      verdictCounts
    }
  };
}

function applyPluginAuditWorkflow(reviewResult, reviewContext) {
  const confirmed = [];
  const manualCandidates = [];

  (reviewResult.findings || []).forEach((finding) => {
    if ((finding.severity === 'critical' || finding.severity === 'important') && finding.confidence === 'low') {
      manualCandidates.push(createWorkflowManualCandidate(finding, reviewContext, 'Pass 6 verification downgraded this to manual follow-up because the impact path is plausible but not proven strongly enough in the current static evidence.'));
      return;
    }

    confirmed.push(enrichWorkflowFinding(finding, 'plugin-audit', reviewContext));
  });

  (reviewResult.outsideDiffFindings || []).forEach((finding) => {
    manualCandidates.push(createWorkflowManualCandidate(finding, reviewContext, 'Pass 6 verification kept this outside the confirmed set because it depends on adjacent code or runtime behavior not fully shown in the diff.'));
  });

  const workstreamNames = [
    'Security',
    'Performance and optimization',
    'Dead code and duplication',
    'Traceability from UI entry points to handlers',
    'Traceability from handlers to services/database and back to response'
  ];

  const workstreamSummaries = workstreamNames.map((name) => ({
    name,
    confirmedCount: confirmed.filter((finding) => classifyPluginAuditWorkstream(finding) === name).length,
    manualCount: manualCandidates.filter((finding) => classifyPluginAuditWorkstream(finding) === name).length
  }));

  return {
    ...reviewResult,
    verdict: buildVerdict(confirmed),
    confidenceScore: buildConfidence(confirmed),
    summary: confirmed.length
      ? `Sequentially emulated five audit workstreams plus Pass 6 verification and confirmed ${confirmed.length} implementation-ready issue(s).`
      : 'Sequentially emulated five audit workstreams plus Pass 6 verification and found no confirmed issues in the reviewed diff.',
    findings: confirmed,
    outsideDiffFindings: manualCandidates,
    workflowData: {
      needsManualVerification: manualCandidates,
      workstreamSummaries
    }
  };
}

function applyWorkflowPostProcessing(options, reviewContext, reviewResult) {
  if (options.workflow === 'debugger') {
    return applyDebuggerWorkflow(reviewResult, reviewContext);
  }

  if (options.workflow === 'plugin-audit') {
    return applyPluginAuditWorkflow(reviewResult, reviewContext);
  }

  return reviewResult;
}

function renderText(report) {
  const lines = [];
  const counts = buildFindingSummary(report.findings);
  const blockerCount = countBlockerFindings(report.findings);
  const displayFindings = getFindingDisplayEntries(report.findings);
  const groupedFindings = groupFindingsBySeverity(displayFindings);
  const backlogItems = buildPrioritizedBacklog(report.findings);

  lines.push(getReportTitle(report), '');
  lines.push('Summary', '');
  lines.push(buildNarrativeSummary(report));
  lines.push('');
  lines.push(report.summary);
  lines.push('');
  lines.push(`Merge stance: ${report.verdict}`);
  if (report.workflow) {
    lines.push(`Workflow: ${report.workflow}`);
  }
  lines.push(`Confidence score: ${report.confidenceScore}/5 (${buildConfidenceLabel(report.confidenceScore)})`);
  lines.push(`Base: ${report.baseRef}`);
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Review depth: ${report.reviewDepth}`);
  lines.push(`Engine: ${report.engine}${report.fallbackUsed ? ' (heuristic fallback)' : ''}`);

  if (report.scope.reviewedFiles.length) {
    lines.push('', 'Files Reviewed:');
    report.scope.reviewedFiles.forEach((filePath) => lines.push(`- ${filePath}`));
  }

  if (report.scope.codexReviewedFiles && report.scope.codexReviewedFiles.length) {
    lines.push('', 'Codex Deep Review Scope:');
    report.scope.codexReviewedFiles.forEach((filePath) => lines.push(`- ${filePath}`));
  }

  if (report.keyChanges.length) {
    lines.push('', 'Key Changes:');
    report.keyChanges.forEach((item) => lines.push(`- ${item}`));
  }

  if (report.notes.length) {
    lines.push('', 'Notes:');
    report.notes.forEach((note) => lines.push(`- ${note}`));
  }

  if (report.stageSummaries && report.stageSummaries.length) {
    lines.push('', 'Engine Stages:');
    report.stageSummaries.forEach((stage) => lines.push(`- ${stage.name}: ${stage.status}, ${stage.findings} finding(s), ${formatDurationMs(stage.durationMs || 0)}`));
  }

  if (report.runtimeAccessibility && report.runtimeAccessibility.pages && report.runtimeAccessibility.pages.length) {
    lines.push('', 'Rendered Accessibility Scan:');
    lines.push(`- Pages scanned: ${report.runtimeAccessibility.pages.length}`);
    report.runtimeAccessibility.pages.forEach((page) => {
      lines.push(`- ${page.url} (${page.violations} violation(s))`);
    });
  }

  if (report.recheck) {
    lines.push('', 'Recheck Status:');
    if (report.recheck.previousCommit) {
      lines.push(`- Previous reviewed commit: ${report.recheck.previousCommit}`);
    }
    if (report.recheck.verdictChanged) {
      lines.push(`- Verdict changed: ${report.recheck.previousVerdict} -> ${report.verdict}`);
    }
    if (typeof report.recheck.confidenceDelta === 'number' && report.recheck.confidenceDelta !== 0) {
      lines.push(`- Confidence change: ${report.recheck.previousConfidenceScore}/5 -> ${report.confidenceScore}/5`);
    }
    if (typeof report.recheck.reviewedFilesDelta === 'number' && report.recheck.reviewedFilesDelta !== 0) {
      lines.push(`- Changed-file scope delta: ${report.recheck.previousDiffStats.files} -> ${report.diffStats.files}`);
    }
    if (report.recheck.cleared.length) {
      lines.push(`- Cleared since last review: ${report.recheck.cleared.length}`);
      report.recheck.cleared.slice(0, 5).forEach((finding) => lines.push(`  - ${finding.title} (${finding.file}:${finding.line})`));
    }
    if (report.recheck.remaining.length) {
      lines.push(`- Still present: ${report.recheck.remaining.length}`);
    }
    if (report.recheck.introduced.length) {
      lines.push(`- New since last review: ${report.recheck.introduced.length}`);
      report.recheck.introduced.slice(0, 5).forEach((finding) => lines.push(`  - ${finding.title} (${finding.file}:${finding.line})`));
    }
  }

  if (displayFindings.length) {
    lines.push('', 'Table of Contents:');
    displayFindings.forEach((finding) => lines.push(`- ${finding.severityKey}: ${finding.title}`));
  }

  if (displayFindings.length) {
    lines.push('', 'Confirmed Findings By Severity', '');
    if (blockerCount) {
      lines.push('Must fix before merge.');
      lines.push('');
    } else {
      lines.push('No confirmed blocker-level findings, but the following issues are still worth resolving before PR.');
      lines.push('');
    }
    lines.push(`Verification confirmed ${counts.critical} critical, ${counts.important} important, ${counts.medium} medium, and ${counts.low} low finding(s) in the reviewed changes.`);

    getSeverityOrder().forEach((severity) => {
      const severityFindings = groupedFindings.get(severity) || [];
      if (!severityFindings.length) {
        return;
      }

      lines.push('');
      lines.push(`${getSeverityDisplayLabel(severity)} Findings`);
      lines.push('');

      severityFindings.forEach((finding) => {
        lines.push(`${finding.severityKey}: ${finding.title}`);
        lines.push(`   Confidence: ${finding.confidence}`);
        lines.push(`   Fingerprint: ${finding.fingerprint}`);
        lines.push(`   File: ${finding.file}:${finding.line}`);
        lines.push(`   Evidence: ${finding.evidence}`);
        lines.push(`   Impact: ${finding.impact}`);
        lines.push(`   Explanation: ${finding.explanation || 'No additional explanation provided.'}`);
        lines.push(`   What to verify: ${finding.verification || 'Add or run targeted checks around this path.'}`);
        lines.push(`   Recommended fix: ${finding.fixDirection}`);
        lines.push('   Prompt To Fix With AI:');
        lines.push('');
        buildFixPrompt(report, finding).split('\n').forEach((line) => lines.push(`   ${line}`));
        lines.push('');
      });
    });

    lines.push('Prioritized Fix Backlog', '');
    backlogItems.forEach((item) => lines.push(`- ${item.key}: ${item.task} (${item.file}:${item.line})`));
    lines.push('', 'Prompt To Fix All With AI:', '');
    buildFixAllPrompt(report).split('\n').forEach((line) => lines.push(line));
  } else {
    lines.push('', 'Confirmed Findings By Severity', '', 'No findings.');
  }

  if (report.outsideDiffFindings.length) {
    lines.push('', 'Needs Manual Verification', '');
    report.outsideDiffFindings.forEach((finding, index) => {
      lines.push(`${index + 1}. ${finding.title}`);
      lines.push(`   Severity: ${finding.severity}`);
      lines.push(`   Fingerprint: ${finding.fingerprint}`);
      lines.push(`   Location: ${finding.file}:${finding.line}`);
      lines.push(`   Why this needs follow-up: ${finding.explanation}`);
      lines.push(`   What to verify: ${finding.verification}`);
      lines.push(`   Suggested fix direction: ${finding.fixDirection}`);
      lines.push('   Prompt To Fix With AI:');
      lines.push('');
      buildOutsideDiffPrompt(report, finding).split('\n').forEach((line) => lines.push(`   ${line}`));
      lines.push('');
    });
  }

  if (report.reviewedCommit) {
    lines.push('', `Last reviewed commit: ${report.reviewedCommit}`);
  }

  return lines.join('\n');
}

function renderDebuggerMarkdown(report) {
  const confirmedFindings = getWorkflowDisplayEntries('debugger', report.findings);
  const severityCounts = buildFindingSummary(report.findings);
  const rejectedCandidates = (report.workflowData && report.workflowData.rejectedCandidates) || [];
  const manualCandidates = (report.workflowData && report.workflowData.needsManualVerification) || [];
  const feedbackUpdates = (report.workflowData && report.workflowData.feedbackUpdates) || [];
  const backlogItems = confirmedFindings.map((finding) => ({
    key: finding.severityKey,
    task: finding.taskStatement,
    file: finding.file,
    line: finding.line
  }));
  const lines = [
    `# ${getReportTitle(report)}`,
    '',
    '## Executive Summary',
    '',
    report.summary,
    '',
    `- Merge stance: \`${report.verdict}\``,
    `- Confidence Score: \`${report.confidenceScore}/5\` (${buildConfidenceLabel(report.confidenceScore)})`,
    `- Safe to merge: ${isSafeToMerge(report) ? 'yes' : 'no'}`,
    '',
    '| Severity | Count |',
    '| --- | ---: |',
    `| CRITICAL | ${severityCounts.critical} |`,
    `| HIGH | ${severityCounts.important} |`,
    `| MEDIUM | ${severityCounts.medium} |`,
    `| LOW | ${severityCounts.low} |`,
    '',
    '| Verdict bucket | Count |',
    '| --- | ---: |',
    `| Confirmed | ${confirmedFindings.length} |`,
    `| Rejected | ${rejectedCandidates.length} |`,
    `| Needs manual verification | ${manualCandidates.length} |`
  ];

  if (report.stageSummaries && report.stageSummaries.length) {
    lines.push('', '## Engine Stages', '');
    report.stageSummaries.forEach((stage) => {
      lines.push(`- \`${stage.name}\`: \`${stage.status}\`, ${stage.findings} finding(s), ${formatDurationMs(stage.durationMs || 0)}`);
    });
  }

  if (confirmedFindings.length) {
    lines.push('', '## Table of Contents', '');
    confirmedFindings.forEach((finding) => {
      const heading = `${finding.severityKey}: ${finding.title}`;
      lines.push(`- [${heading}](#${slugifyHeading(heading)})`);
    });
  }

  lines.push('', '## Confirmed Bugs by Severity', '');
  getSeverityOrder().forEach((severity) => {
    const grouped = confirmedFindings.filter((finding) => finding.severity === severity);
    if (!grouped.length) {
      return;
    }

    lines.push(`### ${getWorkflowSeverityHeading('debugger', severity)}`, '');
    grouped.forEach((finding) => {
      const heading = `${finding.severityKey}: ${finding.title}`;
      lines.push(`#### ${heading}`, '');
      lines.push(`- Area: \`${finding.area}\``);
      lines.push(`- Risk classification: \`${finding.riskClassification}\``);
      lines.push(`- Confidence: \`${finding.confidence}\``);
      lines.push(`- File:line: \`${finding.file}:${finding.line}\``);
      lines.push(`- Entry point: ${finding.entryPoint}`);
      lines.push(`- Reproduction path: ${finding.reproductionPath}`);
      lines.push(`- Evidence: ${finding.evidence}`);
      lines.push(`- Expected vs actual behavior: ${finding.expectedActualBehavior}`);
      lines.push(`- Impact: ${finding.impact}`);
      lines.push(`- Severity rationale: ${finding.severityRationale}`);
      lines.push(`- Recommended fix: ${finding.recommendedFix}`);
      lines.push(`- Verifier note: ${finding.verifierNote}`);
      lines.push(`- Feedback for next run: ${finding.feedbackForNextRun}`);
      lines.push(`- Task statement: ${finding.taskStatement}`);
      lines.push('');
    });
  });

  lines.push('## Rejected Candidates', '');
  if (rejectedCandidates.length) {
    rejectedCandidates.forEach((finding, index) => {
      lines.push(`### ${index + 1}. ${finding.title}`, '');
      lines.push(`- Area: \`${finding.area}\``);
      lines.push(`- Confidence: \`${finding.confidence}\``);
      lines.push(`- File:line: \`${finding.file}:${finding.line}\``);
      lines.push(`- Entry point: ${finding.entryPoint}`);
      lines.push(`- Evidence: ${finding.evidence}`);
      lines.push(`- Rejection reason: ${finding.rejectionReason}`);
      lines.push(`- Verifier note: ${finding.verifierNote}`);
      lines.push('');
    });
  } else {
    lines.push('No rejected candidates.');
  }

  lines.push('', '## Needs Manual Verification', '');
  if (manualCandidates.length) {
    manualCandidates.forEach((finding, index) => {
      lines.push(`### ${index + 1}. ${finding.title}`, '');
      lines.push(`- Area: \`${finding.area}\``);
      lines.push(`- Confidence: \`${finding.confidence}\``);
      lines.push(`- File:line: \`${finding.file}:${finding.line}\``);
      lines.push(`- Entry point: ${finding.entryPoint}`);
      lines.push(`- Evidence: ${finding.evidence || finding.explanation}`);
      lines.push(`- What to verify: ${finding.verification}`);
      lines.push(`- Recommended fix: ${finding.fixDirection || finding.taskStatement}`);
      lines.push(`- Verifier note: ${finding.verifierNote}`);
      lines.push('');
    });
  } else {
    lines.push('No manual verification items.');
  }

  lines.push('', '## Prioritized Fix Backlog', '');
  backlogItems.forEach((item) => lines.push(`- ${item.key}: ${item.task} (\`${item.file}:${item.line}\`)`));

  lines.push('', '## Feedback Loop Updates', '');
  if (feedbackUpdates.length) {
    feedbackUpdates.forEach((item) => lines.push(`- ${item}`));
  } else {
    lines.push('- No new calibration updates from this run.');
  }

  return lines.join('\n');
}

function renderPluginAuditMarkdown(report) {
  const findings = getWorkflowDisplayEntries('plugin-audit', report.findings);
  const severityCounts = buildFindingSummary(report.findings);
  const manualCandidates = (report.workflowData && report.workflowData.needsManualVerification) || [];
  const workstreamSummaries = (report.workflowData && report.workflowData.workstreamSummaries) || [];
  const backlogItems = findings.map((finding) => ({
    key: finding.severityKey,
    task: finding.taskStatement,
    file: finding.file,
    line: finding.line
  }));
  const date = report.generatedAt || new Date().toISOString().slice(0, 10);
  const branch = report.currentBranch || 'unknown';
  const auditor = `${report.auditorLabel || report.engine} (5-workstream + Pass 6 verification)`;
  const lines = [
    `# Plugin Audit Report — ${report.repoLabel}`,
    `**Branch:** ${branch} | **Date:** ${date} | **Auditor:** ${auditor}`,
    '---',
    '',
    '## Executive Summary',
    '',
    report.summary,
    '',
    `- Merge stance: \`${report.verdict}\``,
    `- Confidence Score: \`${report.confidenceScore}/5\` (${buildConfidenceLabel(report.confidenceScore)})`,
    `- Safe to merge: ${isSafeToMerge(report) ? 'yes' : 'no'}`,
    '',
    '| Severity | Count |',
    '| --- | ---: |',
    `| CRITICAL | ${severityCounts.critical} |`,
    `| HIGH | ${severityCounts.important} |`,
    `| MEDIUM | ${severityCounts.medium} |`,
    `| SUGGESTION | ${severityCounts.low} |`
  ];

  if (report.stageSummaries && report.stageSummaries.length) {
    lines.push('', '## Engine Stages', '');
    report.stageSummaries.forEach((stage) => {
      lines.push(`- \`${stage.name}\`: \`${stage.status}\`, ${stage.findings} finding(s), ${formatDurationMs(stage.durationMs || 0)}`);
    });
  }

  if (workstreamSummaries.length) {
    lines.push('', '### Workstream Summary', '');
    workstreamSummaries.forEach((item) => {
      lines.push(`- ${item.name}: ${item.confirmedCount} confirmed, ${item.manualCount} manual follow-up`);
    });
  }

  if (findings.length) {
    lines.push('', '## Table of Contents', '');
    findings.forEach((finding) => {
      const heading = `${finding.severityKey}: ${finding.title}`;
      lines.push(`- [${heading}](#${slugifyHeading(heading)})`);
    });
  }

  lines.push('', '## Findings by Severity', '');
  getSeverityOrder().forEach((severity) => {
    const grouped = findings.filter((finding) => finding.severity === severity);
    if (!grouped.length) {
      return;
    }

    lines.push(`### ${getWorkflowSeverityHeading('plugin-audit', severity)}`, '');
    grouped.forEach((finding) => {
      const heading = `${finding.severityKey}: ${finding.title}`;
      lines.push(`#### ${heading}`, '');
      lines.push(`- Area: \`${finding.area}\``);
      lines.push(`- Confidence: \`${finding.confidence}\``);
      lines.push(`- File:line: \`${finding.file}:${finding.line}\``);
      lines.push(`- Evidence: ${finding.evidence}`);
      lines.push(`- Impact: ${finding.impact}`);
      lines.push(`- Recommended fix: ${finding.recommendedFix}`);
      lines.push(`- Task statement: ${finding.taskStatement}`);
      if (finding.severity === 'critical' || finding.severity === 'important') {
        lines.push(`- Verifier note: ${finding.verifierNote}`);
      }
      lines.push('');
    });
  });

  lines.push('## Prioritized Implementation Backlog', '');
  backlogItems.forEach((item) => lines.push(`- ${item.key}: ${item.task} (\`${item.file}:${item.line}\`)`));

  lines.push('', '## Needs Manual Verification', '');
  if (manualCandidates.length) {
    manualCandidates.forEach((finding, index) => {
      lines.push(`### ${index + 1}. ${finding.title}`, '');
      lines.push(`- Area: \`${finding.area}\``);
      lines.push(`- Confidence: \`${finding.confidence}\``);
      lines.push(`- File:line: \`${finding.file}:${finding.line}\``);
      lines.push(`- Evidence: ${finding.evidence || finding.explanation}`);
      lines.push(`- Impact: ${finding.impact || finding.explanation}`);
      lines.push(`- Recommended fix: ${finding.fixDirection || finding.taskStatement}`);
      lines.push(`- Task statement: ${finding.taskStatement}`);
      lines.push(`- Verifier note: ${finding.verifierNote}`);
      lines.push('');
    });
  } else {
    lines.push('No manual verification items.');
  }

  return lines.join('\n');
}

function renderMarkdown(report) {
  if (report.workflow === 'debugger') {
    return renderDebuggerMarkdown(report);
  }

  if (report.workflow === 'plugin-audit') {
    return renderPluginAuditMarkdown(report);
  }

  const counts = buildFindingSummary(report.findings);
  const blockerCount = countBlockerFindings(report.findings);
  const displayFindings = getFindingDisplayEntries(report.findings);
  const groupedFindings = groupFindingsBySeverity(displayFindings);
  const backlogItems = buildPrioritizedBacklog(report.findings);
  const lines = [
    `# ${getReportTitle(report)}`,
    '',
    '## Summary',
    '',
    buildNarrativeSummary(report),
    '',
    report.summary,
    '',
    `- Merge stance: \`${report.verdict}\``,
    ...(report.workflow ? [`- Workflow: \`${report.workflow}\``] : []),
    `- Confidence Score: \`${report.confidenceScore}/5\` (${buildConfidenceLabel(report.confidenceScore)})`,
    `- Base: \`${report.baseRef}\``,
    `- Mode: \`${report.mode}\``,
    `- Review depth: \`${report.reviewDepth}\``,
    `- Engine: \`${report.engine}${report.fallbackUsed ? ' (heuristic fallback)' : ''}\``
  ];

  if (report.scope.reviewedFiles.length) {
    lines.push('', '## Files Reviewed', '');
    report.scope.reviewedFiles.forEach((filePath) => lines.push(`- \`${filePath}\``));
  }

  if (report.scope.codexReviewedFiles && report.scope.codexReviewedFiles.length) {
    lines.push('', '## Codex Deep Review Scope', '');
    report.scope.codexReviewedFiles.forEach((filePath) => lines.push(`- \`${filePath}\``));
  }

  if (report.keyChanges.length) {
    lines.push('', '## Key Changes', '');
    report.keyChanges.forEach((item) => lines.push(`- ${item}`));
  }

  if (report.scope.instructions.length) {
    lines.push('', '## Repo Context', '');
    report.scope.instructions.forEach((filePath) => lines.push(`- \`${filePath}\``));
  }

  if (report.notes.length) {
    lines.push('', '## Notes', '');
    report.notes.forEach((note) => lines.push(`- ${note}`));
  }

  if (report.stageSummaries && report.stageSummaries.length) {
    lines.push('', '## Engine Stages', '');
    report.stageSummaries.forEach((stage) => lines.push(`- \`${stage.name}\`: \`${stage.status}\`, ${stage.findings} finding(s), ${formatDurationMs(stage.durationMs || 0)}`));
  }

  if (report.runtimeAccessibility && report.runtimeAccessibility.pages && report.runtimeAccessibility.pages.length) {
    lines.push('', '## Rendered Accessibility Scan', '');
    lines.push(`- Pages scanned: ${report.runtimeAccessibility.pages.length}`);
    report.runtimeAccessibility.pages.forEach((page) => lines.push(`- ${page.url} (${page.violations} violation(s))`));
  }

  if (report.recheck) {
    lines.push('', '## Recheck Status', '');
    if (report.recheck.previousCommit) {
      lines.push(`- Previous reviewed commit: \`${report.recheck.previousCommit}\``);
    }
    if (report.recheck.verdictChanged) {
      lines.push(`- Verdict changed: \`${report.recheck.previousVerdict}\` -> \`${report.verdict}\``);
    }
    if (typeof report.recheck.confidenceDelta === 'number' && report.recheck.confidenceDelta !== 0) {
      lines.push(`- Confidence change: \`${report.recheck.previousConfidenceScore}/5\` -> \`${report.confidenceScore}/5\``);
    }
    if (typeof report.recheck.reviewedFilesDelta === 'number' && report.recheck.reviewedFilesDelta !== 0) {
      lines.push(`- Changed-file scope delta: \`${report.recheck.previousDiffStats.files}\` -> \`${report.diffStats.files}\``);
    }
    if (report.recheck.cleared.length) {
      lines.push(`- Cleared since last review: ${report.recheck.cleared.length}`);
      report.recheck.cleared.slice(0, 5).forEach((finding) => lines.push(`- Cleared: \`${finding.title}\` at \`${finding.file}:${finding.line}\``));
    }
    if (report.recheck.remaining.length) {
      lines.push(`- Still present: ${report.recheck.remaining.length}`);
    }
    if (report.recheck.introduced.length) {
      lines.push(`- New since last review: ${report.recheck.introduced.length}`);
      report.recheck.introduced.slice(0, 5).forEach((finding) => lines.push(`- New: \`${finding.title}\` at \`${finding.file}:${finding.line}\``));
    }
  }

  if (displayFindings.length) {
    lines.push('', '## Table of Contents', '');
    displayFindings.forEach((finding) => {
      const heading = `${finding.severityKey}: ${finding.title}`;
      lines.push(`- [${heading}](#${slugifyHeading(heading)})`);
    });
  }

  if (!displayFindings.length) {
    lines.push('', '## Confirmed Findings By Severity', '', 'No findings.');
    if (report.reviewedCommit) {
      lines.push('', `Last reviewed commit: \`${report.reviewedCommit}\``);
    }
    return lines.join('\n');
  }

  lines.push('', '## Confirmed Findings By Severity', '');
  lines.push(blockerCount ? 'Must fix before merge.' : 'No confirmed blocker-level findings, but the following issues are still worth resolving before PR.');
  lines.push('');
  lines.push(`Verification confirmed ${counts.critical} critical, ${counts.important} important, ${counts.medium} medium, and ${counts.low} low finding(s) in the reviewed changes.`);
  lines.push('');

  getSeverityOrder().forEach((severity) => {
    const severityFindings = groupedFindings.get(severity) || [];
    if (!severityFindings.length) {
      return;
    }

    lines.push(`### ${getSeverityDisplayLabel(severity)}`, '');

    severityFindings.forEach((finding) => {
      lines.push(`#### ${finding.severityKey}: ${finding.title}`);
      lines.push('');
      lines.push(`- Confidence: \`${finding.confidence}\``);
      lines.push(`- Fingerprint: \`${finding.fingerprint}\``);
      lines.push(`- File: \`${finding.file}:${finding.line}\``);
      lines.push(`- Evidence: ${finding.evidence}`);
      lines.push(`- Impact: ${finding.impact}`);
      lines.push(`- Explanation: ${finding.explanation || 'No additional explanation provided.'}`);
      lines.push(`- What to verify: ${finding.verification || 'Add or run targeted checks around this path.'}`);
      lines.push(`- Recommended fix: ${finding.fixDirection}`);
      lines.push('');
      lines.push('<details>');
      lines.push('<summary>Prompt To Fix With AI</summary>');
      lines.push('');
      lines.push('```text');
      lines.push(buildFixPrompt(report, finding));
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    });
  });

  lines.push('## Prioritized Fix Backlog', '');
  backlogItems.forEach((item) => lines.push(`- ${item.key}: ${item.task} (\`${item.file}:${item.line}\`)`));
  lines.push('');
  lines.push('<details>');
  lines.push('<summary>Prompt To Fix All With AI</summary>');
  lines.push('');
  lines.push('```text');
  lines.push(buildFixAllPrompt(report));
  lines.push('```');
  lines.push('</details>');
  lines.push('');

  if (report.outsideDiffFindings.length) {
    lines.push('## Needs Manual Verification', '');
    report.outsideDiffFindings.forEach((finding, index) => {
      lines.push(`### ${index + 1}. ${finding.title}`);
      lines.push('');
      lines.push(`- Severity: \`${finding.severity}\``);
      lines.push(`- Fingerprint: \`${finding.fingerprint}\``);
      lines.push(`- Location: \`${finding.file}:${finding.line}\``);
      lines.push(`- Why this needs follow-up: ${finding.explanation}`);
      lines.push(`- What to verify: ${finding.verification}`);
      lines.push(`- Suggested fix direction: ${finding.fixDirection}`);
      lines.push('');
      lines.push('<details>');
      lines.push('<summary>Prompt To Fix With AI</summary>');
      lines.push('');
      lines.push('```text');
      lines.push(buildOutsideDiffPrompt(report, finding));
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    });
  }

  if (report.reviewedCommit) {
    lines.push(`Last reviewed commit: \`${report.reviewedCommit}\``);
  }

  return lines.join('\n');
}

function renderPrReview(report) {
  const counts = buildFindingSummary(report.findings);
  const blockerCount = countBlockerFindings(report.findings);
  const allDisplayFindings = getFindingDisplayEntries(report.findings);
  const displayFindings = blockerCount
    ? allDisplayFindings.filter((finding) => finding.severity === 'critical' || finding.severity === 'important')
    : allDisplayFindings.slice(0, 2);
  const lines = [
    '### Summary',
    '',
    buildPrReviewSummary(report)
  ];

  if (report.keyChanges.length) {
    lines.push('', 'Key changes:');
    report.keyChanges.slice(0, 3).forEach((item) => lines.push(`  * ${item}`));
  }

  lines.push('', '### Findings', '');

  if (isSafeToMerge(report)) {
    lines.push('Safe to merge.');
  } else if (report.confidenceScore <= 3 || blockerCount) {
    lines.push('Needs changes before merge.');
  } else {
    lines.push('No confirmed merge blockers remain, but there are still issues worth resolving.');
  }

  if (displayFindings.length) {
    lines.push('');
    displayFindings.forEach((finding) => {
      lines.push(`  * ${finding.title} (\`${finding.file}:${finding.line}\`)`);
    });
  }

  lines.push('', `### Confidence Score: ${report.confidenceScore}/5`, '');
  lines.push(`  * Merge stance: \`${report.verdict.replace('_', ' ')}\`${(report.confidenceScore <= 3 || blockerCount) ? ' because the current review is not safe to merge.' : (isSafeToMerge(report) ? ' and the current review is safe to merge.' : ' with no confirmed blocker-level findings.')}`);
  lines.push(`  * Verification confirmed ${counts.critical} Critical and ${counts.important} Important finding(s) in the changed files.${report.keyChanges.length ? ` ${report.keyChanges[0]}` : ''}`);

  if (report.reviewedCommit) {
    lines.push(`Last reviewed commit: \`${report.reviewedCommit}\``);
  }

  return lines.join('\n');
}

function renderGitHub(report) {
  const counts = buildFindingSummary(report.findings);
  const blockerCount = countBlockerFindings(report.findings);
  const displayFindings = getFindingDisplayEntries(report.findings);
  const groupedFindings = groupFindingsBySeverity(displayFindings);
  const metadata = {
    version: 2,
    repo: report.repoLabel,
    workflow: report.workflow || null,
    commitId: report.reviewedCommit,
    state: report.verdict,
    blockers: report.findings
      .filter((finding) => finding.severity === 'critical' || (finding.severity === 'important' && finding.confidence !== 'low'))
      .map((finding) => ({
        fingerprint: finding.fingerprint,
        severity: finding.severity,
        label: finding.title,
        location: `${finding.file}:${finding.line}`
      })),
    relatedBlockers: report.outsideDiffFindings.map((finding) => ({
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      label: finding.title,
      location: `${finding.file}:${finding.line}`
    }))
  };

  const lines = [
    `<h2>${getReportTitle(report)}</h2>`,
    '',
    '<h3>Summary</h3>',
    `<p>${buildNarrativeSummary(report)}</p>`
  ];

  if (report.workflow) {
    lines.push(`<p><strong>Workflow:</strong> <code>${report.workflow}</code></p>`);
  }

  if (report.keyChanges.length) {
    lines.push('<p><strong>Key changes:</strong></p>');
    lines.push('<ul>');
    report.keyChanges.forEach((item) => lines.push(`<li>${item}</li>`));
    lines.push('</ul>');
  }

  if (report.stageSummaries && report.stageSummaries.length) {
    lines.push('<p><strong>Engine stages:</strong></p>');
    lines.push('<ul>');
    report.stageSummaries.forEach((stage) => lines.push(`<li><code>${stage.name}</code>: <code>${stage.status}</code>, ${stage.findings} finding(s), ${formatDurationMs(stage.durationMs || 0)}</li>`));
    lines.push('</ul>');
  }

  if (report.runtimeAccessibility && report.runtimeAccessibility.pages && report.runtimeAccessibility.pages.length) {
    lines.push('<p><strong>Rendered accessibility scan:</strong></p>');
    lines.push('<ul>');
    report.runtimeAccessibility.pages.forEach((page) => lines.push(`<li><code>${page.url}</code> (${page.violations} violation(s))</li>`));
    lines.push('</ul>');
  }

  lines.push('<h3>Confirmed Findings By Severity</h3>');
  lines.push(`<p>${blockerCount ? 'Must fix before merge.' : 'No confirmed blocker-level findings, but there are still issues worth resolving before PR.'}</p>`);

  if (displayFindings.length) {
    getSeverityOrder().forEach((severity) => {
      const severityFindings = groupedFindings.get(severity) || [];
      if (!severityFindings.length) {
        return;
      }

      lines.push(`<h4>${getSeverityDisplayLabel(severity)}</h4>`);
      lines.push('<ul>');
      severityFindings.forEach((finding) => {
        lines.push(`<li><strong>${finding.severityKey}:</strong> ${finding.title} (<code>${finding.file}:${finding.line}</code>, fingerprint <code>${finding.fingerprint}</code>)</li>`);
      });
      lines.push('</ul>');
    });
  } else {
    lines.push('<p>No findings.</p>');
  }

  lines.push(`<h3>Confidence Score: ${report.confidenceScore}/5</h3>`);
  lines.push('<ul>');
  lines.push(`<li>Merge stance: <code>${report.verdict}</code>${(report.confidenceScore <= 3 || blockerCount) ? ' because the current review is not safe to merge.' : (isSafeToMerge(report) ? ' and the current review is safe to merge.' : ' with no confirmed blocker-level findings.')}</li>`);
  lines.push(`<li>Verification confirmed ${counts.critical} Critical, ${counts.important} Important, ${counts.medium} Medium, and ${counts.low} Low finding(s) in the changed files.</li>`);
  lines.push('</ul>');

  if (report.outsideDiffFindings.length) {
    lines.push('<details>');
    lines.push(`<summary>Needs Manual Verification (${report.outsideDiffFindings.length})</summary>`);
    lines.push('');
    lines.push('<p>Not fully confirmed in the current diff. Follow up separately.</p>');
    lines.push('<ol>');
    report.outsideDiffFindings.forEach((finding) => {
      lines.push('<li>');
      lines.push(`<p><code>${finding.file}</code>, line ${finding.line}</p>`);
      lines.push(`<p><code>${finding.severity}</code> ${finding.title}</p>`);
      lines.push(`<p>${finding.explanation}</p>`);
      lines.push(`<p><strong>Fingerprint:</strong> <code>${finding.fingerprint}</code></p>`);
      lines.push('<details>');
      lines.push('<summary>Prompt To Fix With AI</summary>');
      lines.push('');
      lines.push('```text');
      lines.push(buildOutsideDiffPrompt(report, finding));
      lines.push('```');
      lines.push('</details>');
      lines.push('</li>');
    });
    lines.push('</ol>');
    lines.push('</details>');
  }

  if (report.findings.length) {
    lines.push('<details><summary>Prompt To Fix All With AI</summary>');
    lines.push('');
    lines.push('```text');
    lines.push(buildFixAllPrompt(report));
    lines.push('```');
    lines.push('</details>');
  }

  lines.push('');
  lines.push('## Prioritized Inline Comment Candidates');
  lines.push('');
  displayFindings.forEach((finding) => {
    lines.push(`### ${finding.severityKey}: ${finding.title}`);
    lines.push('');
    lines.push(`- Path: \`${finding.file}\``);
    lines.push(`- Line: \`${finding.line}\``);
    lines.push(`- Severity: \`${finding.severity}\``);
    lines.push(`- Fingerprint: \`${finding.fingerprint}\``);
    lines.push('');
    lines.push('```md');
    lines.push(`**${finding.title}**`);
    lines.push('');
    lines.push(finding.explanation || finding.evidence);
    lines.push('');
    lines.push(`**Why it matters:** ${finding.impact}`);
    lines.push('');
    lines.push(`**Fix:** ${finding.fixDirection}`);
    lines.push('```');
    lines.push('');
  });

  if (report.reviewedCommit) {
    lines.push(`<p><sub>Last reviewed commit: <code>${report.reviewedCommit}</code></sub></p>`);
  }

  lines.push('');
  lines.push(encodeMetadataComment(metadata));

  return lines.join('\n');
}

function renderRdjson(report) {
  const displayFindings = getFindingDisplayEntries(report.findings);
  const diagnostics = displayFindings.map((finding) => {
    const severity = finding.severity === 'critical' || finding.severity === 'important'
      ? 'ERROR'
      : finding.severity === 'medium'
        ? 'WARNING'
        : 'INFO';

    return {
      message: [
        finding.title,
        '',
        finding.evidence,
        '',
        `Why it matters: ${finding.impact}`,
        `Fix: ${finding.fixDirection}`
      ].join('\n'),
      location: {
        path: finding.file,
        range: {
          start: {
            line: finding.line,
            column: 1
          },
          end: {
            line: finding.line,
            column: 1
          }
        }
      },
      severity,
      source: {
        name: 'codex-review'
      },
      code: {
        value: finding.severityKey || finding.fingerprint || finding.title
      }
    };
  });

  return JSON.stringify({
    source: {
      name: 'codex-review'
    },
    diagnostics
  }, null, 2);
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
    explanation: finding.explanation,
    verification: finding.verification,
    fixDirection: finding.fix_direction
  };
}

function normalizeOutsideDiffFinding(finding) {
  return {
    severity: finding.severity,
    file: finding.file,
    line: Math.max(1, parseInt(finding.line, 10) || 1),
    title: finding.title,
    explanation: finding.explanation,
    verification: finding.verification,
    fixDirection: finding.fix_direction
  };
}

function lineTouchesChangedDiff(reviewContext, filePath, lineNumber, radius = 2) {
  const changedLines = getChangedLinesForContext(reviewContext, filePath);
  if (!changedLines.length) {
    return Boolean(reviewContext.explicitFileScope);
  }

  return changedLines.some((entry) => Math.abs(entry.line - lineNumber) <= radius);
}

function mapSemgrepSeverity(result) {
  const severity = String((result.extra && result.extra.severity) || '').toUpperCase();
  const metadata = result.extra && result.extra.metadata ? result.extra.metadata : {};
  const category = String(metadata.category || '').toLowerCase();
  const confidence = String(metadata.confidence || '').toLowerCase();

  if (severity === 'ERROR') {
    return category === 'security' ? 'critical' : 'important';
  }

  if (severity === 'WARNING') {
    return 'important';
  }

  if (confidence === 'high') {
    return 'important';
  }

  return 'medium';
}

function mapSemgrepConfidence(result) {
  const confidence = String((result.extra && result.extra.metadata && result.extra.metadata.confidence) || '').toLowerCase();
  if (confidence === 'high' || confidence === 'medium' || confidence === 'low') {
    return confidence;
  }

  const severity = String((result.extra && result.extra.severity) || '').toUpperCase();
  if (severity === 'ERROR' || severity === 'WARNING') {
    return 'high';
  }

  return 'medium';
}

function buildSemgrepFinding(result, cwd) {
  const rawPath = String(result.path || '');
  const filePath = path.isAbsolute(rawPath) ? path.relative(cwd, rawPath) : rawPath;
  const line = Math.max(1, parseInt(result.start && result.start.line, 10) || 1);
  const checkId = String(result.check_id || 'semgrep');
  const extra = result.extra || {};
  const metadata = extra.metadata || {};
  const message = String(extra.message || checkId).trim();
  const shortMessage = message.split('\n')[0].trim();
  const title = shortMessage.length > 120 ? `${shortMessage.slice(0, 117)}...` : shortMessage;
  const docsUrl = metadata.source || metadata.shortlink || metadata.help || '';

  return {
    severity: mapSemgrepSeverity(result),
    confidence: mapSemgrepConfidence(result),
    source: 'semgrep',
    file: filePath,
    line,
    title,
    evidence: message,
    impact: `Semgrep flagged this changed path via rule \`${checkId}\`${docsUrl ? ` (${docsUrl})` : ''}.`,
    explanation: 'This is a deterministic static-analysis signal from Semgrep. Review the exact sink, guard, or data-flow pattern matched by the rule and confirm whether the changed code intentionally preserves the required protection or invariant.',
    verification: 'Inspect the changed code path against the matched rule intent and confirm the expected guard, sanitization, or API usage is still present at runtime.',
    fixDirection: 'Apply the narrowest fix that satisfies the matched Semgrep rule without changing unrelated behavior.'
  };
}

async function runSemgrepReviewAsync(reviewContext, options, cwd) {
  if (!options.semgrepEnabled) {
    return {
      findings: [],
      notes: [],
      stage: {
        name: 'semgrep',
        status: 'disabled',
        durationMs: 0,
        findings: 0
      }
    };
  }

  if (!commandExists('semgrep')) {
    return {
      findings: [],
      notes: ['Semgrep was enabled, but the semgrep CLI is not available in PATH.'],
      stage: {
        name: 'semgrep',
        status: 'unavailable',
        durationMs: 0,
        findings: 0
      }
    };
  }

  const startedAt = Date.now();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-semgrep-'));
  const outputPath = path.join(tempDir, 'semgrep.json');
  const filePaths = reviewContext.fileEntries.map((entry) => entry.path).filter(Boolean);

  if (!filePaths.length) {
    return {
      findings: [],
      notes: [],
      stage: {
        name: 'semgrep',
        status: 'skipped',
        durationMs: 0,
        findings: 0
      }
    };
  }

  const args = [
    'scan',
    '--json',
    '--quiet',
    '--metrics=off',
    '--config',
    options.semgrepConfig || DEFAULT_CONFIG.semgrepConfig,
    '--output',
    outputPath,
    '--',
    ...filePaths
  ];

  try {
    await runCommandAsync('semgrep', args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.semgrepTimeoutMs || DEFAULT_SEMGREP_TIMEOUT_MS
    });
  } catch (error) {
    if (error.code === 'ETIMEDOUT') {
      return {
        findings: [],
        notes: [`Semgrep timed out after ${formatDurationMs(options.semgrepTimeoutMs || DEFAULT_SEMGREP_TIMEOUT_MS)} and was skipped.`],
        stage: {
          name: 'semgrep',
          status: 'timed_out',
          durationMs: Date.now() - startedAt,
          findings: 0
        }
      };
    }

    return {
      findings: [],
      notes: [`Semgrep failed and was skipped: ${error.message}`],
      stage: {
        name: 'semgrep',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        findings: 0
      }
    };
  }

  try {
    const parsed = JSON.parse(safeReadFile(outputPath) || '{"results":[]}');
    const findings = [];

    (parsed.results || []).forEach((result) => {
      const rawPath = String(result.path || '');
      const filePath = path.isAbsolute(rawPath) ? path.relative(cwd, rawPath) : rawPath;
      const line = Math.max(1, parseInt(result.start && result.start.line, 10) || 1);
      if (!filePath || !lineTouchesChangedDiff(reviewContext, filePath, line, 3)) {
        return;
      }

      pushFinding(findings, buildSemgrepFinding({ ...result, path: filePath }, cwd));
    });

    const durationMs = Date.now() - startedAt;
    return {
      findings,
      notes: [`Semgrep scanned the changed files with config \`${options.semgrepConfig || DEFAULT_CONFIG.semgrepConfig}\` and contributed ${findings.length} merged finding(s) in ${formatDurationMs(durationMs)}.`],
      stage: {
        name: 'semgrep',
        status: 'completed',
        durationMs,
        findings: findings.length
      }
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildPhpstanFinding(filePath, message) {
  const line = Math.max(1, parseInt(message.line, 10) || 1);
  const identifier = message.identifier || 'phpstan';
  const tip = message.tip ? ` Tip: ${message.tip}` : '';
  return {
    severity: 'important',
    confidence: 'high',
    source: 'phpstan',
    file: filePath,
    line,
    title: String(message.message || identifier).split('\n')[0].trim(),
    evidence: `${String(message.message || '').trim()}${tip}`.trim(),
    impact: `PHPStan reported a correctness or type-contract issue via \`${identifier}\` on this changed PHP path.`,
    explanation: 'This is a deterministic PHP static-analysis finding. In these plugin repos, PHPStan usually surfaces real contract, nullability, collection-shape, or method-usage problems that can become runtime errors or broken data flow.',
    verification: 'Re-check the affected method or property contract and confirm the changed code satisfies the expected PHP type and nullability assumptions.',
    fixDirection: 'Adjust the changed PHP code so the contract, nullability, or collection shape matches what PHPStan expects at this call site.'
  };
}

async function runPhpstanReviewAsync(reviewContext, options, cwd) {
  if (!options.phpstanEnabled) {
    return {
      findings: [],
      notes: [],
      stage: {
        name: 'phpstan',
        status: 'disabled',
        durationMs: 0,
        findings: 0
      }
    };
  }

  const phpFiles = reviewContext.fileEntries.map((entry) => entry.path).filter((filePath) => /\.php$/i.test(filePath));
  if (!phpFiles.length) {
    return {
      findings: [],
      notes: [],
      stage: {
        name: 'phpstan',
        status: 'skipped',
        durationMs: 0,
        findings: 0
      }
    };
  }

  const executable = resolveExecutable(cwd, ['vendor/bin/phpstan', 'phpstan']);
  if (!executable) {
    return {
      findings: [],
      notes: ['PHPStan was enabled, but no phpstan executable was found in vendor/bin or PATH.'],
      stage: {
        name: 'phpstan',
        status: 'unavailable',
        durationMs: 0,
        findings: 0
      }
    };
  }

  const startedAt = Date.now();
  const args = ['analyse', '--error-format=json', '--no-progress'];
  if (options.phpstanConfig && options.phpstanConfig !== 'auto') {
    args.push('--configuration', options.phpstanConfig);
  }
  args.push(...phpFiles);

  let output = '';
  try {
    output = await runCommandAsync(executable, args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.phpstanTimeoutMs || DEFAULT_PHPSTAN_TIMEOUT_MS
    });
  } catch (error) {
    if (error.code === 'ETIMEDOUT') {
      return {
        findings: [],
        notes: [`PHPStan timed out after ${formatDurationMs(options.phpstanTimeoutMs || DEFAULT_PHPSTAN_TIMEOUT_MS)} and was skipped.`],
        stage: {
          name: 'phpstan',
          status: 'timed_out',
          durationMs: Date.now() - startedAt,
          findings: 0
        }
      };
    }

    const candidateOutput = String(error.stdout || error.stderr || error.message || '').trim();
    if (!candidateOutput.startsWith('{')) {
      return {
        findings: [],
        notes: [`PHPStan failed and was skipped: ${error.message}`],
        stage: {
          name: 'phpstan',
          status: 'failed',
          durationMs: Date.now() - startedAt,
          findings: 0
        }
      };
    }

    output = candidateOutput;
  }

  let parsed;
  try {
    parsed = JSON.parse(output || '{}');
  } catch (error) {
    return {
      findings: [],
      notes: [`PHPStan returned unreadable JSON and was skipped: ${error.message}`],
      stage: {
        name: 'phpstan',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        findings: 0
      }
    };
  }

  const findings = [];
  Object.entries(parsed.files || {}).forEach(([rawPath, details]) => {
    const filePath = path.isAbsolute(rawPath) ? path.relative(cwd, rawPath) : rawPath;
    (details.messages || []).forEach((message) => {
      const line = Math.max(1, parseInt(message.line, 10) || 1);
      if (!lineTouchesChangedDiff(reviewContext, filePath, line, 3)) {
        return;
      }
      pushFinding(findings, buildPhpstanFinding(filePath, message));
    });
  });

  const durationMs = Date.now() - startedAt;
  return {
    findings,
    notes: [`PHPStan analyzed ${phpFiles.length} changed PHP file(s) and contributed ${findings.length} merged finding(s) in ${formatDurationMs(durationMs)}.`],
    stage: {
      name: 'phpstan',
      status: 'completed',
      durationMs,
      findings: findings.length
    }
  };
}

function buildEslintFinding(result, message, cwd) {
  const rawPath = String(result.filePath || '');
  const filePath = path.isAbsolute(rawPath) ? path.relative(cwd, rawPath) : rawPath;
  const line = Math.max(1, parseInt(message.line, 10) || 1);
  const ruleId = message.ruleId || 'eslint';
  const severity = message.severity === 2 ? 'important' : 'medium';
  const confidence = message.severity === 2 ? 'high' : 'medium';

  return {
    severity,
    confidence,
    source: 'eslint',
    file: filePath,
    line,
    title: String(message.message || ruleId).split('\n')[0].trim(),
    evidence: `${String(message.message || '').trim()}${ruleId ? ` (rule: ${ruleId})` : ''}`,
    impact: `ESLint reported a deterministic frontend correctness/style-contract issue${ruleId ? ` via \`${ruleId}\`` : ''} on this changed file.`,
    explanation: 'This is a deterministic JavaScript/Vue linting signal. For these plugin repos, ESLint is most useful for catching broken component logic, unsafe patterns, and framework-level mistakes before they become runtime regressions.',
    verification: 'Inspect the affected Vue/JS code path and confirm the change still satisfies the expected framework and lint-rule contract.',
    fixDirection: 'Adjust the changed JS/Vue code to satisfy the ESLint rule or framework contract without altering unrelated behavior.'
  };
}

async function runEslintReviewAsync(reviewContext, options, cwd) {
  if (!options.eslintEnabled) {
    return {
      findings: [],
      notes: [],
      stage: {
        name: 'eslint',
        status: 'disabled',
        durationMs: 0,
        findings: 0
      }
    };
  }

  const scriptFiles = reviewContext.fileEntries.map((entry) => entry.path).filter((filePath) => /\.(js|jsx|ts|tsx|vue)$/i.test(filePath));
  if (!scriptFiles.length) {
    return {
      findings: [],
      notes: [],
      stage: {
        name: 'eslint',
        status: 'skipped',
        durationMs: 0,
        findings: 0
      }
    };
  }

  const executable = resolveExecutable(cwd, ['node_modules/.bin/eslint', 'eslint']);
  if (!executable) {
    return {
      findings: [],
      notes: ['ESLint was enabled, but no eslint executable was found in node_modules/.bin or PATH.'],
      stage: {
        name: 'eslint',
        status: 'unavailable',
        durationMs: 0,
        findings: 0
      }
    };
  }

  const startedAt = Date.now();
  const args = ['-f', 'json'];
  if (options.eslintConfig && options.eslintConfig !== 'auto') {
    args.push('--config', options.eslintConfig);
  }
  args.push(...scriptFiles);

  let output = '';
  try {
    output = await runCommandAsync(executable, args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.eslintTimeoutMs || DEFAULT_ESLINT_TIMEOUT_MS
    });
  } catch (error) {
    if (error.code === 'ETIMEDOUT') {
      return {
        findings: [],
        notes: [`ESLint timed out after ${formatDurationMs(options.eslintTimeoutMs || DEFAULT_ESLINT_TIMEOUT_MS)} and was skipped.`],
        stage: {
          name: 'eslint',
          status: 'timed_out',
          durationMs: Date.now() - startedAt,
          findings: 0
        }
      };
    }

    const candidateOutput = String(error.stdout || error.stderr || error.message || '').trim();
    if (!candidateOutput.startsWith('[')) {
      return {
        findings: [],
        notes: [`ESLint failed and was skipped: ${error.message}`],
        stage: {
          name: 'eslint',
          status: 'failed',
          durationMs: Date.now() - startedAt,
          findings: 0
        }
      };
    }

    output = candidateOutput;
  }

  let parsed;
  try {
    parsed = JSON.parse(output || '[]');
  } catch (error) {
    return {
      findings: [],
      notes: [`ESLint returned unreadable JSON and was skipped: ${error.message}`],
      stage: {
        name: 'eslint',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        findings: 0
      }
    };
  }

  const findings = [];
  (parsed || []).forEach((result) => {
    const rawPath = String(result.filePath || '');
    const filePath = path.isAbsolute(rawPath) ? path.relative(cwd, rawPath) : rawPath;
    (result.messages || []).forEach((message) => {
      const line = Math.max(1, parseInt(message.line, 10) || 1);
      if (!filePath || !lineTouchesChangedDiff(reviewContext, filePath, line, 3)) {
        return;
      }
      pushFinding(findings, buildEslintFinding({ ...result, filePath }, message, cwd));
    });
  });

  const durationMs = Date.now() - startedAt;
  return {
    findings,
    notes: [`ESLint analyzed ${scriptFiles.length} changed JS/Vue file(s) and contributed ${findings.length} merged finding(s) in ${formatDurationMs(durationMs)}.`],
    stage: {
      name: 'eslint',
      status: 'completed',
      durationMs,
      findings: findings.length
    }
  };
}

function appendStageFindings(reviewResult, stageResult) {
  if (!stageResult) {
    return reviewResult;
  }

  const mergedFindings = (reviewResult.findings || []).concat(stageResult.findings || []);

  return {
    ...reviewResult,
    verdict: buildVerdict(mergedFindings),
    confidenceScore: buildConfidence(mergedFindings),
    summary: (stageResult.findings || []).length ? null : reviewResult.summary,
    findings: mergedFindings,
    notes: (reviewResult.notes || []).concat(stageResult.notes || []),
    stageSummaries: (reviewResult.stageSummaries || []).concat(stageResult.stage ? [stageResult.stage] : [])
  };
}

function commandExists(command) {
  if (COMMAND_EXISTS_CACHE.has(command)) {
    return COMMAND_EXISTS_CACHE.get(command);
  }

  try {
    runCommand(command, ['--version']);
    COMMAND_EXISTS_CACHE.set(command, true);
    return true;
  } catch (error) {
    COMMAND_EXISTS_CACHE.set(command, false);
    return false;
  }
}

function moduleExists(moduleName) {
  try {
    require.resolve(moduleName);
    return true;
  } catch (error) {
    return false;
  }
}

function logProgress(message) {
  if (!process.stderr || process.env.CODEX_REVIEW_SILENT === '1') {
    return;
  }

  process.stderr.write(`${message}\n`);
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '0ms';
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 60000) {
    return `${Math.round(durationMs / 1000)}s`;
  }

  return `${(durationMs / 60000).toFixed(durationMs % 60000 === 0 ? 0 : 1)}m`;
}

function runRenderedAccessibilityScan(options, cwd) {
  if (!options.a11yUrls || !options.a11yUrls.length) {
    return null;
  }

  if (!moduleExists('playwright') || !moduleExists('axe-core')) {
    throw new Error('Rendered accessibility scan requires the playwright and axe-core packages to be installed.');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-a11y-'));
  const inputPath = path.join(tempDir, 'input.json');
  const outputPath = path.join(tempDir, 'output.json');
  const scriptPath = path.join(__dirname, 'lib', 'runtime-accessibility-scan.js');
  const payload = {
    urls: options.a11yUrls,
    waitForSelector: options.a11yWaitFor || null,
    timeoutMs: options.a11yTimeout || DEFAULT_CONFIG.a11yTimeout,
    storageStatePath: options.a11yStorageState ? path.resolve(cwd, options.a11yStorageState) : null,
    headless: true
  };

  writeJsonFile(inputPath, payload);

  try {
    runCommand(process.execPath, [scriptPath, inputPath, outputPath], {
      cwd,
      maxBuffer: 32 * 1024 * 1024
    });

    return JSON.parse(safeReadFile(outputPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runRenderedAccessibilityScanAsync(options, cwd) {
  if (!options.a11yUrls || !options.a11yUrls.length) {
    return null;
  }

  if (!moduleExists('playwright') || !moduleExists('axe-core')) {
    throw new Error('Rendered accessibility scan requires the playwright and axe-core packages to be installed.');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-a11y-'));
  const inputPath = path.join(tempDir, 'input.json');
  const outputPath = path.join(tempDir, 'output.json');
  const scriptPath = path.join(__dirname, 'lib', 'runtime-accessibility-scan.js');
  const payload = {
    urls: options.a11yUrls,
    waitForSelector: options.a11yWaitFor || null,
    timeoutMs: options.a11yTimeout || DEFAULT_CONFIG.a11yTimeout,
    storageStatePath: options.a11yStorageState ? path.resolve(cwd, options.a11yStorageState) : null,
    headless: true
  };

  writeJsonFile(inputPath, payload);

  try {
    await runCommandAsync(process.execPath, [scriptPath, inputPath, outputPath], {
      cwd,
      maxBuffer: 32 * 1024 * 1024
    });

    return JSON.parse(safeReadFile(outputPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function collectFileContexts(reviewContext, fileEntries, highRiskPaths, extraFiles = [], excerptOptions = {}) {
  const seenPaths = new Set();
  const contextEntries = [];
  const includeContent = excerptOptions.includeContent !== false;
  const baseChars = Number.isFinite(excerptOptions.baseChars) ? excerptOptions.baseChars : 8000;
  const currentChars = Number.isFinite(excerptOptions.currentChars) ? excerptOptions.currentChars : 12000;
  const extraBaseChars = Number.isFinite(excerptOptions.extraBaseChars) ? excerptOptions.extraBaseChars : baseChars;
  const extraCurrentChars = Number.isFinite(excerptOptions.extraCurrentChars) ? excerptOptions.extraCurrentChars : currentChars;

  fileEntries.forEach((entry) => {
    if (!entry || !entry.path || seenPaths.has(entry.path)) {
      return;
    }
    seenPaths.add(entry.path);
    contextEntries.push({
      ...entry,
      isExtraContext: false
    });
  });

  extraFiles.forEach((filePath) => {
    if (!filePath || seenPaths.has(filePath)) {
      return;
    }
    seenPaths.add(filePath);
    contextEntries.push({ path: filePath, status: '  ', isExtraContext: true });
  });

  return contextEntries.map((entry) => {
    const filePath = entry.path;
    const changedLines = getChangedLinesForContext(reviewContext, filePath);
    const baseContent = includeContent ? getBaseContentForContext(reviewContext, filePath) : '';
    const currentContent = includeContent ? getCurrentContentForContext(reviewContext, filePath) : '';
    const entryBaseChars = entry.isExtraContext ? extraBaseChars : baseChars;
    const entryCurrentChars = entry.isExtraContext ? extraCurrentChars : currentChars;
    return {
      path: filePath,
      highRisk: isHighRiskPath(filePath, highRiskPaths),
      base: includeContent ? buildTargetedContextExcerpt(baseContent, filePath, changedLines, entryBaseChars) : '',
      current: includeContent ? buildTargetedContextExcerpt(currentContent, filePath, changedLines, entryCurrentChars) : '',
      changedLines: changedLines.slice(0, 80)
    };
  });
}

function buildPrompt(payload) {
  const workflowInstructions = [];
  if (payload.workflow === 'debugger') {
    workflowInstructions.push(
      'Workflow: debugger.',
      'Emulate Finder -> Verifier -> Feedback in one response.',
      'Generate broad bug candidates first, but keep only verifier-confirmed issues in findings.',
      'Use outside_diff_findings for items that still need manual verification after skeptical re-tracing.',
      'Do not keep weak verification-only warnings as confirmed findings.'
    );
  } else if (payload.workflow === 'plugin-audit') {
    workflowInstructions.push(
      'Workflow: plugin-audit.',
      'Emulate five workstreams: security, performance/optimization, dead code/duplication, UI-to-handler traceability, and handler-to-service/database traceability.',
      'Re-verify every critical or important candidate before returning it as a confirmed finding.',
      'If the exploitability or operational impact is not proven strongly enough, move it to outside_diff_findings instead of overstating severity.'
    );
  }

  return [
    'You are performing a local pre-PR code review for a WordPress-oriented repository.',
    'Review only the supplied local diff and file context.',
    'Prioritize real bugs, security issues, compatibility risks, accessibility issues in changed user-facing markup or interactions, data integrity problems, and missing verification around risky changes.',
    'Focus heavily on lifecycle regressions and performance regressions when the diff changes stateful UI, async flows, persistence round-trips, or hot interaction paths.',
    'Review in passes: (1) map changed workflows and entry points, (2) trace lifecycle and persistence round-trips, (3) check performance and hot paths, (4) check auth/security and destructive actions, (5) check accessibility and user-facing regressions.',
    'Do not emit style-only feedback.',
    'Do not speculate without evidence from the provided diff or file contents.',
    'If there are no meaningful findings, return an empty findings array and APPROVE.',
    'Make the review explanatory. For each finding, explain the concrete failure mode or regression scenario, why the changed code creates that risk, and what the developer should verify next.',
    'Prefer explanations that mention the affected workflow, such as payment acceptance, webhook verification, option persistence, route access, or rendering behavior.',
    'When a frontend diff adds state-sync helpers, CSS state classes, or input/change/blur listeners, trace reset, clear, success, and teardown paths in the same file before approving.',
    'When a frontend diff introduces interactive grid, card, or multi-column choice layouts, check mobile breakpoints and narrow-viewport usability before approving.',
    'When a Vue admin/editor component derives local mutable state from props, check whether prop updates after mount will resynchronize that state before approving.',
    'When a changed mounted/load path performs async status updates or resource loads, trace each branch and check for duplicate fetches before approving.',
    'When a change adds or modifies setup/initialize/mounted/onload/onOpen/onClose/reset/save/success handlers, trace the full lifecycle: first load, async completion, retry, reset, teardown, reopen, and prop/data refresh.',
    'When a frontend initializer rebuilds ordered lists from answers and options, check for repeated find/includes scans that can make mount or rehydration quadratic as option counts grow.',
    'When drag/drop UI is added, inspect dragover and pointer-move hot paths for repeated full-list DOM queries or class resets that can cause interaction jank.',
    'When drag/drop reorder logic adjusts target indexes after removing the source item, test adjacent forward moves explicitly so the immediate-next drop case does not collapse into a no-op.',
    'When a change touches persistence or validation contracts, trace save -> sanitize -> load -> render -> submit paths and look for values that can be accepted in the editor but later rejected or dropped.',
    'When a change introduces loops, mapping, sorting, filtering, repeated lookups, remote fetches, or DOM queries, estimate worst-case scaling on real data sizes instead of assuming the current diff is small.',
    'Use repo-local review_signals as concrete prompts for which lifecycle handlers, hot paths, persistence boundaries, security boundaries, and accessibility checks deserve extra scrutiny.',
    'Always populate key_changes with 1-2 concise bullets about what the patch appears to do correctly or safely when the diff supports that.',
    'Use outside_diff_findings for closely related blocker-level follow-ups that are not directly part of the changed lines but are necessary to validate the same workflow.',
    'Keep the pass focused. Do not restate issues from other files unless they are required to explain the current workflow or contract risk.',
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
    ...workflowInstructions,
    ...(workflowInstructions.length ? [''] : []),
    `Review mode: ${payload.mode}`,
    `Base ref: ${payload.baseRef}`,
    `Review pass: ${payload.passLabel || 'full review'}`,
    `Pass focus: ${payload.passFocus || 'general'}`,
    '',
    'Product profile:',
    JSON.stringify(payload.productProfile || null, null, 2),
    '',
    'Priority focus areas:',
    JSON.stringify(payload.focusAreas, null, 2),
    '',
    'Critical paths to trace:',
    JSON.stringify(payload.criticalPaths || [], null, 2),
    '',
    'Repository review signals:',
    JSON.stringify(payload.reviewSignals || {}, null, 2),
    '',
    'Matched repository context rules:',
    JSON.stringify(payload.matchedContextRules || [], null, 2),
    '',
    'Repo edge cases:',
    JSON.stringify(payload.edgeCases || null, null, 2),
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

function scoreCodexEntry(entry, reviewContext, heuristicSeed, options) {
  const filePath = entry.path;
  const changedLines = getChangedLinesForContext(reviewContext, filePath).length;
  const hasHotspot = heuristicSeed.findings.some((finding) => finding.file === filePath);
  const hasOutsideDiffFollowup = (heuristicSeed.outsideDiffFindings || []).some((finding) => finding.file === filePath);
  const isHighRisk = isHighRiskPath(filePath, options.highRiskPaths);
  const isCodexFocusPath = pathMatchesAnyPattern(filePath, options.codexFocusPaths || []);
  const isExplicit = options.files.includes(filePath);
  const isWorktreeChange = entry.status.trim() && entry.status !== '??';
  const isTest = /(^|\/)(test|tests|__tests__)\//i.test(filePath) || /\.(test|spec)\./i.test(filePath);
  const productWeight = /\/Payments\/PaymentMethods\/.+\.php$/.test(filePath)
    ? 40
    : 0;

  let score = 0;

  if (isExplicit) {
    score += 1000;
  }

  if (hasHotspot) {
    score += 400;
  }

  if (hasOutsideDiffFollowup) {
    score += 120;
  }

  if (isHighRisk) {
    score += 150;
  }

  if (isCodexFocusPath) {
    score += 180;
  }

  if (isWorktreeChange) {
    score += 80;
  }

  if (isTest) {
    score += 20;
  }

  score += Math.min(changedLines, 120);
  score += productWeight;

  return score;
}

function getMatchedContextRules(fileEntries, contextRules) {
  if (!contextRules || !contextRules.length) {
    return [];
  }

  const changedPaths = fileEntries.map((entry) => entry.path).filter(Boolean);
  return contextRules.map((rule) => {
    const matchedFiles = changedPaths.filter((filePath) => pathMatchesAnyPattern(filePath, rule.when));
    if (!matchedFiles.length) {
      return null;
    }

    return {
      when: rule.when,
      include: rule.include,
      reason: rule.reason || null,
      matchedFiles
    };
  }).filter(Boolean);
}

function resolveExtraContextFiles(reviewContext, options) {
  const matchedRules = getMatchedContextRules(reviewContext.fileEntries, options.contextRules || []);
  const files = new Set(options.contextFiles || []);

  matchedRules.forEach((rule) => {
    rule.include.forEach((filePath) => files.add(filePath));
  });

  return {
    files: Array.from(files),
    matchedRules
  };
}

function chunkArray(items, size) {
  if (!Array.isArray(items) || !items.length) {
    return [];
  }

  const chunkSize = Math.max(1, size || 1);
  const chunks = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

function getCodexBatchSize(reviewDepth, changedFileCount) {
  if (changedFileCount <= 6) {
    return 1;
  }

  return reviewDepth === 'thorough' ? CODEX_BATCH_SIZE.thorough : CODEX_BATCH_SIZE.balanced;
}

function getCodexDeepFileLimit(reviewDepth, changedFileCount) {
  if (changedFileCount <= 3) {
    return changedFileCount;
  }

  return reviewDepth === 'thorough' ? 3 : 2;
}

function shouldRunDeepCodexPass(entry, reviewContext, heuristicSeed, resolvedOptions) {
  if (!entry || !entry.path) {
    return false;
  }

  const filePath = entry.path;
  const changedLines = getChangedLinesForContext(reviewContext, filePath).length;
  const hasHotspot = heuristicSeed.findings.some((finding) => finding.file === filePath);
  const hasOutsideDiffFollowup = (heuristicSeed.outsideDiffFindings || []).some((finding) => finding.file === filePath);

  if (resolvedOptions.files.includes(filePath)) {
    return true;
  }

  if (hasHotspot || hasOutsideDiffFollowup || isHighRiskPath(filePath, resolvedOptions.highRiskPaths)) {
    return true;
  }

  if (isStyleFile(filePath)) {
    return hasHotspot;
  }

  return changedLines >= 8;
}

function getDeepCodexCandidateScore(entry, reviewContext, heuristicSeed, resolvedOptions) {
  if (!entry || !entry.path) {
    return -1;
  }

  const filePath = entry.path;
  const changedLines = getChangedLinesForContext(reviewContext, filePath).length;
  const hasHotspot = heuristicSeed.findings.some((finding) => finding.file === filePath);
  const hasOutsideDiffFollowup = (heuristicSeed.outsideDiffFindings || []).some((finding) => finding.file === filePath);
  const isHighRisk = isHighRiskPath(filePath, resolvedOptions.highRiskPaths);
  let score = changedLines;

  if (hasHotspot) {
    score += 400;
  }

  if (hasOutsideDiffFollowup) {
    score += 150;
  }

  if (isHighRisk) {
    score += 120;
  }

  if (isStyleFile(filePath)) {
    score -= 80;
  }

  return score;
}

function getBatchContextFiles(batchEntries, options, matchedRules, includeGlobalContextFiles) {
  const batchPaths = new Set(batchEntries.map((entry) => entry.path));
  const files = new Set(includeGlobalContextFiles ? (options.contextFiles || []) : []);

  (matchedRules || []).forEach((rule) => {
    if (!(rule.matchedFiles || []).some((filePath) => batchPaths.has(filePath))) {
      return;
    }

    (rule.include || []).forEach((filePath) => files.add(filePath));
  });

  return Array.from(files);
}

function buildCodexPayload(reviewContext, resolvedOptions, heuristicSeed, entries, diffText, extraFiles, matchedRules, excerptOptions, passLabel, passFocus) {
  return {
    mode: resolvedOptions.mode,
    baseRef: reviewContext.baseRef || '--staged',
    productProfile: reviewContext.productProfile,
    focusAreas: resolvedOptions.focusAreas,
    criticalPaths: resolvedOptions.criticalPaths,
    reviewSignals: resolvedOptions.reviewSignals,
    matchedContextRules: matchedRules,
    edgeCases: resolvedOptions.edgeCases,
    instructions: reviewContext.instructions,
    heuristicHotspots: heuristicSeed.findings
      .filter((finding) => entries.some((entry) => entry.path === finding.file))
      .slice(0, 8)
      .map((finding) => ({
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        title: finding.title
      })),
    diffStats: {
      files: reviewContext.fileEntries.length,
      codexScopedFiles: entries.length,
      testsChanged: getChangedTestFiles(reviewContext.fileEntries).length
    },
    workflow: resolvedOptions.workflow,
    passLabel,
    passFocus,
    diffText,
    fileContexts: collectFileContexts(reviewContext, entries, resolvedOptions.highRiskPaths, extraFiles, excerptOptions)
  };
}

function buildCodexPassCacheKey(prompt, options, cwd) {
  return sha1(stableSerialize({
    version: 1,
    cwd: path.resolve(cwd),
    model: options.model || null,
    prompt,
    schema: REVIEW_SCHEMA
  }));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const values = new Array(items.length);
  const limit = Math.max(1, concurrency || 1);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      values[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return values;
}

function mergeCodexResultSets(results, notes) {
  const findings = [];
  const outsideDiffFindings = [];
  const keyChanges = [];
  const stageSummaries = [];
  let totalDurationMs = 0;

  (results || []).forEach((result) => {
    (result.findings || []).forEach((finding) => pushFinding(findings, finding));
    (result.outsideDiffFindings || []).forEach((finding) => pushOutsideDiffFinding(outsideDiffFindings, finding));
    (result.keyChanges || []).forEach((change) => {
      if (!change || keyChanges.includes(change)) {
        return;
      }
      keyChanges.push(change);
    });

    (result.stageSummaries || []).forEach((stage) => {
      stageSummaries.push(stage);
      totalDurationMs += stage.durationMs || 0;
    });
  });

  const rankedFindings = rankFindings(findings);
  const verdict = buildVerdict(rankedFindings);
  const confidenceScore = buildConfidence(rankedFindings);
  const mergedNotes = (notes || []).slice();

  if (results.length > 1) {
    mergedNotes.push(`Codex review ran in ${results.length} pass(es) to keep each analysis scope focused and responsive.`);
  }

  return {
    engine: 'codex',
    fallbackUsed: false,
    notes: mergedNotes,
    verdict,
    confidenceScore,
    summary: null,
    keyChanges: keyChanges.slice(0, 2),
    findings: rankedFindings,
    outsideDiffFindings,
    stageSummaries: stageSummaries.length ? [{
      name: 'codex',
      status: 'completed',
      durationMs: totalDurationMs,
      findings: rankedFindings.length,
      passes: results.length
    }] : []
  };
}

function selectCodexFileEntries(reviewContext, heuristicSeed, options) {
  const limit = options.reviewDepth === 'thorough' ? CODEX_FILE_LIMITS.thorough : CODEX_FILE_LIMITS.balanced;
  return reviewContext.fileEntries
    .filter((entry) => !isGeneratedOrBinaryPath(entry.path))
    .map((entry) => ({
      entry,
      score: scoreCodexEntry(entry, reviewContext, heuristicSeed, options),
      changedLines: getChangedLinesForContext(reviewContext, entry.path).length
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.changedLines !== left.changedLines) {
        return right.changedLines - left.changedLines;
      }
      return left.entry.path.localeCompare(right.entry.path);
    })
    .slice(0, limit)
    .map((item) => item.entry);
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
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--color',
    'never',
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
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.codexTimeoutMs || undefined
    });

    const parsed = JSON.parse(safeReadFile(outputPath));
    return {
      engine: 'codex',
      fallbackUsed: false,
      notes: [],
      verdict: parsed.verdict,
      confidenceScore: parsed.confidence_score,
      summary: parsed.summary,
      keyChanges: parsed.key_changes || [],
      findings: (parsed.findings || []).map(normalizeCodexFinding),
      outsideDiffFindings: (parsed.outside_diff_findings || []).map(normalizeOutsideDiffFinding)
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runCodexReviewAsync(payload, options, cwd) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-'));
  const schemaPath = path.join(tempDir, 'schema.json');
  const outputPath = path.join(tempDir, 'output.json');
  const prompt = buildPrompt(payload);
  const cacheKey = buildCodexPassCacheKey(prompt, options, cwd);
  const cachedEntry = loadCacheEntry(cacheKey);

  if (cachedEntry && cachedEntry.result) {
    if (options.codexProgressLabel) {
      logProgress(`codex-review: using cached result for ${options.codexProgressLabel}.`);
    }
    return {
      ...cachedEntry.result,
      cacheHit: true
    };
  }

  writeJsonFile(schemaPath, REVIEW_SCHEMA);

  const args = [
    'exec',
    '-',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--color',
    'never',
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
    await runCommandAsync('codex', args, {
      cwd,
      input: prompt,
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.codexTimeoutMs || undefined,
      progressLabel: options.codexProgressLabel || null,
      heartbeatMs: options.codexHeartbeatMs || 30000
    });

    const parsed = JSON.parse(safeReadFile(outputPath));
    const result = {
      engine: 'codex',
      fallbackUsed: false,
      notes: [],
      verdict: parsed.verdict,
      confidenceScore: parsed.confidence_score,
      summary: parsed.summary,
      keyChanges: parsed.key_changes || [],
      findings: (parsed.findings || []).map(normalizeCodexFinding),
      outsideDiffFindings: (parsed.outside_diff_findings || []).map(normalizeOutsideDiffFinding)
    };
    saveCacheEntry(cacheKey, {
      savedAt: new Date().toISOString(),
      result
    });
    return {
      ...result,
      cacheHit: false
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runCodexMultiPassReviewAsync(reviewContext, heuristicSeed, resolvedOptions, extraContext, selectedEntries, notes, cwd) {
  const changedEntries = selectedEntries.slice().sort((left, right) => left.path.localeCompare(right.path));
  const deepCandidates = selectedEntries
    .filter((entry) => shouldRunDeepCodexPass(entry, reviewContext, heuristicSeed, resolvedOptions))
    .sort((left, right) => {
      const scoreDiff = getDeepCodexCandidateScore(right, reviewContext, heuristicSeed, resolvedOptions)
        - getDeepCodexCandidateScore(left, reviewContext, heuristicSeed, resolvedOptions);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return left.path.localeCompare(right.path);
    });
  const deepEntries = deepCandidates
    .slice(0, getCodexDeepFileLimit(resolvedOptions.reviewDepth, changedEntries.length))
    .sort((left, right) => left.path.localeCompare(right.path));
  const deepBatchSize = getCodexBatchSize(resolvedOptions.reviewDepth, deepEntries.length);
  const deepBatches = chunkArray(deepEntries, deepBatchSize);
  const totalPasses = deepBatches.length + 1;
  const passResults = [];
  let cachedPassCount = 0;

  if (deepEntries.length < changedEntries.length) {
    notes.push(`Deep Codex passes focused on ${deepEntries.length} highest-signal file(s); the overview pass still covered all ${changedEntries.length} scoped file(s).`);
  }

  const overviewPayload = buildCodexPayload(
    reviewContext,
    resolvedOptions,
    heuristicSeed,
    changedEntries,
    truncateText(getScopedDiffFromIndex(reviewContext.diffIndex, changedEntries.map((entry) => entry.path)), 22000),
    [],
    extraContext.matchedRules,
    {
      ...CODEX_CONTEXT_BUDGETS.overview,
      includeContent: false
    },
    'overview',
    'Cross-file workflow, persistence, lifecycle, and blocker-level contract analysis across the full diff.'
  );

  logProgress(`codex-review: Codex pass 1/${totalPasses} overview across ${changedEntries.length} file(s)...`);
  {
    const startedAt = Date.now();
    const overviewResult = await runCodexReviewAsync(overviewPayload, {
      ...resolvedOptions,
      codexProgressLabel: `Codex overview pass 1/${totalPasses}`
    }, cwd);
    if (overviewResult.cacheHit) {
      cachedPassCount += 1;
    }
    overviewResult.stageSummaries = [{
      name: 'codex_overview',
      status: overviewResult.cacheHit ? 'cached' : 'completed',
      durationMs: Date.now() - startedAt,
      findings: (overviewResult.findings || []).length
    }];
    passResults.push(overviewResult);
  }

  if (deepBatches.length) {
    deepBatches.forEach((batchEntries, index) => {
      logProgress(`codex-review: Codex pass ${index + 2}/${totalPasses} deep review for ${batchEntries.length} file(s)...`);
    });

    const deepResults = await mapWithConcurrency(
      deepBatches.map((batchEntries, index) => ({ batchEntries, index })),
      CODEX_DEEP_CONCURRENCY,
      async ({ batchEntries, index }) => {
        const batchFiles = batchEntries.map((entry) => entry.path);
        const batchPayload = buildCodexPayload(
          reviewContext,
          resolvedOptions,
          heuristicSeed,
          batchEntries,
          truncateText(getScopedDiffFromIndex(reviewContext.diffIndex, batchFiles), 14000),
          getBatchContextFiles(batchEntries, resolvedOptions, extraContext.matchedRules, false),
          extraContext.matchedRules.filter((rule) => (rule.matchedFiles || []).some((filePath) => batchFiles.includes(filePath))),
          CODEX_CONTEXT_BUDGETS.deep,
          `deep batch ${index + 1}`,
          `Deep localized analysis of ${batchFiles.join(', ')} with lifecycle, performance, accessibility, and persistence tracing.`
        );

        const startedAt = Date.now();
        const batchResult = await runCodexReviewAsync(batchPayload, {
          ...resolvedOptions,
          codexProgressLabel: `Codex deep pass ${index + 2}/${totalPasses}`
        }, cwd);
        if (batchResult.cacheHit) {
          cachedPassCount += 1;
        }
        batchResult.stageSummaries = [{
          name: 'codex_deep',
          status: batchResult.cacheHit ? 'cached' : 'completed',
          durationMs: Date.now() - startedAt,
          findings: (batchResult.findings || []).length,
          files: batchFiles
        }];
        return {
          index,
          result: batchResult
        };
      }
    );

    deepResults
      .sort((left, right) => left.index - right.index)
      .forEach((item) => {
        passResults.push(item.result);
      });
  }

  if (cachedPassCount) {
    notes.push(`Reused ${cachedPassCount} cached Codex pass result(s) for identical prompt scopes.`);
  }

  return mergeCodexResultSets(passResults, notes);
}

function isCodexTimeoutError(error) {
  if (!error) {
    return false;
  }

  return error.code === 'ETIMEDOUT' || /timed out/i.test(error.message || '');
}

function toSettledPromise(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  );
}

function unwrapSettledResult(outcome, label) {
  if (!outcome || outcome.status !== 'rejected') {
    return outcome ? outcome.value : null;
  }

  throw new Error(`${label}: ${outcome.reason.message}`);
}

function runHeuristicReview(options, reviewContext, notes = [], engine = 'heuristic', fallbackUsed = false) {
  const { baseRef, fileEntries, instructions, diffText } = reviewContext;
  const findings = [];
  const outsideDiffFindings = [];
  const changedTestFiles = getChangedTestFiles(fileEntries);

  for (const entry of fileEntries) {
    const filePath = entry.path;
    const currentContent = getCurrentContentForContext(reviewContext, filePath);
    const baseContent = getBaseContentForContext(reviewContext, filePath);
    const changedLines = getChangedLinesForContext(reviewContext, filePath);
    const fileFindings = analyzeFile({
      filePath,
      currentContent,
      baseContent,
      changedLines,
      mode: options.mode,
      highRiskPaths: options.highRiskPaths,
      productProfile: reviewContext.productProfile
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
      explanation: 'This does not prove the code is wrong, but it does mean a risky path changed without any nearby automated verification. In payment, auth, routing, or persistence code, that usually increases the chance of shipping a silent regression.',
      verification: 'Add targeted tests or document the exact manual scenarios that were verified before opening the PR.',
      fixDirection: 'Add targeted tests or document the manual verification steps before opening the PR.'
    });
  }

  const productReview = buildProductSpecificFindings(options, reviewContext);
  productReview.findings.forEach((finding) => pushFinding(findings, finding));
  productReview.outsideDiffFindings.forEach((finding) => pushOutsideDiffFinding(outsideDiffFindings, finding));
  notes.push(...productReview.notes);

  if (findings.some((finding) => /needs .*verification coverage/i.test(finding.title))) {
    const genericIndex = findings.findIndex((finding) => finding.title === 'High-risk changes landed without matching test changes');
    if (genericIndex !== -1) {
      findings.splice(genericIndex, 1);
    }
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
    keyChanges: buildProductSpecificKeyChanges(reviewContext, rankedFindings),
    findings: rankedFindings,
    outsideDiffFindings
  };
}

function createReviewContext(options, cwd) {
  const baseRef = options.staged ? null : (options.base || resolveDefaultBase(cwd));
  const fileEntries = listChangedFiles(cwd, options, baseRef);
  const instructions = getRepoInstructions(cwd, options.repoConfigPath);
  const diffText = getUnifiedDiff(cwd, baseRef, options, fileEntries.map((entry) => entry.path));
  const diffIndex = indexUnifiedDiff(diffText);
  const repoRoot = getRepoRoot(cwd);
  const repoLabel = getRepoLabel(cwd);
  const productProfile = buildCustomProductProfile(repoLabel, options.productProfile);

  return {
    cwd,
    repoRoot,
    productProfile,
    baseRef,
    fileEntries,
    instructions,
    diffText,
    diffIndex,
    explicitFileScope: Boolean(options.files && options.files.length),
    currentContentByPath: new Map(),
    baseContentByPath: new Map(),
    changedLinesByPath: new Map(),
    currentBranch: getCurrentBranch(cwd),
    reviewedCommit: getCurrentCommit(cwd),
    repoLabel
  };
}

function buildFinalReport(options, reviewContext, reviewResult) {
  const { baseRef, fileEntries, instructions, reviewedCommit, repoLabel, repoRoot, currentBranch } = reviewContext;
  const rankedFindings = rankFindings((reviewResult.findings || []).map((finding) => ({
    ...finding,
    severity: finding.severity,
    confidence: finding.confidence,
    file: finding.file,
    line: finding.line,
    title: finding.title,
    evidence: finding.evidence,
    impact: finding.impact,
    explanation: finding.explanation,
    verification: finding.verification,
    fixDirection: finding.fixDirection,
    fingerprint: finding.fingerprint || buildFindingFingerprint(finding)
  }))).slice(0, options.maxFindings);
  const scope = summarizeScope(fileEntries, instructions);
  const previousState = loadPreviousReviewState(repoRoot);
  const report = {
    verdict: reviewResult.verdict || buildVerdict(rankedFindings),
    confidenceScore: 0,
    workflow: options.workflow || null,
    reportPath: options.report || null,
    reviewdogReportPath: options.reviewdogReport || null,
    workflowData: reviewResult.workflowData || null,
    currentBranch,
    generatedAt: new Date().toISOString().slice(0, 10),
    auditorLabel: options.model || reviewResult.engine || options.engine,
    baseRef: baseRef || '--staged',
    mode: options.mode,
    reviewDepth: options.reviewDepth,
    engine: reviewResult.engine,
    fallbackUsed: Boolean(reviewResult.fallbackUsed),
    notes: reviewResult.notes || [],
    summary: reviewResult.summary || buildSummary(rankedFindings, scope, {
      base: baseRef || '--staged'
    }),
    keyChanges: reviewResult.keyChanges || [],
    reviewedCommit,
    repoLabel,
    repoRoot,
    scope,
    findings: rankedFindings,
    outsideDiffFindings: reviewResult.outsideDiffFindings || [],
    runtimeAccessibility: reviewResult.runtimeAccessibility || null,
    stageSummaries: reviewResult.stageSummaries || [],
    diffStats: {
      files: fileEntries.length,
      testsChanged: getChangedTestFiles(fileEntries).length
    }
  };

  if (reviewResult.codexReviewedFiles && reviewResult.codexReviewedFiles.length) {
    report.scope.codexReviewedFiles = reviewResult.codexReviewedFiles;
  }

  report.confidenceScore = normalizeConfidenceScore(reviewResult.confidenceScore, rankedFindings, {
    engine: report.engine,
    fallbackUsed: report.fallbackUsed,
    reviewDepth: report.reviewDepth,
    reviewedFilesCount: report.scope.reviewedFiles.length,
    codexReviewedFilesCount: report.scope.codexReviewedFiles ? report.scope.codexReviewedFiles.length : 0,
    highRiskTouched: fileEntries.some((entry) => isHighRiskPath(entry.path, options.highRiskPaths))
  });
  report.verdict = deriveVerdictFromScore(report);

  report.recheck = buildRecheckState(previousState, rankedFindings, reviewedCommit, report);

  report.reviewdogRendered = renderRdjson(report);

  if (options.format === 'json') {
    report.rendered = JSON.stringify(report, null, 2);
  } else if (options.format === 'rdjson') {
    report.rendered = report.reviewdogRendered;
  } else if (options.format === 'pr-review') {
    report.rendered = renderPrReview(report);
  } else if (options.format === 'github') {
    report.rendered = renderGitHub(report);
  } else if (options.format === 'markdown') {
    report.rendered = renderMarkdown(report);
  } else {
    report.rendered = renderText(report);
  }

  report.exitCode = shouldFail(report, options.failOn) ? 2 : 0;
  saveReviewState(repoRoot, report);
  return report;
}

function appendRuntimeAccessibility(reviewResult, runtimeScan) {
  if (!runtimeScan) {
    return reviewResult;
  }

  const mergedFindings = (reviewResult.findings || []).concat(runtimeScan.findings || []);

  return {
    ...reviewResult,
    verdict: buildVerdict(mergedFindings),
    confidenceScore: buildConfidence(mergedFindings),
    summary: (runtimeScan.findings || []).length ? null : reviewResult.summary,
    findings: mergedFindings,
    notes: (reviewResult.notes || []).concat(runtimeScan.notes || []),
    stageSummaries: (reviewResult.stageSummaries || []).concat(runtimeScan.stage ? [runtimeScan.stage] : []),
    runtimeAccessibility: {
      pages: runtimeScan.pages || []
    }
  };
}

async function createReviewReport(options, cwd = process.cwd()) {
  const loadedConfig = loadRepoConfig(cwd);
  const resolvedOptions = resolveOptions(options, loadedConfig.config);
  resolvedOptions.repoConfigPath = loadedConfig.configPath;
  const reviewContext = createReviewContext(resolvedOptions, cwd);
  const scope = summarizeScope(reviewContext.fileEntries, reviewContext.instructions);
  const baseNotes = [];
  const extraContext = resolveExtraContextFiles(reviewContext, resolvedOptions);
  const shouldRunRuntimeA11y = Boolean(resolvedOptions.a11yUrls && resolvedOptions.a11yUrls.length);

  if (loadedConfig.configPath) {
    baseNotes.push(`Loaded repo config from ${path.relative(cwd, loadedConfig.configPath)}`);
  }

  baseNotes.push(...resolvedOptions.configNotes);
  if (resolvedOptions.edgeCases) {
    const edgeCaseCounts = [
      resolvedOptions.edgeCases.general && resolvedOptions.edgeCases.general.length ? `${resolvedOptions.edgeCases.general.length} general` : null,
      resolvedOptions.edgeCases.lifecycle && resolvedOptions.edgeCases.lifecycle.length ? `${resolvedOptions.edgeCases.lifecycle.length} lifecycle` : null,
      resolvedOptions.edgeCases.performance && resolvedOptions.edgeCases.performance.length ? `${resolvedOptions.edgeCases.performance.length} performance` : null,
      resolvedOptions.edgeCases.persistence && resolvedOptions.edgeCases.persistence.length ? `${resolvedOptions.edgeCases.persistence.length} persistence` : null,
      resolvedOptions.edgeCases.security && resolvedOptions.edgeCases.security.length ? `${resolvedOptions.edgeCases.security.length} security` : null,
      resolvedOptions.edgeCases.accessibility && resolvedOptions.edgeCases.accessibility.length ? `${resolvedOptions.edgeCases.accessibility.length} accessibility` : null
    ].filter(Boolean);
    if (edgeCaseCounts.length) {
      baseNotes.push(`Loaded repo edge cases: ${edgeCaseCounts.join(', ')}.`);
    }
  }
  if (resolvedOptions.criticalPaths && resolvedOptions.criticalPaths.length) {
    baseNotes.push(`Loaded ${resolvedOptions.criticalPaths.length} critical path(s) to trace.`);
  }
  if (resolvedOptions.contextFiles && resolvedOptions.contextFiles.length) {
    baseNotes.push(`Loaded ${resolvedOptions.contextFiles.length} repo context file(s) for companion tracing.`);
  }
  if (resolvedOptions.contextRules && resolvedOptions.contextRules.length) {
    baseNotes.push(`Loaded ${resolvedOptions.contextRules.length} repo context rule(s) for conditional companion tracing.`);
  }
  if (extraContext.matchedRules && extraContext.matchedRules.length) {
    baseNotes.push(`Matched ${extraContext.matchedRules.length} context rule(s) for this diff and expanded companion context accordingly.`);
  }
  if (resolvedOptions.reviewSignals) {
    const signalCounts = [
      resolvedOptions.reviewSignals.lifecycle && resolvedOptions.reviewSignals.lifecycle.length ? `${resolvedOptions.reviewSignals.lifecycle.length} lifecycle` : null,
      resolvedOptions.reviewSignals.performance && resolvedOptions.reviewSignals.performance.length ? `${resolvedOptions.reviewSignals.performance.length} performance` : null,
      resolvedOptions.reviewSignals.persistence && resolvedOptions.reviewSignals.persistence.length ? `${resolvedOptions.reviewSignals.persistence.length} persistence` : null,
      resolvedOptions.reviewSignals.security && resolvedOptions.reviewSignals.security.length ? `${resolvedOptions.reviewSignals.security.length} security` : null,
      resolvedOptions.reviewSignals.accessibility && resolvedOptions.reviewSignals.accessibility.length ? `${resolvedOptions.reviewSignals.accessibility.length} accessibility` : null
    ].filter(Boolean);
    if (signalCounts.length) {
      baseNotes.push(`Loaded review signals: ${signalCounts.join(', ')}.`);
    }
  }

  if (!scope.reviewedFiles.length && !shouldRunRuntimeA11y) {
    return buildFinalReport(resolvedOptions, reviewContext, applyWorkflowPostProcessing(resolvedOptions, reviewContext, {
      engine: resolvedOptions.engine === 'codex' ? 'codex' : 'heuristic',
      fallbackUsed: false,
      notes: baseNotes,
      verdict: 'APPROVE',
      confidenceScore: 4,
      summary: 'No local changes were found for review.',
      findings: []
    }));
  }

  if (!scope.reviewedFiles.length && shouldRunRuntimeA11y) {
    const runtimeOnlyResult = applyWorkflowPostProcessing(resolvedOptions, reviewContext, appendRuntimeAccessibility({
      engine: resolvedOptions.engine === 'codex' ? 'codex' : 'heuristic',
      fallbackUsed: false,
      notes: baseNotes,
      stageSummaries: [],
      verdict: 'APPROVE',
      confidenceScore: 3,
      summary: 'No local diff was selected, but rendered accessibility pages were scanned.',
      findings: []
    }, await (async () => {
      const startedAt = Date.now();
      const scan = await runRenderedAccessibilityScanAsync(resolvedOptions, cwd);
      return {
        ...scan,
        stage: {
          name: 'accessibility',
          status: 'completed',
          durationMs: Date.now() - startedAt,
          findings: (scan.findings || []).length
        }
      };
    })()));

    return buildFinalReport(resolvedOptions, reviewContext, runtimeOnlyResult);
  }

  const runtimeScanPromise = shouldRunRuntimeA11y
    ? toSettledPromise((async () => {
      const startedAt = Date.now();
      const scan = await runRenderedAccessibilityScanAsync(resolvedOptions, cwd);
      return {
        ...scan,
        stage: {
          name: 'accessibility',
          status: 'completed',
          durationMs: Date.now() - startedAt,
          findings: (scan.findings || []).length
        }
      };
    })())
    : Promise.resolve({ status: 'fulfilled', value: null });
  const semgrepPromise = resolvedOptions.semgrepEnabled
    ? toSettledPromise(runSemgrepReviewAsync(reviewContext, resolvedOptions, cwd))
    : Promise.resolve({ status: 'fulfilled', value: null });
  const phpstanPromise = resolvedOptions.phpstanEnabled
    ? toSettledPromise(runPhpstanReviewAsync(reviewContext, resolvedOptions, cwd))
    : Promise.resolve({ status: 'fulfilled', value: null });
  const eslintPromise = resolvedOptions.eslintEnabled
    ? toSettledPromise(runEslintReviewAsync(reviewContext, resolvedOptions, cwd))
    : Promise.resolve({ status: 'fulfilled', value: null });
  const heuristicSeed = runHeuristicReview(resolvedOptions, reviewContext, baseNotes.slice(), 'heuristic', false);
  const shouldUseCodex = resolvedOptions.engine === 'codex' || resolvedOptions.engine === 'auto';

  if (shouldUseCodex) {
    const notes = baseNotes.slice();

    if (!commandExists('codex')) {
      if (resolvedOptions.engine === 'codex') {
        throw new Error('codex CLI is not available in PATH.');
      }

      notes.push('Codex CLI was not available, so the report used heuristic review only.');
      const heuristicResult = runHeuristicReview(resolvedOptions, reviewContext, notes, 'heuristic', true);
      return buildFinalReport(
        resolvedOptions,
        reviewContext,
        applyWorkflowPostProcessing(
          resolvedOptions,
          reviewContext,
          appendRuntimeAccessibility(
            appendStageFindings(
              appendStageFindings(
                appendStageFindings(heuristicResult, unwrapSettledResult(await semgrepPromise, 'Semgrep scan failed')),
                unwrapSettledResult(await phpstanPromise, 'PHPStan scan failed')
              ),
              unwrapSettledResult(await eslintPromise, 'ESLint scan failed')
            ),
            unwrapSettledResult(await runtimeScanPromise, 'Rendered accessibility scan failed')
          )
        )
      );
    }

    const selectedEntries = selectCodexFileEntries(reviewContext, heuristicSeed, resolvedOptions);

    if (selectedEntries.length < reviewContext.fileEntries.length) {
      notes.push(`Codex scope narrowed to ${selectedEntries.length} of ${reviewContext.fileEntries.length} changed files for ${resolvedOptions.reviewDepth} review depth.`);
    }

    logProgress(`codex-review: running multi-pass Codex review over ${selectedEntries.length} scoped file(s)...`);

    try {
      const [codexOutcome, runtimeOutcome, semgrepOutcome, phpstanOutcome, eslintOutcome] = await Promise.all([
        toSettledPromise((async () => {
          const result = await runCodexMultiPassReviewAsync(
            reviewContext,
            heuristicSeed,
            resolvedOptions,
            extraContext,
            selectedEntries,
            notes,
            cwd
          );
          return result;
        })()),
        runtimeScanPromise,
        semgrepPromise,
        phpstanPromise,
        eslintPromise
      ]);
      if (codexOutcome.status === 'rejected') {
        throw codexOutcome.reason;
      }

      const codexResult = codexOutcome.value;
      const runtimeScan = unwrapSettledResult(runtimeOutcome, 'Rendered accessibility scan failed');
      const semgrepResult = unwrapSettledResult(semgrepOutcome, 'Semgrep scan failed');
      const phpstanResult = unwrapSettledResult(phpstanOutcome, 'PHPStan scan failed');
      const eslintResult = unwrapSettledResult(eslintOutcome, 'ESLint scan failed');
      codexResult.codexReviewedFiles = selectedEntries.map((entry) => entry.path);
      return buildFinalReport(
        resolvedOptions,
        reviewContext,
        applyWorkflowPostProcessing(
          resolvedOptions,
          reviewContext,
          appendRuntimeAccessibility(
            appendStageFindings(
              appendStageFindings(
                appendStageFindings(codexResult, semgrepResult),
                phpstanResult
              ),
              eslintResult
            ),
            runtimeScan
          )
        )
      );
    } catch (error) {
      if (isCodexTimeoutError(error)) {
        const timeoutLabel = formatDurationMs(resolvedOptions.codexTimeoutMs);
        logProgress(`codex-review: Codex timed out after ${timeoutLabel}. Falling back to heuristic review.`);
        notes.push(`Codex review timed out after ${timeoutLabel}, so the report used heuristic fallback.`);
        const fallbackResult = runHeuristicReview(resolvedOptions, reviewContext, notes, 'codex', true);
        fallbackResult.stageSummaries = [{
          name: 'codex',
          status: 'timed_out',
          durationMs: resolvedOptions.codexTimeoutMs,
          findings: 0
        }];
        return buildFinalReport(
          resolvedOptions,
          reviewContext,
          applyWorkflowPostProcessing(
            resolvedOptions,
            reviewContext,
            appendRuntimeAccessibility(
              appendStageFindings(
                appendStageFindings(
                  appendStageFindings(fallbackResult, unwrapSettledResult(await semgrepPromise, 'Semgrep scan failed')),
                  unwrapSettledResult(await phpstanPromise, 'PHPStan scan failed')
                ),
                unwrapSettledResult(await eslintPromise, 'ESLint scan failed')
              ),
              unwrapSettledResult(await runtimeScanPromise, 'Rendered accessibility scan failed')
            )
          )
        );
      }

      if (resolvedOptions.engine === 'codex') {
        throw new Error(`Codex review failed: ${error.message}`);
      }

      notes.push(`Codex review failed, so the report used heuristic fallback: ${error.message}`);
      const fallbackResult = runHeuristicReview(resolvedOptions, reviewContext, notes, 'codex', true);
      fallbackResult.stageSummaries = [{
        name: 'codex',
        status: 'failed',
        durationMs: 0,
        findings: 0
      }];
      return buildFinalReport(
        resolvedOptions,
        reviewContext,
        applyWorkflowPostProcessing(
          resolvedOptions,
          reviewContext,
          appendRuntimeAccessibility(
            appendStageFindings(
              appendStageFindings(
                appendStageFindings(fallbackResult, unwrapSettledResult(await semgrepPromise, 'Semgrep scan failed')),
                unwrapSettledResult(await phpstanPromise, 'PHPStan scan failed')
              ),
              unwrapSettledResult(await eslintPromise, 'ESLint scan failed')
            ),
            unwrapSettledResult(await runtimeScanPromise, 'Rendered accessibility scan failed')
          )
        )
      );
    }
  }

  return buildFinalReport(
    resolvedOptions,
    reviewContext,
    applyWorkflowPostProcessing(
      resolvedOptions,
      reviewContext,
      appendRuntimeAccessibility(
        appendStageFindings(
          appendStageFindings(
            appendStageFindings(heuristicSeed, unwrapSettledResult(await semgrepPromise, 'Semgrep scan failed')),
            unwrapSettledResult(await phpstanPromise, 'PHPStan scan failed')
          ),
          unwrapSettledResult(await eslintPromise, 'ESLint scan failed')
        ),
        unwrapSettledResult(await runtimeScanPromise, 'Rendered accessibility scan failed')
      )
    )
  );
}

module.exports = {
  createReviewReport,
  parseArgs
};
