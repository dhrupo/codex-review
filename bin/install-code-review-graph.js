#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const scriptsDir = process.platform === 'win32' ? 'Scripts' : 'bin';
const pythonName = process.platform === 'win32' ? 'python.exe' : 'python';
const graphName = process.platform === 'win32' ? 'code-review-graph.exe' : 'code-review-graph';
const venvDir = path.join(repoRoot, '.venv-code-review-graph');
const venvPython = path.join(venvDir, scriptsDir, pythonName);
const graphCli = path.join(venvDir, scriptsDir, graphName);

function fail(message, error = null) {
  console.error(`install-code-review-graph: ${message}`);
  if (error && error.message) {
    console.error(error.message);
  }
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit'
  });

  if (result.error) {
    fail(`failed to start ${command}`, result.error);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function findPythonCommand() {
  const candidates = ['python3', 'python'];

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  return null;
}

const pythonCommand = findPythonCommand();
if (!pythonCommand) {
  fail('python3 or python is required to install code-review-graph.');
}

if (!fs.existsSync(venvPython)) {
  console.error(`install-code-review-graph: creating virtualenv at ${venvDir}`);
  run(pythonCommand, ['-m', 'venv', venvDir]);
}

console.error('install-code-review-graph: installing code-review-graph into the local virtualenv');
run(venvPython, ['-m', 'pip', 'install', 'code-review-graph']);
run(graphCli, ['--version']);
console.error(`install-code-review-graph: ready at ${graphCli}`);
