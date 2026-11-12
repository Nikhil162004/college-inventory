'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const passwords = require('../src/security/password');
const { parseCsv, csvCell, toCsv } = require('../src/lib/csv');
const { safeNext, can } = require('../src/middleware/auth');
const { formatTag, TAG_PATTERN } = require('../src/lib/inventory');
const v = require('../src/lib/validate');
const { buildConfig } = require('../src/config');

test('passwords: hash is salted, verifies, and rejects wrong input', async () => {
  const a = await passwords.hash('a long enough password');
  const b = await passwords.hash('a long enough password');
  assert.notEqual(a, b, 'same password must give different hashes (random salt)');
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.ok(!a.includes('a long enough password'));
  assert.equal(await passwords.verify('a long enough password', a), true);
  assert.equal(await passwords.verify('a long enough passwore', a), false);
  assert.equal(await passwords.verify('x', 'not-a-hash'), false);
  assert.equal(await passwords.verify('x', 'scrypt$1$8$1$AAAA$AAAA'), false);
  assert.equal(await passwords.verify(undefined, a), false);
});

test('passwords: policy rejects short, common and personal passwords', () => {
  const user = { college_id: '23CS001', name: 'Sita Student' };
  assert.ok(passwords.policyError('short', user));
  assert.ok(passwords.policyError('password123', user));
  assert.ok(passwords.policyError('aaaaaaaaaaaa', user));
  assert.ok(passwords.policyError('my-23cs001-pass', user));
  assert.ok(passwords.policyError('student-forever', user));
  assert.ok(passwords.policyError('x'.repeat(129), user));
  assert.equal(passwords.policyError('mango tree by the gate', user), null);
});

test('passwords: temporary passwords are random and well-formed', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const p = passwords.generateTemporaryPassword();
    assert.match(p, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    seen.add(p);
  }
  assert.equal(seen.size, 500);
});

test('csv: parser handles quotes, commas, CRLF and blank lines', () => {
  const rows = parseCsv('\uFEFFid,name\r\n1,"Rao, Sunita"\r\n\r\n2,"He said ""hi"""\n3,plain');
  assert.deepEqual(rows, [['id', 'name'], ['1', 'Rao, Sunita'], ['2', 'He said "hi"'], ['3', 'plain']]);
});

test('csv: export neutralises spreadsheet formulas', () => {
  assert.equal(csvCell('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('normal'), 'normal');
  assert.equal(csvCell(null), '');
  assert.ok(toCsv(['a'], [['b']]).endsWith('a\r\nb\r\n'));
});

test('redirect targets: only local paths are accepted', () => {
  assert.equal(safeNext('/e/PC-00001'), '/e/PC-00001');
  assert.equal(safeNext('/equipment?status=working&page=2'), '/equipment?status=working&page=2');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '/login', '/a b', '/x\r\nSet-Cookie: a=b', '', null, 42, '/' + 'a'.repeat(400)]) {
    assert.equal(safeNext(bad), '', `must reject ${JSON.stringify(bad)}`);
  }
});

test('permissions matrix', () => {
  const u = (role) => ({ role });
  assert.equal(can(u('student'), 'equipment.browse'), false);
  assert.equal(can(u('faculty'), 'equipment.browse'), true);
  assert.equal(can(u('faculty'), 'equipment.manage'), false);
  assert.equal(can(u('staff'), 'equipment.manage'), true);
  assert.equal(can(u('staff'), 'equipment.retire'), false);
  assert.equal(can(u('staff'), 'users.manage'), false);
  assert.equal(can(u('admin'), 'users.manage'), true);
  assert.equal(can(null, 'equipment.browse'), false);
  assert.equal(can(u('admin'), 'no.such.permission'), false);
});

test('asset tags and validators', () => {
  assert.equal(formatTag('pc', 42), 'PC-00042');
  assert.ok(TAG_PATTERN.test('PRJ-00001'));
  assert.ok(!TAG_PATTERN.test("PC-1' OR '1'='1"));
  assert.equal(v.likePattern('50%_x\\'), '%50\\%\\_x\\\\%');
  assert.deepEqual(v.paginate(51, 99, 25), { total: 51, pages: 3, page: 3, pageSize: 25, offset: 50 });
  const schema = v.z.object({ d: v.optDate, n: v.text(10) });
  assert.ok(v.check(schema, { d: '2024-02-30', n: 'x' }).errors.d);
  assert.ok(v.check(schema, { d: '', n: 'bad\u0000char' }).errors.n);
  assert.ok(v.check(schema, { d: '', n: ['a', 'b'] }).errors.n, 'repeated form fields are rejected');
  assert.deepEqual(v.check(schema, { d: '2024-02-29', n: ' ok ' }).data, { d: '2024-02-29', n: 'ok' });
});

test('production refuses to start without a secret, an https address, or with preview mode', () => {
  const keep = { ...process.env };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.SESSION_SECRET; delete process.env.BASE_URL; delete process.env.EMBED_PREVIEW;
    assert.throws(() => buildConfig(), /SESSION_SECRET/);
    process.env.SESSION_SECRET = 'short';
    assert.throws(() => buildConfig(), /too short/);
    process.env.SESSION_SECRET = 'x'.repeat(40);
    assert.throws(() => buildConfig(), /BASE_URL/);
    process.env.BASE_URL = 'http://inventory.college.example';
    assert.throws(() => buildConfig(), /https/);
    process.env.BASE_URL = 'https://inventory.college.example/';
    const cfg = buildConfig();
    assert.equal(cfg.cookieSecure, true);
    assert.equal(cfg.baseUrl, 'https://inventory.college.example');
    process.env.EMBED_PREVIEW = '1';
    assert.throws(() => buildConfig(), /EMBED_PREVIEW/);
  } finally {
    for (const k of ['NODE_ENV', 'SESSION_SECRET', 'BASE_URL', 'EMBED_PREVIEW']) {
      if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
    }
  }
});
