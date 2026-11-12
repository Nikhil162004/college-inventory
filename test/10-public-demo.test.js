'use strict';
/**
 * A public demonstration site: the made-up college, served on the internet with
 * the full production safeguards, so that phones can scan its QR codes.
 * It has to be asked for by name (PUBLIC_DEMO=1); without that, production
 * still refuses the demonstration data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { makeWorld, request } = require('./helpers');
const { buildConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { startupProblem } = require('../src/lib/startup');

const ROOT = path.join(__dirname, '..');
const KEYS = ['NODE_ENV', 'BASE_URL', 'RENDER_EXTERNAL_URL', 'PUBLIC_DEMO', 'SESSION_SECRET', 'EMBED_PREVIEW'];

/** Runs fn with exactly these settings in the environment, then puts everything back. */
function withEnv(vars, fn) {
  const before = {};
  for (const key of KEYS) { before[key] = process.env[key]; delete process.env[key]; }
  Object.assign(process.env, { NODE_ENV: 'test' }, vars);
  try { return fn(); } finally {
    for (const key of KEYS) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
  }
}

function demoDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-demo-'));
  const file = path.join(dir, 'demo.db');
  const db = openDb(file);
  db.prepare("INSERT INTO meta (key, value) VALUES ('demo', '1')").run();
  db.close();
  return { dir, file };
}

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test('PUBLIC_DEMO is off unless asked for, and is read from the environment', () => {
  assert.equal(withEnv({}, () => buildConfig().publicDemo), false);
  assert.equal(withEnv({ PUBLIC_DEMO: '1' }, () => buildConfig().publicDemo), true);
  assert.equal(withEnv({ PUBLIC_DEMO: 'no' }, () => buildConfig().publicDemo), false);
});

test('the address a host gives the site is used for QR codes when BASE_URL is not set', () => {
  assert.equal(withEnv({ RENDER_EXTERNAL_URL: 'https://inventory-demo.onrender.com' }, () => buildConfig().baseUrl),
    'https://inventory-demo.onrender.com');
  assert.equal(withEnv({ RENDER_EXTERNAL_URL: 'https://inventory-demo.onrender.com', BASE_URL: 'https://inventory.college.example/' },
    () => buildConfig().baseUrl), 'https://inventory.college.example', 'an address you set yourself wins');
  // and it satisfies the production rule that the address must be https
  const prod = withEnv({ NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(48), RENDER_EXTERNAL_URL: 'https://inventory-demo.onrender.com' },
    () => buildConfig());
  assert.equal(prod.isProd, true);
  assert.equal(prod.cookieSecure, true);
  assert.equal(prod.baseUrl, 'https://inventory-demo.onrender.com');
  assert.throws(() => withEnv({ NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(48) }, () => buildConfig()), /BASE_URL is required/);
});

test('a public demonstration keeps every production rule', () => {
  assert.throws(() => withEnv({ NODE_ENV: 'production', PUBLIC_DEMO: '1', RENDER_EXTERNAL_URL: 'https://d.onrender.com' }, () => buildConfig()),
    /SESSION_SECRET is required/);
  assert.throws(() => withEnv({ NODE_ENV: 'production', PUBLIC_DEMO: '1', SESSION_SECRET: 's'.repeat(48), BASE_URL: 'http://d.example' },
    () => buildConfig()), /https/);
  assert.throws(() => withEnv({ NODE_ENV: 'production', PUBLIC_DEMO: '1', EMBED_PREVIEW: '1', SESSION_SECRET: 's'.repeat(48),
    BASE_URL: 'https://d.example' }, () => buildConfig()), /EMBED_PREVIEW/);
});

test('production serves the demonstration data only when PUBLIC_DEMO says so', () => {
  const { dir, file } = demoDbFile();
  const db = openDb(file);
  assert.match(startupProblem({ db, config: { isProd: true, publicDemo: false } }), /demonstration data/);
  assert.match(startupProblem({ db, config: { isProd: true } }), /demonstration data/);
  assert.equal(startupProblem({ db, config: { isProd: true, publicDemo: true } }), null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a public demonstration says what it is: sign-ins on the sign-in page, and only for demonstration data', async () => {
  const settings = { isProd: true, publicDemo: true, cookieSecure: true, baseUrl: 'https://inventory-demo.onrender.com' };
  const demo = await makeWorld(settings);
  demo.db.prepare("INSERT INTO meta (key, value) VALUES ('demo', '1')").run();
  const page = await request(demo.app).get('/login');
  assert.equal(page.status, 200);
  assert.match(page.text, /Demonstration accounts/);
  assert.match(page.text, /Register#Student26/);

  const real = await makeWorld(settings); // PUBLIC_DEMO left on by mistake over real data: nothing is shown
  assert.doesNotMatch((await request(real.app).get('/login')).text, /Demonstration accounts|Register#/);

  const guarded = await makeWorld({ ...settings, publicDemo: false });
  guarded.db.prepare("INSERT INTO meta (key, value) VALUES ('demo', '1')").run();
  assert.doesNotMatch((await request(guarded.app).get('/login')).text, /Demonstration accounts|Register#/);
});

test('the real server process starts as a public demonstration and announces it', async () => {
  const { dir, file } = demoDbFile();
  const port = await freePort();
  const env = { ...process.env, NODE_ENV: 'production', PUBLIC_DEMO: '1', SESSION_SECRET: 'x'.repeat(48),
    RENDER_EXTERNAL_URL: 'https://inventory-demo.onrender.com', DB_PATH: file, PORT: String(port), HOST: '127.0.0.1', TRUST_PROXY: '1' };
  delete env.EMBED_PREVIEW; delete env.BASE_URL;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 100 && !/listening on/.test(out) && child.exitCode === null; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /listening on/, out);
    assert.match(out, /public demonstration/i);
    assert.match(out, /https:\/\/inventory-demo\.onrender\.com/, 'says which address the QR codes will carry');
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    const login = await fetch(`http://127.0.0.1:${port}/login`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(login.status, 200);
    assert.match(await login.text(), /Demonstration accounts/);
    assert.match(login.headers.get('set-cookie') || '', /__Host-sid=.*Secure/i, 'production cookie rules apply');
    assert.ok(login.headers.get('strict-transport-security'), 'production headers apply');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('demonstration data cannot be loaded in production without PUBLIC_DEMO', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-seed-'));
  const env = { ...process.env, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(48), BASE_URL: 'https://inventory.college.example',
    DB_PATH: path.join(dir, 'real.db') };
  delete env.PUBLIC_DEMO; delete env.EMBED_PREVIEW;
  const run = spawnSync(process.execPath, ['scripts/seed-demo.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 20000 });
  const made = fs.existsSync(path.join(dir, 'real.db'));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr + run.stdout, /cannot be loaded/);
  assert.equal(made, false, 'nothing was written');
});

test('the hosting recipe matches the application', () => {
  const recipe = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(recipe, /^\s*plan:\s*free\s*$/m);
  assert.match(recipe, /^\s*healthCheckPath:\s*\/healthz\s*$/m);
  assert.match(recipe, /key:\s*PUBLIC_DEMO\s*\n\s*value:\s*"?1"?/);
  assert.match(recipe, /key:\s*TRUST_PROXY/);
  assert.match(recipe, /key:\s*SESSION_SECRET\s*\n\s*generateValue:\s*true/, 'the secret is generated by the host, never written in the file');
  const build = /^\s*buildCommand:\s*(.+)$/m.exec(recipe)[1];
  const start = /^\s*startCommand:\s*(.+)$/m.exec(recipe)[1];
  for (const used of (build + ' ' + start).matchAll(/npm (?:run )?([a-z:]+)/g)) {
    if (['ci', 'install'].includes(used[1])) continue;
    assert.ok(pkg.scripts[used[1]], `render.yaml uses "npm run ${used[1]}", which package.json must define`);
  }
  assert.match(build, /seed:demo/, 'the demonstration college is loaded while building');
});
