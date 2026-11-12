'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, post } = require('./helpers');

const status = (w, id) => w.db.prepare('SELECT status FROM equipment WHERE id = ?').get(id).status;

test('adding a batch gives every item its own sequential asset tag', async () => {
  const w = await makeWorld();
  const staff = await w.as('staff');
  const res = await post(staff, '/equipment', {
    name: 'Desktop computer', category_id: w.pcCategory, location_id: w.lab1, quantity: '30',
    brand: 'Dell', model: 'OptiPlex 7010', purchase_date: '2024-07-15', purchase_cost: '58500', warranty_until: '2027-07-15',
  });
  assert.equal(res.status, 302);
  const tags = w.db.prepare('SELECT asset_tag FROM equipment ORDER BY asset_tag').all().map((e) => e.asset_tag);
  assert.equal(tags.length, 30);
  assert.equal(tags[0], 'PC-00001');
  assert.equal(tags[29], 'PC-00030');
  assert.equal(new Set(tags).size, 30);

  const one = await post(staff, '/equipment', { name: 'Desktop computer', category_id: w.pcCategory, location_id: w.lab2, quantity: '1', serial_no: 'ABC123' });
  assert.match(one.headers.location, /^\/equipment\/\d+$/);
  assert.equal(w.db.prepare("SELECT asset_tag FROM equipment WHERE serial_no = 'ABC123'").get().asset_tag, 'PC-00031');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'equipment.create'").get().n, 31);
});

test('invalid equipment details are rejected with messages and nothing is saved', async () => {
  const w = await makeWorld();
  const staff = await w.as('staff');
  const bad = [
    { name: '', category_id: w.pcCategory, location_id: w.lab1, quantity: '1' },
    { name: 'PC', category_id: '999', location_id: w.lab1, quantity: '1' },
    { name: 'PC', category_id: w.pcCategory, location_id: '999', quantity: '1' },
    { name: 'PC', category_id: w.pcCategory, location_id: w.lab1, quantity: '0' },
    { name: 'PC', category_id: w.pcCategory, location_id: w.lab1, quantity: '201' },
    { name: 'PC', category_id: w.pcCategory, location_id: w.lab1, quantity: '5', serial_no: 'SAME-FOR-ALL' },
    { name: 'PC', category_id: w.pcCategory, location_id: w.lab1, quantity: '1', purchase_date: '2024-13-45' },
    { name: 'PC', category_id: w.pcCategory, location_id: w.lab1, quantity: '1', purchase_cost: '-5' },
    { name: 'x'.repeat(121), category_id: w.pcCategory, location_id: w.lab1, quantity: '1' },
    { name: 'PC', category_id: "1 OR 1=1", location_id: w.lab1, quantity: '1' },
  ];
  for (const body of bad) {
    const res = await post(staff, '/equipment', body);
    assert.equal(res.status, 422, JSON.stringify(body).slice(0, 80));
    assert.match(res.text, /field-error/);
  }
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM equipment').get().n, 0);
  assert.equal(w.db.prepare("SELECT next_seq FROM categories WHERE prefix = 'PC'").get().next_seq, 1);
});

test('script and SQL payloads are stored as plain text and shown escaped', async () => {
  const w = await makeWorld();
  const staff = await w.as('staff');
  const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const sqli = "Robert'); DROP TABLE equipment;--";
  const res = await post(staff, '/equipment', { name: xss, category_id: w.pcCategory, location_id: w.lab1, quantity: '1', brand: sqli, notes: '"><svg onload=alert(3)>' });
  assert.equal(res.status, 302);
  const row = w.db.prepare('SELECT * FROM equipment').get();
  assert.equal(row.name, xss);
  assert.equal(row.brand, sqli);

  for (const path of [res.headers.location, '/equipment', '/equipment/labels', '/audit', `/locations/${w.lab1}`]) {
    const page = await (await w.as('admin')).get(path);
    assert.equal(page.status, 200, path);
    assert.ok(!page.text.includes('<script>alert(1)'), `${path} must not contain a live script tag`);
    assert.ok(!page.text.includes('<img src=x'), `${path} must not contain a live img tag`);
    assert.ok(!page.text.includes('<svg onload'), `${path} must not contain a live svg handler`);
  }
  const detail = await staff.get(res.headers.location);
  assert.ok(detail.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

  // Hostile search strings are treated as text: no error, no data leak, table intact.
  w.addPc('Ordinary computer');
  for (const q of ["' OR '1'='1", "'; DROP TABLE equipment;--", '%', '_', '\\', '" OR ""="', "') UNION SELECT password_hash FROM users--"]) {
    const page = await staff.get('/equipment').query({ q });
    assert.equal(page.status, 200, q);
    assert.ok(!page.text.includes('Ordinary computer'), `search ${q} must not match everything`);
    assert.ok(!page.text.includes('scrypt$'), 'no password hashes in output');
  }
  for (const query of [{ location: "1 OR 1=1" }, { category: '1;DROP TABLE users' }, { status: "x' OR 1=1--" }, { page: '-1' }, { page: '99999999999999' }]) {
    assert.equal((await staff.get('/equipment').query(query)).status, 200, JSON.stringify(query));
  }
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM equipment').get().n, 2);
  // CSV export keeps formulas inert.
  w.db.prepare("UPDATE equipment SET vendor = '=cmd|calc' WHERE id = ?").run(row.id);
  const csv = await staff.get('/equipment/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-disposition'], /attachment/);
  assert.ok(csv.text.includes("'=cmd|calc"));
});

test('QR flow: scan, report, repair, resolve — equipment status follows the reports', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const student = await w.as('student');
  const staff = await w.as('staff');

  // Scanning the label leads to the item.
  const scan = await student.get('/e/' + pc.asset_tag.toLowerCase());
  assert.equal(scan.headers.location, `/equipment/${pc.id}`);
  assert.equal((await student.get('/find').query({ tag: ' pc-00001 ' })).headers.location, '/e/PC-00001');
  assert.equal((await student.get('/e/PC-99999')).status, 404);
  assert.equal((await student.get("/e/PC-1'--")).status, 404);

  // The staff label really encodes that address.
  const label = await staff.get(`/equipment/${pc.id}`);
  assert.ok(label.text.includes(`/e/${pc.asset_tag}`));
  assert.ok(label.text.includes('<svg'));

  // Validation on the report form.
  assert.equal((await post(student, `/equipment/${pc.id}/report`, { issue_type: 'nonsense', description: 'Does not power on at all.' })).status, 422);
  assert.equal((await post(student, `/equipment/${pc.id}/report`, { issue_type: 'not_working', description: 'short' })).status, 422);
  assert.equal(status(w, pc.id), 'working');

  const filed = await post(student, `/equipment/${pc.id}/report`, { issue_type: 'not_working', description: 'Does not power on, no light on the panel.' });
  assert.equal(filed.status, 302);
  const reportPath = filed.headers.location;
  assert.equal(status(w, pc.id), 'issue_reported');

  // The same person cannot file a second open report on the same item.
  const again = await post(student, `/equipment/${pc.id}/report`, { issue_type: 'damaged', description: 'Reporting the same thing again.' });
  assert.equal(again.headers.location, reportPath);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 1);
  // A different person is told it is already reported, but may add a different problem.
  const other = await w.as('student2');
  assert.match((await other.get(`/equipment/${pc.id}/report`)).text, /Already reported/);

  // Staff take it up.
  const start = await post(staff, `${reportPath}/update`, { status: 'in_progress', assigned_to: String(w.ids.staff), note: '' });
  assert.equal(start.status, 302);
  assert.equal(status(w, pc.id), 'under_repair');

  // Closing needs an explanation.
  assert.equal((await post(staff, `${reportPath}/update`, { status: 'resolved', assigned_to: String(w.ids.staff), note: '' })).status, 422);
  assert.equal((await post(staff, `${reportPath}/update`, { status: 'bogus', note: 'x' })).status, 422);
  assert.equal((await post(staff, `${reportPath}/update`, { status: 'in_progress', assigned_to: String(w.ids.student), note: 'x' })).status, 422, 'cannot assign to a student');
  const done = await post(staff, `${reportPath}/update`, { status: 'resolved', assigned_to: String(w.ids.staff), note: 'Replaced the power supply.' });
  assert.equal(done.status, 302);
  assert.equal(status(w, pc.id), 'working');

  // The reporter can read the outcome.
  const outcome = await student.get(reportPath);
  assert.ok(outcome.text.includes('Replaced the power supply.'));
  assert.ok(outcome.text.includes('Resolved'));
  assert.ok(!outcome.text.includes('Update this report'), 'students get no update form');

  // Reopening puts the equipment back to "issue reported".
  await post(staff, `${reportPath}/update`, { status: 'open', assigned_to: String(w.ids.staff), note: 'Fault came back.' });
  assert.equal(status(w, pc.id), 'issue_reported');
  assert.ok(w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'report.%'").get().n >= 4);
});

test('with two reports, equipment returns to working only when both are closed', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const a = await post(await w.as('student'), `/equipment/${pc.id}/report`, { issue_type: 'software', description: 'Compiler is not installed here.' });
  const b = await post(await w.as('student2'), `/equipment/${pc.id}/report`, { issue_type: 'damaged', description: 'Keyboard has missing keys.' });
  const staff = await w.as('staff');
  await post(staff, `${a.headers.location}/update`, { status: 'rejected', note: 'Compiler is installed, see Start menu.' });
  assert.equal(status(w, pc.id), 'issue_reported', 'one report is still open');
  await post(staff, `${b.headers.location}/update`, { status: 'in_progress', note: '' });
  assert.equal(status(w, pc.id), 'under_repair');
  assert.equal(w.db.prepare("SELECT assigned_to FROM reports WHERE status = 'in_progress'").get().assigned_to, w.ids.staff, 'taking a report up assigns it');
  await post(staff, `${b.headers.location}/update`, { status: 'resolved', note: 'Keyboard replaced.' });
  assert.equal(status(w, pc.id), 'working');
});

test('a person cannot flood the staff with reports', async () => {
  const w = await makeWorld({ reportsPerHour: 3 });
  const student = await w.as('student');
  const pcs = [w.addPc(), w.addPc(), w.addPc(), w.addPc()];
  for (let i = 0; i < 3; i++) {
    const res = await post(student, `/equipment/${pcs[i].id}/report`, { issue_type: 'other', description: 'Report number ' + i + ' for testing.' });
    assert.equal(res.status, 302);
  }
  const blocked = await post(student, `/equipment/${pcs[3].id}/report`, { issue_type: 'other', description: 'One report too many today.' });
  assert.equal(blocked.status, 429);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 3);
  assert.equal(status(w, pcs[3].id), 'working');
});

test('editing records who changed what; moving an item changes its lab', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const staff = await w.as('staff');
  const res = await post(staff, `/equipment/${pc.id}`, { name: 'Desktop computer', location_id: w.lab2, brand: 'HP' });
  assert.equal(res.status, 302);
  const row = w.db.prepare('SELECT * FROM equipment WHERE id = ?').get(pc.id);
  assert.equal(row.location_id, w.lab2);
  assert.equal(row.asset_tag, pc.asset_tag, 'the tag never changes');
  const entry = w.db.prepare("SELECT * FROM audit_log WHERE action = 'equipment.update'").get();
  assert.equal(entry.actor, 'STF001');
  assert.match(entry.summary, /location: LAB-01 → LAB-02/);
  assert.match(entry.summary, /brand: \(empty\) → HP/);
  // Fields that are not on the form cannot be changed by adding them to the request.
  await post(staff, `/equipment/${pc.id}`, { name: 'Desktop computer', location_id: w.lab2, status: 'retired', asset_tag: 'HACK-00001', category_id: '5', created_by: '999' });
  const same = w.db.prepare('SELECT * FROM equipment WHERE id = ?').get(pc.id);
  assert.equal(same.status, 'working');
  assert.equal(same.asset_tag, pc.asset_tag);
  assert.equal(same.category_id, row.category_id);
});

test('writing off keeps the record, closes open reports and blocks new ones', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const student = await w.as('student');
  const admin = await w.as('admin');
  await post(student, `/equipment/${pc.id}/report`, { issue_type: 'damaged', description: 'Cabinet is badly burnt.' });
  assert.equal((await post(admin, `/equipment/${pc.id}/retire`, { reason: 'x' })).status, 302);
  assert.equal(status(w, pc.id), 'issue_reported', 'a reason is required');
  await post(admin, `/equipment/${pc.id}/retire`, { reason: 'Burnt in short circuit, beyond repair' });
  assert.equal(status(w, pc.id), 'retired');
  assert.equal(w.db.prepare('SELECT status FROM reports').get().status, 'rejected');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM equipment').get().n, 1, 'nothing is deleted');
  const blocked = await post(await w.as('student2'), `/equipment/${pc.id}/report`, { issue_type: 'other', description: 'Trying to report a written-off item.' });
  assert.equal(blocked.status, 429);
  const detail = await admin.get(`/equipment/${pc.id}`); // also shows (and clears) the confirmation banner
  assert.match(detail.text, /written off/);
  assert.ok(detail.text.includes('Burnt in short circuit, beyond repair'));
  assert.ok(!(await admin.get('/equipment')).text.includes(pc.asset_tag), 'hidden from the default list');
  assert.ok((await admin.get('/equipment?status=retired')).text.includes(pc.asset_tag));
  await post(admin, `/equipment/${pc.id}/restore`);
  assert.equal(status(w, pc.id), 'working');
});

test('QR label sheet renders one code per item', async () => {
  const w = await makeWorld();
  for (let i = 0; i < 5; i++) w.addPc('Desktop computer', w.lab1);
  w.addPc('Elsewhere', w.lab2);
  const staff = await w.as('staff');
  const page = await staff.get(`/equipment/labels?location=${w.lab1}`);
  assert.equal(page.status, 200);
  assert.equal((page.text.match(/<svg /g) || []).length, 5);
  assert.ok(page.text.includes('PC-00005'));
  assert.ok(!page.text.includes('PC-00006'));
});
