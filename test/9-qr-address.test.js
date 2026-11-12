'use strict';
// A QR label contains the address of the site. These tests cover which address
// that is, the warnings shown when other devices could not open it, and the
// start-up checks that go with moving from a demonstration to real use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeWorld, request } = require('./helpers');
const { openDb } = require('../src/db');
const { lanAddresses, startupProblem } = require('../src/lib/startup');

const ROOT = path.join(__dirname, '..');
const text = (html) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/\s+/g, ' ');

test('with a permanent address configured, QR codes use it and there is no warning', async () => {
  const w = await makeWorld({ baseUrl: 'https://inventory.college.example' });
  const pc = w.addPc();
  const staff = await w.as('staff');
  const detail = text((await staff.get('/equipment/' + pc.id)).text);
  assert.match(detail, new RegExp(`https://inventory\\.college\\.example/e/${pc.asset_tag}`));
  assert.doesNotMatch(detail, /cannot open|only works on this computer|permanent address/i);
  const labels = text((await staff.get('/equipment/labels')).text);
  assert.doesNotMatch(labels, /cannot open|only works on this computer|permanent address/i);
});

test('opened as localhost: the QR pages say that phones cannot open that address', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const staff = await w.as('staff');
  for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000']) {
    const detail = text((await staff.get('/equipment/' + pc.id).set('Host', host)).text);
    assert.match(detail, /only works on this computer/, host);
    assert.match(detail, /network address/, host);
    const labels = text((await staff.get('/equipment/labels').set('Host', host)).text);
    assert.match(labels, /only works on this computer/, host);
  }
});

test('opened by a network address without BASE_URL: codes use it, with a reminder before printing', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const staff = await w.as('staff');
  const detail = text((await staff.get('/equipment/' + pc.id).set('Host', '192.168.1.20:3000')).text);
  assert.match(detail, new RegExp(`http://192\\.168\\.1\\.20:3000/e/${pc.asset_tag}`));
  assert.doesNotMatch(detail, /only works on this computer/);
  const labels = text((await staff.get('/equipment/labels').set('Host', '192.168.1.20:3000')).text);
  assert.match(labels, /point to http:\/\/192\.168\.1\.20:3000/);
  assert.match(labels, /permanent address/);
  assert.match(labels, /BASE_URL/);
  assert.match((await staff.get('/equipment/labels').set('Host', '192.168.1.20:3000')).text, /class="[^"]*no-print[^"]*"[^>]*>[^<]*(<[^>]+>[^<]*)*point to/, 'the reminder is never printed onto the label sheet');
});

test('in the hosted preview: the QR pages say the preview address is private', async () => {
  const w = await makeWorld({ embedPreview: true });
  const pc = w.addPc();
  const staff = await w.as('staff');
  const detail = text((await staff.get('/equipment/' + pc.id)).text);
  assert.match(detail, /private preview/);
  assert.match(detail, /other devices cannot open/);
  assert.match(text((await staff.get('/equipment/labels')).text), /private preview/);
});

test('the warning is escaped and only appears where a QR code is shown', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const staff = await w.as('staff');
  const res = await staff.get('/equipment/labels').set('Host', 'evil.example"><script>alert(1)</script>');
  assert.doesNotMatch(res.text, /<script>alert/);
  const student = await w.as('student');
  const scanned = text((await student.get('/equipment/' + pc.id).set('Host', 'localhost:3000')).text);
  assert.doesNotMatch(scanned, /only works on this computer/, 'students see no QR code and so no warning');
});

test('start-up lists the addresses other devices on the network can use', () => {
  const found = lanAddresses();
  assert.ok(Array.isArray(found));
  for (const a of found) {
    assert.match(a, /^\d{1,3}(\.\d{1,3}){3}$/);
    assert.doesNotMatch(a, /^127\./, 'never the loopback address');
  }
  const fake = { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
                 wifi: [{ family: 'IPv6', internal: false, address: 'fe80::1' }, { family: 'IPv4', internal: false, address: '192.168.1.20' }],
                 vpn: [{ family: 4, internal: false, address: '10.8.0.2' }] };
  assert.deepEqual(lanAddresses(fake), ['192.168.1.20', '10.8.0.2']);
});

test('production refuses to run on the demonstration data', () => {
  const demoDb = openDb(':memory:');
  demoDb.prepare("INSERT INTO meta (key, value) VALUES ('demo', '1')").run();
  const cleanDb = openDb(':memory:');
  assert.match(startupProblem({ db: demoDb, config: { isProd: true } }), /demonstration data/);
  assert.match(startupProblem({ db: demoDb, config: { isProd: true } }), /npm run setup/);
  assert.equal(startupProblem({ db: demoDb, config: { isProd: false } }), null, 'fine while trying it out');
  assert.equal(startupProblem({ db: cleanDb, config: { isProd: true } }), null, 'fine with real data');
});

test('the real server process exits instead of serving demonstration accounts in production', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
  const file = path.join(dir, 'demo.db');
  const db = openDb(file);
  db.prepare("INSERT INTO meta (key, value) VALUES ('demo', '1')").run();
  db.close();
  const env = { ...process.env, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(48), BASE_URL: 'https://inventory.college.example',
    DB_PATH: file, PORT: '0', HOST: '127.0.0.1' };
  delete env.EMBED_PREVIEW;
  const run = spawnSync(process.execPath, ['src/server.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 15000 });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notEqual(run.status, 0, 'does not keep running');
  assert.match(run.stderr + run.stdout, /demonstration data/);
  assert.doesNotMatch(run.stderr + run.stdout, /listening on/);
});

test('the test command works on Windows too (no shell-only syntax)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    assert.doesNotMatch(cmd, /^\s*[A-Z_]+=/, `"npm run ${name}" must not start with VAR=value`);
    assert.doesNotMatch(cmd, /\*/, `"npm run ${name}" must not rely on the shell expanding *`);
  }
});
