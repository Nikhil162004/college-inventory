'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeWorld, post, request } = require('./helpers');

test('security headers are present on every response', async () => {
  const w = await makeWorld();
  for (const res of [await request(w.app).get('/login'), await (await w.as('admin')).get('/'), await request(w.app).get('/static/app.css')]) {
    const h = res.headers;
    const csp = h['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/, 'no inline or third-party scripts');
    assert.match(csp, /style-src 'self'(;|$)/, 'no inline styles');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    assert.equal(h['x-frame-options'], 'DENY');
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['referrer-policy'], 'same-origin');
    assert.match(h['permissions-policy'], /camera=\(\)/);
    assert.equal(h['x-powered-by'], undefined);
  }
});

test('templates contain no inline scripts, inline styles or unescaped user output', () => {
  const dir = path.join(__dirname, '..', 'src', 'views');
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.ejs'));
  assert.ok(files.length > 15);
  // The only raw (<%- %>) outputs allowed: includes, nav links built from constants, and server-generated QR SVG.
  const allowedRaw = /^<%-\s*(include\(|link\(|qr\s|e\.qr\s)/;
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, String(f)), 'utf8');
    assert.ok(!/<script(?![^>]*\ssrc=)/i.test(text), `${f}: inline <script>`);
    assert.ok(!/\sstyle\s*=/i.test(text), `${f}: inline style attribute`);
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(text), `${f}: inline event handler`);
    for (const raw of text.match(/<%-[^%]*%>/g) || []) {
      assert.match(raw, allowedRaw, `${f}: unexpected unescaped output ${raw}`);
    }
    if (/method="post"/.test(text)) {
      const forms = (text.match(/method="post"/g) || []).length;
      const tokens = (text.match(/name="_csrf"/g) || []).length;
      assert.equal(tokens, forms, `${f}: every POST form carries a CSRF token`);
    }
  }
});

test('errors never leak stack traces or internals', async () => {
  const w = await makeWorld();
  const admin = await w.as('admin');
  const original = console.error;
  console.error = () => {};
  try {
    w.db.exec('ALTER TABLE reports RENAME TO reports_broken');
    const res = await admin.get('/reports');
    assert.equal(res.status, 500);
    assert.ok(!/SqliteError|no such table|at .*\.js:\d+|node_modules/.test(res.text));
    assert.match(res.text, /Something went wrong/);
  } finally {
    w.db.exec('ALTER TABLE reports_broken RENAME TO reports');
    console.error = original;
  }
  const missing = await admin.get('/equipment/99999');
  assert.equal(missing.status, 404);
  assert.equal((await admin.get('/equipment/abc')).status, 404);
  assert.equal((await admin.get('/equipment/1%27%20OR%201=1')).status, 404);
});

test('oversized and malformed requests are rejected', async () => {
  const w = await makeWorld();
  const admin = await w.as('admin');
  const huge = await post(admin, '/equipment', { name: 'x'.repeat(200 * 1024) });
  assert.equal(huge.status, 413);
  // Only administrators get the larger limit on the import route.
  const student = await w.as('student');
  const sneaky = await post(student, '/users/import', { csv: 'x'.repeat(200 * 1024) });
  assert.equal(sneaky.status, 413);
  const many = await admin.post('/equipment').type('form').send(Array.from({ length: 500 }, (_, i) => `f${i}=1`).join('&'));
  assert.equal(many.status, 413);
  const json = await admin.post('/equipment').set('Content-Type', 'application/json').send('{"name":"x"}');
  assert.equal(json.status, 403, 'non-form bodies carry no CSRF token and are refused');
});

test('health check works without signing in and reveals nothing', async () => {
  const w = await makeWorld();
  const res = await request(w.app).get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.text, 'ok');
});

test('preview mode relaxes framing only when explicitly enabled', async () => {
  const w = await makeWorld({ embedPreview: true, cookieSecure: true });
  const res = await request(w.app).get('/login');
  assert.match(res.headers['content-security-policy'], /frame-ancestors \*/);
  assert.equal(res.headers['x-frame-options'], undefined);
  const cookie = String(res.headers['set-cookie']);
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Partitioned/);
});
