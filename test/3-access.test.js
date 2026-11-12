'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, post } = require('./helpers');

// Every page and who may open it. true = allowed (200), false = refused (403).
const PAGES = [
  // path,                    student, faculty, staff, admin
  ['/',                        true,   true,   true,  true],
  ['/account',                 true,   true,   true,  true],
  ['/reports',                 true,   true,   true,  true],
  ['/equipment',               false,  true,   true,  true],
  ['/locations',               false,  true,   true,  true],
  ['/locations/1',             false,  true,   true,  true],
  ['/equipment/new',           false,  false,  true,  true],
  ['/equipment/1/edit',        false,  false,  true,  true],
  ['/equipment/labels',        false,  false,  true,  true],
  ['/equipment/export.csv',    false,  false,  true,  true],
  ['/locations/new',           false,  false,  false, true],
  ['/locations/1/edit',        false,  false,  false, true],
  ['/categories',              false,  false,  false, true],
  ['/users',                   false,  false,  false, true],
  ['/users/new',               false,  false,  false, true],
  ['/users/import',            false,  false,  false, true],
  ['/users/1/edit',            false,  false,  false, true],
  ['/audit',                   false,  false,  false, true],
];

test('each role can open exactly the pages it is entitled to', async () => {
  const w = await makeWorld();
  w.addPc();
  const roles = ['student', 'faculty', 'staff', 'admin'];
  for (let r = 0; r < roles.length; r++) {
    const agent = await w.as(roles[r]);
    for (const page of PAGES) {
      const res = await agent.get(page[0]);
      assert.equal(res.status, page[r + 1] ? 200 : 403, `${roles[r]} GET ${page[0]}`);
    }
  }
});

test('changes are refused for roles without permission, even with a valid token', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const equipment = { name: 'Sneaky', category_id: w.pcCategory, location_id: w.lab1, quantity: '1' };
  const attempts = [
    // [who, path, body]
    ['student', '/equipment', equipment],
    ['faculty', '/equipment', equipment],
    ['student', `/equipment/${pc.id}`, { name: 'Renamed', location_id: w.lab2 }],
    ['faculty', `/equipment/${pc.id}`, { name: 'Renamed', location_id: w.lab2 }],
    ['staff', `/equipment/${pc.id}/retire`, { reason: 'not my decision' }],
    ['student', '/reports/1/update', { status: 'resolved', note: 'fixed it myself' }],
    ['faculty', '/reports/1/update', { status: 'resolved', note: 'fixed it myself' }],
    ['staff', '/locations', { code: 'LAB-99', name: 'Ghost lab', kind: 'lab' }],
    ['staff', '/categories', { name: 'Ghost', prefix: 'GHO' }],
    ['staff', '/users', { college_id: 'NEW001', name: 'New Person', role: 'admin' }],
    ['staff', `/users/${w.ids.student}`, { name: 'X Y', role: 'admin', is_active: '1' }],
    ['staff', `/users/${w.ids.student}/reset-password`, {}],
    ['faculty', '/users/import', { csv: 'college_id,name,role\nNEW002,New Two,student' }],
  ];
  const before = JSON.stringify([
    w.db.prepare('SELECT * FROM equipment').all(), w.db.prepare('SELECT id, role, name, password_hash FROM users').all(),
    w.db.prepare('SELECT * FROM locations').all(), w.db.prepare('SELECT * FROM categories').all(),
  ]);
  const agents = {};
  for (const [who, path, body] of attempts) {
    agents[who] ||= await w.as(who);
    const res = await post(agents[who], path, body);
    assert.equal(res.status, 403, `${who} POST ${path}`);
  }
  const after = JSON.stringify([
    w.db.prepare('SELECT * FROM equipment').all(), w.db.prepare('SELECT id, role, name, password_hash FROM users').all(),
    w.db.prepare('SELECT * FROM locations').all(), w.db.prepare('SELECT * FROM categories').all(),
  ]);
  assert.equal(after, before, 'nothing in the database changed');
});

test('students see only their own reports and limited equipment details', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  w.db.prepare("UPDATE equipment SET serial_no = 'SERIAL-SECRET-1', purchase_cost = 58500, vendor = 'Vendor Confidential' WHERE id = ?").run(pc.id);
  const sita = await w.as('student');
  const ravi = await w.as('student2');

  const filed = await post(sita, `/equipment/${pc.id}/report`, { issue_type: 'not_working', description: 'Does not power on at all.' });
  assert.equal(filed.status, 302);
  const reportPath = filed.headers.location;

  assert.equal((await sita.get(reportPath)).status, 200);
  const other = await ravi.get(reportPath);
  assert.equal(other.status, 404, 'another student gets "not found", not even "forbidden"');
  assert.equal((await ravi.get('/reports/999999')).status, 404);
  const list = await ravi.get('/reports?status=all');
  assert.ok(!list.text.includes(pc.asset_tag), "another student's report is not listed");
  assert.ok((await sita.get('/reports?status=all')).text.includes(pc.asset_tag));

  const page = await ravi.get(`/equipment/${pc.id}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(pc.asset_tag));
  for (const secret of ['SERIAL-SECRET-1', '58,500', 'Vendor Confidential', 'Sita Student', '<svg']) {
    assert.ok(!page.text.includes(secret), `student page must not contain ${secret}`);
  }
  const staffPage = await (await w.as('staff')).get(`/equipment/${pc.id}`);
  for (const visible of ['SERIAL-SECRET-1', '58,500', 'Vendor Confidential', 'Sita Student', '<svg']) {
    assert.ok(staffPage.text.includes(visible), `staff page shows ${visible}`);
  }
});

test('signed-in pages are never cached', async () => {
  const w = await makeWorld();
  const agent = await w.as('admin');
  for (const path of ['/', '/users', '/audit']) {
    assert.equal((await agent.get(path)).headers['cache-control'], 'no-store', path);
  }
});
