'use strict';
// Runs every test file. Written as a script (instead of shell syntax in
// package.json) so that "npm test" behaves the same on Windows, macOS and Linux.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, NODE_ENV: 'test' },
  stdio: 'inherit',
});
process.exit(run.status === null ? 1 : run.status);
