'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const DEFAULT_MAX_FINDINGS = 15;
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
  base: null,
  reviewDepth: 'balanced',
  productProfile: null,
  focusAreas: [],
  ignorePaths: [],
  highRiskPaths: [],
  notes: []
};
const CODEX_FILE_LIMITS = {
  balanced: 12,
  thorough: 24
};
const PRODUCT_PROFILES = {
  fluentform: {
    name: 'Fluent Forms',
    focus: [
      'form setting round-trips through sanitizers and JS payload producers',
      'route policy and capability enforcement on REST/admin mutations',
      'public uploader and crop flow integration between PHP settings and frontend JS'
    ],
    regressionChecks: [
      'new field settings must survive save-time sanitizers in app/Services/Form/Updater.php and app/Modules/Form/Form.php',
      'frontend upload/crop flows must have a matching PHP producer or settings export path',
      'uploader or crop UI changes must preserve runtime asset/bootstrap wiring'
    ]
  },
  fluentformpro: {
    name: 'Fluent Forms Pro',
    focus: [
      'payment acceptance, transaction totals, and subscription/payment workflow regressions',
      'Pro uploader bootstrap and shared image/crop settings between input_image and featured_image',
      'asset registration for bundled frontend libraries under public/'
    ],
    regressionChecks: [
      'payment processor changes need evidence for both happy-path and mismatch-path payload shapes',
      'crop/upload enhancements must wire both settings export and packaged asset bundles',
      'changes in shared upload components should be checked against featured_image and other Pro-only renderers'
    ]
  },
  'fluent-conversational-js': {
    name: 'Fluent Conversational JS',
    focus: [
      'Vue 3 conversational question flows and question-type runtime behavior',
      'crop modal lifecycle, async image handling, and cleanup race conditions',
      'frontend-only regressions with no PHP safety net'
    ],
    regressionChecks: [
      'image.onload and cropper creation must be guarded against late cleanup',
      'question-type UI changes must preserve submit gating and cleanup behavior',
      'state transitions must still work on slow devices and large uploads'
    ]
  },
  'fluentforms-pdf': {
    name: 'Fluent Forms PDF',
    focus: [
      'PDF template rendering, entry-to-document mapping, and output formatting stability',
      'attachment/download generation paths and file naming/storage behavior',
      'invoice/report template data completeness and formatting regressions'
    ],
    regressionChecks: [
      'new template fields must be available in the template data map before rendering',
      'PDF generation changes should preserve attachment/download and filename behavior',
      'invoice/report formatting changes must be checked against totals, currencies, and empty-field handling'
    ]
  },
  'multilingual-forms-fluent-forms-wpml': {
    name: 'Fluent Forms WPML',
    focus: [
      'translation package registration, field mapping, and string synchronization',
      'language-specific form metadata and translated submission/render behavior',
      'WPML hook wiring without losing original-form fallback behavior'
    ],
    regressionChecks: [
      'new translatable fields must be added to WPML package/string extraction paths',
      'translation sync changes must preserve fallback to source-language data when translations are absent',
      'form meta/key mapping changes must still keep translated and source forms aligned'
    ]
  },
  'fluentform-signature': {
    name: 'Fluent Forms Signature',
    focus: [
      'signature capture lifecycle, PNG/data URL generation, and persistence shape',
      'frontend pad initialization and clear/redraw behavior',
      'saved signature attachment or field-value compatibility with core Fluent Forms flows'
    ],
    regressionChecks: [
      'signature field changes must preserve the stored payload format expected by submission/render flows',
      'canvas/data URL handling must still work after clear, redraw, and empty-signature validation cases',
      'frontend signature assets and field renderer hooks must stay aligned'
    ]
  },
  'fluent-player': {
    name: 'Fluent Player',
    focus: [
      'player initialization, shortcode/block attribute mapping, and frontend playback behavior',
      'video source, subtitle, and chapter/metadata configuration round-trips',
      'public asset bootstrap and browser-side player controls/state changes'
    ],
    regressionChecks: [
      'new player settings must survive save/load and reach frontend initialization payloads',
      'source/subtitle/chapter changes must keep player config and rendered UI in sync',
      'asset/bootstrap changes must still initialize the player for shortcode and block paths'
    ]
  },
  'fluent-player-pro': {
    name: 'Fluent Player Pro',
    focus: [
      'Pro player feature wiring such as analytics, DRM/protected media, and premium UI overlays',
      'free/pro shared player bootstrapping and config compatibility',
      'paid or restricted playback flows where config mismatches break real users silently'
    ],
    regressionChecks: [
      'Pro-only settings must extend, not break, the shared frontend player config contract',
      'analytics/protection changes must preserve playback start, resume, and event reporting behavior',
      'shared player changes should be checked against both free and pro feature entry points'
    ]
  }
};
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

function getProductProfile(repoLabel) {
  const profile = PRODUCT_PROFILES[repoLabel];
  return profile ? { repoLabel, ...profile } : null;
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

  if (!focus.length && !regressionChecks.length) {
    return null;
  }

  return {
    repoLabel,
    name,
    focus,
    regressionChecks
  };
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
    reviewDepth: 'balanced',
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
    }
  }

  return options;
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
      productProfile: typeof parsed.product_profile === 'object' || typeof parsed.productProfile === 'object'
        ? (parsed.product_profile || parsed.productProfile)
        : DEFAULT_CONFIG.productProfile,
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
    base: rawOptions._explicit.base ? rawOptions.base : (repoConfig.base || rawOptions.base),
    mode: rawOptions._explicit.mode ? rawOptions.mode : repoConfig.mode,
    engine: rawOptions._explicit.engine ? rawOptions.engine : repoConfig.engine,
    model: rawOptions._explicit.model ? rawOptions.model : repoConfig.model,
    reviewDepth: rawOptions._explicit.reviewDepth ? rawOptions.reviewDepth : repoConfig.reviewDepth,
    maxFindings: rawOptions._explicit.maxFindings ? rawOptions.maxFindings : repoConfig.maxFindings
  };

  options.productProfile = repoConfig.productProfile;
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

  if (!productProfile) {
    return changes;
  }

  const changedPaths = getChangedPathsSet(fileEntries);

  if (productProfile.repoLabel === 'fluentformpro') {
    if (Array.from(changedPaths).some((filePath) => filePath.includes('/Payments/PaymentMethods/'))) {
      changes.push('Touches a payment gateway processor, so acceptance, mismatch handling, and stored transaction totals were reviewed as a single workflow.');
    }

    if (Array.from(changedPaths).some((filePath) => /Uploader|FeaturedImage|crop/i.test(filePath))) {
      changes.push('Touches shared upload/crop behavior, so asset bootstrap and image-field wiring were treated as cross-component regression risks.');
    }
  }

  if (productProfile.repoLabel === 'fluentform') {
    if (Array.from(changedPaths).some((filePath) => /file-uploader|Uploader|crop/i.test(filePath))) {
      changes.push('Touches the public uploader crop flow, so save-time setting persistence and JS settings production were treated as part of the same feature path.');
    }
  }

  if (productProfile.repoLabel === 'fluent-conversational-js') {
    if (Array.from(changedPaths).some((filePath) => /FileType\.vue$/i.test(filePath))) {
      changes.push('Touches the conversational file-upload question type, so modal teardown and asynchronous image/cropper lifecycle behavior were reviewed together.');
    }
  }

  if (!changes.length && findings.length) {
    changes.push(`This repository matches the ${productProfile.name} profile, so the review emphasized ${productProfile.focus[0]}.`);
  }

  return changes.slice(0, 2);
}

function buildProductSpecificFindings(options, reviewContext) {
  const findings = [];
  const outsideDiffFindings = [];
  const notes = [];
  const { cwd, fileEntries, productProfile } = reviewContext;

  if (!productProfile) {
    return { findings, outsideDiffFindings, notes };
  }

  const changedPaths = getChangedPathsSet(fileEntries);
  const changedPathList = Array.from(changedPaths);
  const hasCropChange = changedPathList.some((filePath) => /crop|file-uploader|Uploader|FeaturedImage/i.test(filePath));
  const hasPaymentProcessorChange = changedPathList.some((filePath) => /\/Payments\/PaymentMethods\/.+\.php$/.test(filePath));

  if (productProfile.repoLabel === 'fluentform') {
    const touchesUploaderSettingsContract = changedPathList.some((filePath) => /file-uploader\.js$|Component\.php$/i.test(filePath));
    const referencesSettingsPayload = repoSearch(cwd, 'file_upload_settings|fluentform/file_upload_settings_for_js', [
      'app/Modules/Component/Component.php',
      'resources/assets/public/Pro/file-uploader.js'
    ]);
    const producerExists = repoSearch(cwd, "add_filter\\s*\\(\\s*['\"]fluentform/file_upload_settings_for_js['\"]");

    if (touchesUploaderSettingsContract && referencesSettingsPayload && !producerExists) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'high',
        file: findChangedEntry(fileEntries, (filePath) => /Component\.php$/i.test(filePath))?.path || 'app/Modules/Component/Component.php',
        line: 1,
        title: 'Uploader settings payload has no producer for runtime crop configuration',
        evidence: 'The changed uploader flow references the file_upload_settings payload, but the repository does not currently expose a matching add_filter() producer for fluentform/file_upload_settings_for_js.',
        impact: 'The frontend crop flow can be wired correctly in JS but still never activate at runtime if the per-field settings payload is never produced on the PHP side.',
        explanation: 'This is the same class of break where a feature appears complete in the diff but the data contract stops one step earlier. In Fluent Forms, upload-field runtime behavior often depends on PHP building a JS payload keyed by field name. If that producer is missing, the frontend waits on settings that never arrive.',
        verification: 'Confirm the repo contains a producer that maps saved upload/crop field settings into file_upload_settings for the uploader runtime path.',
        fixDirection: 'Add or update the PHP settings producer so the uploader receives per-field crop configuration at runtime.'
      });
    }

    const cropSettingKeysTouched = repoSearch(cwd, 'enable_crop|crop_mode|crop_ratio|crop_width|crop_height|enforce_image_dimensions', [
      ...changedPathList
    ]);
    if (hasCropChange && cropSettingKeysTouched && !changedPaths.has('app/Services/Form/Updater.php') && !changedPaths.has('app/Modules/Form/Form.php')) {
      pushOutsideDiffFinding(outsideDiffFindings, {
        severity: 'important',
        file: 'app/Services/Form/Updater.php',
        line: 138,
        title: 'New crop settings may still be stripped during form save',
        explanation: 'Fluent Forms persists field settings through sanitizer/whitelist logic in the form update path. When new crop keys are introduced in UI/runtime code but the save-time whitelist is untouched, forms can appear to support the feature until the next edit/save silently removes those settings.',
        verification: 'Check both app/Services/Form/Updater.php and app/Modules/Form/Form.php to confirm the new crop settings are preserved and sanitized during form save.',
        fixDirection: 'Mirror any new upload/crop setting keys into the save-time field settings whitelist and sanitization logic.'
      });
    }
  }

  if (productProfile.repoLabel === 'fluentformpro') {
    if (hasCropChange && repoSearch(cwd, 'Cropper|cropperjs', changedPathList) && !repoSearch(cwd, 'cropper\\.min\\.(js|css)|fluentform-cropperjs', [
      'fluentformpro.php',
      'public/libs/cropperjs/cropper.min.js',
      'public/libs/cropperjs/cropper.min.css'
    ])) {
      pushFinding(findings, {
        severity: 'important',
        confidence: 'medium',
        file: findChangedEntry(fileEntries, (filePath) => /Uploader|FeaturedImage|crop/i.test(filePath))?.path || 'fluentformpro.php',
        line: 1,
        title: 'Crop UI changes do not show a matching bundled asset/bootstrap path',
        evidence: 'The changed Pro uploader flow references Cropper-based behavior, but the repo does not show the expected packaged cropper asset files or registration handles.',
        impact: 'A working crop flow in component code still fails at runtime if the packaged JS/CSS bundle is missing or never enqueued on the rendered field path.',
        explanation: 'Fluent Forms Pro relies on bundled public assets and explicit registration in fluentformpro.php. If a crop-capable uploader path changes without those packaged assets or handles lining up, the UI can render but never initialize for users.',
        verification: 'Confirm public/libs/cropperjs assets exist in the packaged path and that fluentformpro.php registers/enqueues them for every affected upload renderer.',
        fixDirection: 'Add the packaged cropper assets or update the registration/bootstrap path to the real built asset location.'
      });
    }

    if (hasCropChange && changedPathList.some((filePath) => /UploaderSettings|input_image|crop/i.test(filePath)) && !changedPathList.some((filePath) => /FeaturedImage/i.test(filePath))) {
      pushOutsideDiffFinding(outsideDiffFindings, {
        severity: 'medium',
        file: 'src/Components/Post/Components/FeaturedImage.php',
        line: 1,
        title: 'Shared crop/upload changes may not be wired through featured_image',
        explanation: 'Fluent Forms Pro has multiple image-upload entry points. A crop-flow improvement that only touches input_image-side settings or bootstrapping can leave featured_image on the old path, creating inconsistent runtime behavior between two user-visible image components.',
        verification: 'Check whether featured_image receives the same crop settings export and crop-capable uploader bootstrap as input_image after this change.',
        fixDirection: 'Route featured_image through the same settings export and uploader bootstrap path, or document why it intentionally differs.'
      });
    }

    if (hasPaymentProcessorChange && !getChangedTestFiles(fileEntries).length) {
      const paymentEntry = findChangedEntry(fileEntries, (filePath) => /\/Payments\/PaymentMethods\/.+\.php$/.test(filePath));
      if (paymentEntry) {
        pushFinding(findings, {
          severity: 'important',
          confidence: 'medium',
          file: paymentEntry.path,
          line: 1,
          title: 'Payment processor change needs product-specific verification coverage',
          evidence: 'A Fluent Forms Pro payment gateway file changed, but the diff does not include matching automated verification files or a product-specific test path.',
          impact: 'Gateway processors sit directly on real checkout acceptance paths. Product-specific regressions here tend to show up only after live callbacks, redirect confirmations, or refund/reconciliation flows.',
          explanation: 'For Fluent Forms Pro, generic code review is not enough on payment processors. The same code can pass a local read and still break strict mismatch handling, coupon-adjusted totals, recurring flags, or paid-total recalculation in real gateway payloads.',
          verification: 'Verify the changed processor against the exact gateway payload shapes used by Fluent Forms Pro, including mismatch, redirect/callback, and persisted total behavior.',
          fixDirection: 'Add product-specific payment verification or document the exact gateway scenarios covered before PR.'
        });
      }
    }
  }

  if (productProfile.repoLabel === 'fluent-conversational-js') {
    const fileTypeEntry = findChangedEntry(fileEntries, (filePath) => /FileType\.vue$/i.test(filePath));
    if (fileTypeEntry) {
      const content = getCurrentContent(cwd, fileTypeEntry.path);
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
          explanation: 'This is a product-specific race in the conversational uploader because there is no PHP fallback or second render pass to hide it. If the modal closes first and the image finishes later, the late callback still executes unless it checks the cleanup flag before creating Cropper.',
          verification: 'Close the crop dialog quickly on a large image or slow device and confirm no cropper instance is created after teardown.',
          fixDirection: 'Guard the image.onload callback with the cleanup flag before creating Cropper and return early after teardown.'
        });
      }
    }
  }

  if (productProfile.repoLabel === 'fluentforms-pdf') {
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

  if (productProfile.repoLabel === 'multilingual-forms-fluent-forms-wpml') {
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

  if (productProfile.repoLabel === 'fluentform-signature') {
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

  if (productProfile.repoLabel === 'fluent-player' || productProfile.repoLabel === 'fluent-player-pro') {
    const changedPlayerFiles = changedPathList.filter((filePath) => /player|subtitle|chapter|playlist|shortcode|block|analytics|drm/i.test(filePath));
    const isProRepo = productProfile.repoLabel === 'fluent-player-pro';

    if (changedPlayerFiles.length && !getChangedTestFiles(fileEntries).length) {
      pushFinding(findings, {
        severity: isProRepo ? 'important' : 'medium',
        confidence: 'medium',
        file: changedPlayerFiles[0],
        line: 1,
        title: `${productProfile.name} config change needs frontend playback verification`,
        evidence: 'The diff changes player-facing config or runtime files without matching verification coverage.',
        impact: 'Player regressions usually surface only in the browser: wrong source config, missing subtitles/chapters, failed initialization, or broken pro overlays/analytics after save.',
        explanation: 'These repos are heavily config-contract driven. A mismatch between saved settings, shortcode/block attributes, and the frontend player bootstrap can leave the admin side looking correct while playback breaks for users.',
        verification: 'Verify the changed player config on a real rendered player, including initialization, source loading, and any touched subtitle/chapter/analytics/protection path.',
        fixDirection: 'Add product-specific playback verification or document the exact rendered-player scenarios checked before PR.'
      });
    }

    if (isProRepo && changedPlayerFiles.length && !changedPathList.some((filePath) => /shared|common|base|bootstrap/i.test(filePath))) {
      pushOutsideDiffFinding(outsideDiffFindings, {
        severity: 'medium',
        file: 'shared player bootstrap',
        line: 1,
        title: 'Pro player change may need a shared free/pro config compatibility check',
        explanation: 'Fluent Player Pro often extends a shared frontend player contract. A Pro-only change can be locally correct but still diverge from the base config shape expected by the shared bootstrap path.',
        verification: 'Check the same config keys against the shared/base player bootstrap to confirm the Pro extension still composes cleanly with the core player config.',
        fixDirection: 'Validate the changed Pro config against the shared player bootstrap and align any diverging config keys or defaults.'
      });
    }
  }

  if (productProfile.repoLabel && !findings.length && !outsideDiffFindings.length) {
    notes.push(`Applied ${productProfile.name} product-specific review rules: ${productProfile.regressionChecks.join('; ')}.`);
  }

  return { findings, outsideDiffFindings, notes };
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
      return 3;
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
    if (importantFindings.length || mediumFindings.length) {
      return 3;
    }

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
    baseRef: report.baseRef,
    mode: report.mode,
    reviewDepth: report.reviewDepth,
    engine: report.engine,
    reviewedCommit: report.reviewedCommit,
    verdict: report.verdict,
    confidenceScore: report.confidenceScore,
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
  if (score >= 4) {
    return 'high';
  }

  if (score === 3) {
    return 'moderate';
  }

  return 'low';
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

function buildRecheckState(previousState, findings, reviewedCommit) {
  if (!previousState || !previousState.findings || !previousState.findings.length) {
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
    commitChanged,
    cleared,
    remaining,
    introduced
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
      const remainingLabel = report.verdict === 'REQUEST_CHANGES' ? 'blocking finding(s) remain' : 'finding(s) remain';
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

function renderText(report) {
  const lines = [];
  const counts = buildFindingSummary(report.findings);
  const blockerCount = countBlockerFindings(report.findings);

  lines.push('Summary', '');
  lines.push(buildNarrativeSummary(report));
  lines.push('');
  lines.push(report.summary);
  lines.push('');
  lines.push(`Merge stance: ${report.verdict}`);
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

  if (report.recheck) {
    lines.push('', 'Recheck Status:');
    if (report.recheck.previousCommit) {
      lines.push(`- Previous reviewed commit: ${report.recheck.previousCommit}`);
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

  if (report.findings.length) {
    lines.push('', 'Findings', '');
    if (blockerCount) {
      lines.push('Must fix before merge.');
      lines.push('');
    } else {
      lines.push('No confirmed blocker-level findings, but the following issues are still worth resolving before PR.');
      lines.push('');
    }
    lines.push(`Verification confirmed ${counts.critical} critical, ${counts.important} important, ${counts.medium} medium, and ${counts.low} low finding(s) in the reviewed changes.`);

    report.findings.forEach((finding, index) => {
      lines.push('');
      lines.push(`${index + 1}. ${finding.title}`);
      lines.push(`   Severity: ${finding.severity}`);
      lines.push(`   Confidence: ${finding.confidence}`);
      lines.push(`   File: ${finding.file}:${finding.line}`);
      lines.push(`   What is wrong: ${finding.evidence}`);
      lines.push(`   Why it matters: ${finding.impact}`);
      lines.push(`   Explanation: ${finding.explanation || 'No additional explanation provided.'}`);
      lines.push(`   What to verify: ${finding.verification || 'Add or run targeted checks around this path.'}`);
      lines.push(`   Fix: ${finding.fixDirection}`);
      lines.push('   Prompt To Fix With AI:');
      lines.push('');
      buildFixPrompt(report, finding).split('\n').forEach((line) => lines.push(`   ${line}`));
    });

    lines.push('', 'Prompt To Fix All With AI:', '');
    buildFixAllPrompt(report).split('\n').forEach((line) => lines.push(line));
  } else {
    lines.push('', 'Findings', '', 'No findings.');
  }

  if (report.outsideDiffFindings.length) {
    lines.push('', 'Outside Diff Follow-ups', '');
    report.outsideDiffFindings.forEach((finding, index) => {
      lines.push(`${index + 1}. ${finding.title}`);
      lines.push(`   Severity: ${finding.severity}`);
      lines.push(`   Location: ${finding.file}:${finding.line}`);
      lines.push(`   Why it matters: ${finding.explanation}`);
      lines.push(`   What to verify: ${finding.verification}`);
      lines.push(`   Fix: ${finding.fixDirection}`);
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

function renderMarkdown(report) {
  const counts = buildFindingSummary(report.findings);
  const blockerCount = countBlockerFindings(report.findings);
  const lines = [
    '# Codex Review Report',
    '',
    '## Summary',
    '',
    buildNarrativeSummary(report),
    '',
    report.summary,
    '',
    `- Merge stance: \`${report.verdict}\``,
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

  if (report.recheck) {
    lines.push('', '## Recheck Status', '');
    if (report.recheck.previousCommit) {
      lines.push(`- Previous reviewed commit: \`${report.recheck.previousCommit}\``);
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

  if (!report.findings.length) {
    lines.push('', '## Findings', '', 'No findings.');
    if (report.reviewedCommit) {
      lines.push('', `Last reviewed commit: \`${report.reviewedCommit}\``);
    }
    return lines.join('\n');
  }

  lines.push('', '## Findings', '');
  lines.push(blockerCount ? 'Must fix before merge.' : 'No confirmed blocker-level findings, but the following issues are still worth resolving before PR.');
  lines.push('');
  lines.push(`Verification confirmed ${counts.critical} critical, ${counts.important} important, ${counts.medium} medium, and ${counts.low} low finding(s) in the reviewed changes.`);
  lines.push('');
  report.findings.forEach((finding, index) => {
    lines.push(`### ${index + 1}. ${finding.title}`);
    lines.push('');
    lines.push(`- Severity: \`${finding.severity}\``);
    lines.push(`- Confidence: \`${finding.confidence}\``);
    lines.push(`- File: \`${finding.file}:${finding.line}\``);
    lines.push(`- What is wrong: ${finding.evidence}`);
    lines.push(`- Why it matters: ${finding.impact}`);
    lines.push(`- Explanation: ${finding.explanation || 'No additional explanation provided.'}`);
    lines.push(`- What to verify: ${finding.verification || 'Add or run targeted checks around this path.'}`);
    lines.push(`- Fix direction: ${finding.fixDirection}`);
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

  lines.push('<details>');
  lines.push('<summary>Prompt To Fix All With AI</summary>');
  lines.push('');
  lines.push('```text');
  lines.push(buildFixAllPrompt(report));
  lines.push('```');
  lines.push('</details>');
  lines.push('');

  if (report.outsideDiffFindings.length) {
    lines.push('## Outside Diff Follow-ups', '');
    report.outsideDiffFindings.forEach((finding, index) => {
      lines.push(`### ${index + 1}. ${finding.title}`);
      lines.push('');
      lines.push(`- Severity: \`${finding.severity}\``);
      lines.push(`- Location: \`${finding.file}:${finding.line}\``);
      lines.push(`- Why it matters: ${finding.explanation}`);
      lines.push(`- What to verify: ${finding.verification}`);
      lines.push(`- Fix direction: ${finding.fixDirection}`);
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
    'Make the review explanatory. For each finding, explain the concrete failure mode or regression scenario, why the changed code creates that risk, and what the developer should verify next.',
    'Prefer explanations that mention the affected workflow, such as payment acceptance, webhook verification, option persistence, route access, or rendering behavior.',
    'Always populate key_changes with 1-2 concise bullets about what the patch appears to do correctly or safely when the diff supports that.',
    'Use outside_diff_findings for closely related blocker-level follow-ups that are not directly part of the changed lines but are necessary to validate the same workflow.',
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
    'Product profile:',
    JSON.stringify(payload.productProfile || null, null, 2),
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

  const limit = options.reviewDepth === 'thorough' ? CODEX_FILE_LIMITS.thorough : CODEX_FILE_LIMITS.balanced;
  return selected.slice(0, limit);
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
      keyChanges: parsed.key_changes || [],
      findings: (parsed.findings || []).map(normalizeCodexFinding),
      outsideDiffFindings: (parsed.outside_diff_findings || []).map(normalizeOutsideDiffFinding)
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runHeuristicReview(options, reviewContext, notes = [], engine = 'heuristic', fallbackUsed = false) {
  const { baseRef, fileEntries, instructions, diffText } = reviewContext;
  const findings = [];
  const outsideDiffFindings = [];
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
      explanation: 'This does not prove the code is wrong, but it does mean a risky path changed without any nearby automated verification. In payment, auth, routing, or persistence code, that usually increases the chance of shipping a silent regression.',
      verification: 'Add targeted tests or document the exact manual scenarios that were verified before opening the PR.',
      fixDirection: 'Add targeted tests or document the manual verification steps before opening the PR.'
    });
  }

  const productReview = buildProductSpecificFindings(options, reviewContext);
  productReview.findings.forEach((finding) => pushFinding(findings, finding));
  productReview.outsideDiffFindings.forEach((finding) => pushOutsideDiffFinding(outsideDiffFindings, finding));
  notes.push(...productReview.notes);

  if (
    reviewContext.productProfile &&
    reviewContext.productProfile.repoLabel === 'fluentformpro' &&
    findings.some((finding) => finding.title === 'Payment processor change needs product-specific verification coverage')
  ) {
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
  const repoRoot = getRepoRoot(cwd);
  const repoLabel = getRepoLabel(cwd);
  const productProfile = buildCustomProductProfile(repoLabel, options.productProfile) || getProductProfile(repoLabel);

  return {
    cwd,
    repoRoot,
    productProfile,
    baseRef,
    fileEntries,
    instructions,
    diffText,
    reviewedCommit: getCurrentCommit(cwd),
    repoLabel
  };
}

function buildFinalReport(options, reviewContext, reviewResult) {
  const { baseRef, fileEntries, instructions, reviewedCommit, repoLabel, repoRoot } = reviewContext;
  const rankedFindings = rankFindings((reviewResult.findings || []).map((finding) => ({
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
    fingerprint: buildFindingFingerprint(finding)
  }))).slice(0, options.maxFindings);
  const scope = summarizeScope(fileEntries, instructions);
  const previousState = loadPreviousReviewState(repoRoot);
  const report = {
    verdict: reviewResult.verdict || buildVerdict(rankedFindings),
    confidenceScore: 0,
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

  report.recheck = buildRecheckState(previousState, rankedFindings, reviewedCommit);

  if (options.format === 'json') {
    report.rendered = JSON.stringify(report, null, 2);
  } else if (options.format === 'markdown') {
    report.rendered = renderMarkdown(report);
  } else {
    report.rendered = renderText(report);
  }

  report.exitCode = shouldFail(report, options.failOn) ? 2 : 0;
  saveReviewState(repoRoot, report);
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
      notes.push(`Codex scope narrowed to ${selectedEntries.length} of ${reviewContext.fileEntries.length} changed files for ${resolvedOptions.reviewDepth} review depth.`);
    }

    const payload = {
      mode: resolvedOptions.mode,
      baseRef: reviewContext.baseRef || '--staged',
      productProfile: reviewContext.productProfile,
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
      codexResult.codexReviewedFiles = selectedEntries.map((entry) => entry.path);
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
