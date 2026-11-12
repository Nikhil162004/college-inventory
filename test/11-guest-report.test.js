'use strict';
/**
 * Reporting a problem by scanning the QR label, without an account.
 * Anyone holding the label can open the form; everything else on the site still
 * needs a sign-in, and what arrives is treated as untrusted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { makeWorld, request, token, post } = require('./helpers');
const { openDb } = require('../src/db');

const GOOD = {
  issue_type: 'not_working',
  description: 'Does not switch on, no light on the front panel.',
  reporter_name: 'Priya Patil',
  reporter_ref: '23CS117',
};
const count = (w, where = '1=1') => w.db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE ${where}`).get().n;

/** Opens the form like a phone that has just scanned the label, and sends it. */
async function send(agent, tag, data = GOOD) {
  const csrf = await token(agent, '/e/' + tag);
  return agent.post(`/e/${tag}/report`).type('form').send({ _csrf: csrf, ...data });
}

test('scanning without an account opens the report form for exactly that item', async () => {
  const w = await makeWorld();
  const pc = w.addPc('Desktop computer');
  w.db.prepare("UPDATE equipment SET serial_no = 'SN-PRIVATE-77', purchase_cost = 55555, vendor = 'Private Vendor Ltd', notes = 'internal note' WHERE id = ?").run(pc.id);
  const page = await request(w.app).get('/e/' + pc.asset_tag.toLowerCase());
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(pc.asset_tag));
  assert.match(page.text, /Desktop computer/);
  assert.match(page.text, /Central Computing Centre/);
  assert.match(page.text, new RegExp(`action="/e/${pc.asset_tag}/report"`));
  assert.match(page.text, /name="_csrf" value="[^"]{20,}"/);
  assert.match(page.text, /name="reporter_name"/);
  assert.match(page.headers['cache-control'], /no-store/);
  // only what is needed to recognise the item; nothing from the register itself
  assert.doesNotMatch(page.text, /SN-PRIVATE-77|55555|Private Vendor|internal note/);
  assert.doesNotMatch(page.text, /href="\/(equipment|reports|users|audit|locations)/);
});

test('a report sent without an account is saved and reaches the staff and the administrator', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const res = await send(request.agent(w.app), pc.asset_tag);
  assert.equal(res.status, 303);
  assert.match(res.headers.location, new RegExp(`^/e/${pc.asset_tag}/sent\\?r=\\d+&k=[\\w-]{16,}$`));

  const row = w.db.prepare('SELECT * FROM reports').get();
  assert.equal(row.reporter_id, null);
  assert.equal(row.guest_name, 'Priya Patil');
  assert.equal(row.guest_ref, '23CS117');
  assert.equal(row.status, 'open');
  assert.equal(row.equipment_id, pc.id);
  assert.equal(w.db.prepare('SELECT status FROM equipment WHERE id = ?').get(pc.id).status, 'issue_reported');

  // the receipt needs no cookie, so it survives a refresh and a browser that keeps nothing
  const receipt = await request(w.app).get(res.headers.location);
  assert.equal(receipt.status, 200);
  assert.match(receipt.text, /R-00001/);
  assert.match(receipt.text, new RegExp(pc.asset_tag));

  const staff = await w.as('staff');
  const list = await staff.get('/reports');
  assert.match(list.text, /Priya Patil/);
  assert.match(list.text, /not signed in/i);
  const detail = await staff.get('/reports/' + row.id);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Priya Patil/);
  assert.match(detail.text, /23CS117/);
  assert.match(detail.text, /not signed in/i);
  assert.match(detail.text, /Does not switch on/);
  assert.match((await staff.get('/equipment/' + pc.id)).text, /Priya Patil/);

  const admin = await w.as('admin');
  const overview = await admin.get('/');
  assert.match(overview.text, new RegExp(pc.asset_tag), 'listed on the administrator overview');
  const log = w.db.prepare("SELECT * FROM audit_log WHERE action = 'report.guest'").get();
  assert.equal(log.actor, 'guest');
  assert.equal(log.user_id, null);
  assert.equal(log.entity_id, pc.id);
  assert.ok(log.ip, 'the network address is recorded');
  assert.match((await admin.get('/audit')).text, /without signing in/i);
});

test('staff can take a guest report through to resolved, which returns the item to working', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  await send(request.agent(w.app), pc.asset_tag);
  const staff = await w.as('staff');
  const started = await post(staff, '/reports/1/update', { status: 'in_progress', assigned_to: '', note: '' }, '/reports/1');
  assert.equal(started.status, 302);
  assert.equal(w.db.prepare('SELECT status FROM equipment WHERE id = ?').get(pc.id).status, 'under_repair');
  const done = await post(staff, '/reports/1/update', { status: 'resolved', assigned_to: '', note: 'Power supply replaced.' }, '/reports/1');
  assert.equal(done.status, 302);
  assert.equal(w.db.prepare('SELECT status FROM equipment WHERE id = ?').get(pc.id).status, 'working');
});

test('what the visitor types is checked, kept on the page, and never trusted', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const agent = request.agent(w.app);

  const empty = await send(agent, pc.asset_tag, { description: 'The screen flickers badly after ten minutes.', reporter_name: '', reporter_ref: '' });
  assert.equal(empty.status, 422);
  assert.match(empty.text, /The screen flickers badly after ten minutes\./, 'their text is still there');
  assert.match(empty.text, /Choose what is wrong/);
  assert.match(empty.text, /Enter your name/);

  assert.equal((await send(agent, pc.asset_tag, { ...GOOD, description: 'broken' })).status, 422);
  assert.equal((await send(agent, pc.asset_tag, { ...GOOD, issue_type: 'made_up' })).status, 422);
  assert.equal((await send(agent, pc.asset_tag, { ...GOOD, reporter_name: 'x'.repeat(81) })).status, 422);
  assert.equal((await send(agent, pc.asset_tag, { ...GOOD, reporter_ref: 'y'.repeat(41) })).status, 422);
  assert.equal((await send(agent, pc.asset_tag, { ...GOOD, description: 'z'.repeat(1001) })).status, 422);
  assert.equal(count(w), 0, 'nothing was saved');

  const nasty = await send(agent, pc.asset_tag, { ...GOOD, reporter_name: '<script>alert(1)</script>', reporter_ref: '"><img src=x>',
    description: "<b>bold</b> ' OR 1=1 -- and a long enough sentence" });
  assert.equal(nasty.status, 303);
  const staff = await w.as('staff');
  for (const page of ['/reports', '/reports/1', '/equipment/' + pc.id]) {
    const html = (await staff.get(page)).text;
    assert.doesNotMatch(html, /<script>alert|<img src=x>|<b>bold/, page);
    assert.match(html, /&lt;script&gt;alert/, page);
  }
  assert.doesNotMatch((await (await w.as('admin')).get('/audit')).text, /<script>alert/);
});

test('a form sent from another website is refused, and nothing the visitor typed is lost', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const agent = request.agent(w.app);
  await agent.get('/e/' + pc.asset_tag);
  const forged = await agent.post(`/e/${pc.asset_tag}/report`).set('Sec-Fetch-Site', 'cross-site').type('form').send(GOOD);
  assert.equal(forged.status, 403);
  assert.equal(count(w), 0);
  assert.match(forged.text, /Does not switch on, no light on the front panel\./);
  assert.match(forged.text, /Priya Patil/);
  const fresh = /name="_csrf" value="([^"]+)"/.exec(forged.text)[1];
  const again = await agent.post(`/e/${pc.asset_tag}/report`).type('form').send({ _csrf: fresh, ...GOOD });
  assert.equal(again.status, 303, 'pressing Send again on the refreshed form works');
  assert.equal(count(w), 1);

  // no token and no word from the browser about where the form came from: refused as well
  const bare = await request(w.app).post(`/e/${pc.asset_tag}/report`).type('form').send({ ...GOOD, reporter_name: 'Someone Else' });
  assert.equal(bare.status, 403);
  assert.equal(count(w), 1);
});

test('a phone whose browser keeps no cookies can still report from the page it scanned', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  // no cookie jar at all; the browser states that the form came from this site's own page
  const res = await request(w.app).post(`/e/${pc.asset_tag}/report`).set('Sec-Fetch-Site', 'same-origin').type('form')
    .send({ _csrf: 'left-over-from-an-old-page', ...GOOD });
  assert.equal(res.status, 303);
  assert.equal(count(w), 1);
  assert.equal((await request(w.app).get(res.headers.location)).status, 200);
});

test('receipts cannot be guessed, altered or used to read other reports', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const other = w.addPc('Projector');
  const res = await send(request.agent(w.app), pc.asset_tag);
  const good = res.headers.location;
  const key = /k=([\w-]+)/.exec(good)[1];
  assert.equal((await request(w.app).get(`/e/${pc.asset_tag}/sent?r=1&k=${key.slice(0, -1)}A`)).status, 404);
  assert.equal((await request(w.app).get(`/e/${pc.asset_tag}/sent?r=1`)).status, 404);
  assert.equal((await request(w.app).get(`/e/${pc.asset_tag}/sent?r=2&k=${key}`)).status, 404);
  assert.equal((await request(w.app).get(`/e/${other.asset_tag}/sent?r=1&k=${key}`)).status, 404, 'bound to the item as well');
  // a signed-in student's own report has no public receipt
  const student = await w.as('student');
  await post(student, `/equipment/${other.id}/report`, { issue_type: 'damaged', description: 'Lens cover is cracked on one side.' }, `/equipment/${other.id}/report`);
  assert.equal((await request(w.app).get(`/e/${other.asset_tag}/sent?r=2&k=${key}`)).status, 404);
  const receipt = (await request(w.app).get(good)).text;
  assert.doesNotMatch(receipt, /Priya Patil|23CS117|Does not switch on/, 'the receipt repeats nothing personal');
});

test('pressing Send twice does not create two reports', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const agent = request.agent(w.app);
  const first = await send(agent, pc.asset_tag);
  const second = await send(agent, pc.asset_tag);
  assert.equal(second.status, 303);
  assert.equal(second.headers.location, first.headers.location);
  assert.equal(count(w), 1);
});

test('one item cannot be buried in reports', async () => {
  const w = await makeWorld({ guestReportsPerItem: 2 });
  const pc = w.addPc();
  const agent = request.agent(w.app);
  assert.equal((await send(agent, pc.asset_tag, { ...GOOD, reporter_name: 'First Person' })).status, 303);
  const before = await agent.get('/e/' + pc.asset_tag);
  assert.match(before.text, /Already reported/);
  assert.match(before.text, /name="description"/, 'a different problem can still be added');
  assert.equal((await send(agent, pc.asset_tag, { ...GOOD, reporter_name: 'Second Person', description: 'Keyboard keys are missing as well.' })).status, 303);

  const full = await agent.get('/e/' + pc.asset_tag);
  assert.equal(full.status, 200);
  assert.match(full.text, /already been reported/i);
  assert.doesNotMatch(full.text, /name="description"/, 'no form once the staff have been told enough times');
  const third = await agent.post(`/e/${pc.asset_tag}/report`).set('Sec-Fetch-Site', 'same-origin').type('form')
    .send({ ...GOOD, reporter_name: 'Third Person', description: 'Mouse is missing too, since Monday.' });
  assert.equal(third.status, 429);
  assert.equal(count(w), 2);

  // signed-in people are not blocked by it, and closing reports frees the item again
  const student = await w.as('student');
  const own = await post(student, `/equipment/${pc.id}/report`, { issue_type: 'damaged', description: 'Side panel is bent and loose.' }, `/equipment/${pc.id}/report`);
  assert.equal(own.status, 302);
  w.db.prepare("UPDATE reports SET status = 'resolved'").run();
  assert.match((await agent.get('/e/' + pc.asset_tag)).text, /name="description"/);
});

test('one network address cannot flood the register', async () => {
  const w = await makeWorld({ guestReportsPerHour: 2 });
  const items = [w.addPc('PC one'), w.addPc('PC two'), w.addPc('PC three')];
  const agent = request.agent(w.app);
  assert.equal((await send(agent, items[0].asset_tag)).status, 303);
  assert.equal((await send(agent, items[1].asset_tag)).status, 303);
  const third = await send(agent, items[2].asset_tag);
  assert.equal(third.status, 429);
  assert.match(third.text, /Does not switch on/, 'their text is kept for later');
  assert.match(third.text, /in person/i);
  assert.equal(count(w), 2);
  // an hour later it is accepted again
  w.db.prepare("UPDATE audit_log SET created_at = created_at - 3700000 WHERE action = 'report.guest'").run();
  w.db.prepare('UPDATE reports SET created_at = created_at - 3700000').run();
  assert.equal((await send(agent, items[2].asset_tag)).status, 303);
});

test('automatic form-fillers are turned away', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const res = await send(request.agent(w.app), pc.asset_tag, { ...GOOD, leave_blank: 'http://spam.example' });
  assert.equal(res.status, 400);
  assert.equal(count(w), 0);
});

test('unknown labels and written-off items take no reports', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const agent = request.agent(w.app);
  const unknown = await agent.get('/e/PC-99999');
  assert.equal(unknown.status, 404);
  assert.doesNotMatch(unknown.text, /name="description"/);
  assert.equal((await agent.get("/e/PC-1'--")).status, 404);
  assert.equal((await agent.get('/e/%3Cscript%3E')).status, 404);
  const csrf = await token(agent, '/e/' + pc.asset_tag);
  assert.equal((await agent.post('/e/PC-99999/report').type('form').send({ _csrf: csrf, ...GOOD })).status, 404);

  w.db.prepare("UPDATE equipment SET status = 'retired', retired_reason = 'Beyond repair' WHERE id = ?").run(pc.id);
  const gone = await agent.get('/e/' + pc.asset_tag);
  assert.equal(gone.status, 200);
  assert.match(gone.text, /no longer in use/i);
  assert.doesNotMatch(gone.text, /name="description"|Beyond repair/);
  const refused = await agent.post(`/e/${pc.asset_tag}/report`).type('form').send({ _csrf: csrf, ...GOOD });
  assert.equal(refused.status, 410);
  assert.equal(count(w), 0);
});

test('a visitor gets the form and nothing else', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const agent = request.agent(w.app);
  await send(agent, pc.asset_tag);
  for (const page of ['/', '/reports', '/reports/1', '/equipment', '/equipment/' + pc.id, `/equipment/${pc.id}/report`,
    '/equipment/labels', '/equipment/export.csv', '/users', '/audit', '/locations', '/categories', '/account']) {
    const res = await agent.get(page);
    assert.equal(res.status, 302, page);
    assert.match(res.headers.location, /^\/login/, page);
  }
  const csrf = await token(agent, '/e/' + pc.asset_tag);
  const write = await agent.post('/reports/1/update').type('form').send({ _csrf: csrf, status: 'resolved', note: 'self-service' });
  assert.match(write.headers.location || '', /^\/login/);
  assert.equal(w.db.prepare('SELECT status FROM reports WHERE id = 1').get().status, 'open');
});

test('people who are signed in keep their own flow, with their name on the report', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  const student = await w.as('student');
  const scan = await student.get('/e/' + pc.asset_tag);
  assert.equal(scan.status, 302);
  assert.equal(scan.headers.location, '/equipment/' + pc.id);
  const csrf = await token(student, `/equipment/${pc.id}/report`);
  const wrongDoor = await student.post(`/e/${pc.asset_tag}/report`).type('form').send({ _csrf: csrf, ...GOOD });
  assert.equal(wrongDoor.status, 303);
  assert.equal(wrongDoor.headers.location, '/e/' + pc.asset_tag);
  assert.equal(count(w), 0, 'no anonymous report is created for someone who is signed in');
  // a student cannot read a guest report through "my reports"
  await send(request.agent(w.app), pc.asset_tag);
  assert.equal((await student.get('/reports/1')).status, 404);
  assert.doesNotMatch((await student.get('/reports')).text, /Priya Patil/);
});

test('the label number can be typed on the sign-in page when a camera is not at hand', async () => {
  const w = await makeWorld();
  w.addPc();
  const login = await request(w.app).get('/login');
  assert.match(login.text, /action="\/find"/);
  assert.match(login.text, /name="tag"/);
  const found = await request(w.app).get('/find').query({ tag: ' pc-00001 ' });
  assert.equal(found.status, 302);
  assert.equal(found.headers.location, '/e/PC-00001');
  assert.equal((await request(w.app).get('/find')).headers.location, '/login');
});

test('switched off, scanning asks for a sign-in exactly as before', async () => {
  const w = await makeWorld({ guestReports: false });
  const pc = w.addPc();
  const scan = await request(w.app).get('/e/' + pc.asset_tag);
  assert.equal(scan.status, 302);
  assert.equal(scan.headers.location, '/login?next=' + encodeURIComponent('/e/' + pc.asset_tag));
  const agent = request.agent(w.app);
  const csrf = await token(agent, '/login');
  const res = await agent.post(`/e/${pc.asset_tag}/report`).type('form').send({ _csrf: csrf, ...GOOD });
  assert.match(res.headers.location || '', /^\/login/);
  const sameSite = await request(w.app).post(`/e/${pc.asset_tag}/report`).set('Sec-Fetch-Site', 'same-origin').type('form').send(GOOD);
  assert.match(sameSite.headers.location || '', /^\/login/);
  assert.equal(count(w), 0);
  assert.doesNotMatch((await request(w.app).get('/login')).text, /action="\/find"/);
  assert.match((await request(w.app).get('/find').query({ tag: 'PC-00001' })).headers.location, /^\/login/);
  assert.equal((await request(w.app).get(`/e/${pc.asset_tag}/sent?r=1&k=abcdefghijklmnopqrstuv`)).status, 302);
});

test('staff are told on the item page that the label can be used without an account', async () => {
  const on = await makeWorld();
  const pc = on.addPc();
  assert.match((await (await on.as('staff')).get('/equipment/' + pc.id)).text, /without signing in/i);
  const off = await makeWorld({ guestReports: false });
  const pc2 = off.addPc();
  assert.doesNotMatch((await (await off.as('staff')).get('/equipment/' + pc2.id)).text, /without signing in/i);
});

// ---- upgrading a register that was created before this feature -----------------

const OLD_REPORTS = `CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  reporter_id  INTEGER NOT NULL REFERENCES users(id),
  issue_type   TEXT    NOT NULL
               CHECK (issue_type IN ('not_working','damaged','missing_part','software','network','other')),
  description  TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','in_progress','resolved','rejected')),
  assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  closed_at    INTEGER
);`;

function oldDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-old-'));
  const file = path.join(dir, 'register.db');
  const current = fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8');
  const start = current.indexOf('CREATE TABLE IF NOT EXISTS reports (');
  const end = current.indexOf(');', start) + 2;
  assert.ok(start > 0 && end > start);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(current.slice(0, start) + OLD_REPORTS + current.slice(end));
  db.prepare("INSERT INTO users (id, college_id, name, role, password_hash, created_at) VALUES (1, 'STF001', 'Sam Staff', 'staff', 'x', 1), (2, '23CS001', 'Sita Student', 'student', 'x', 1)").run();
  db.prepare("INSERT INTO locations (id, code, name, kind, created_at) VALUES (1, 'LAB-01', 'Lab', 'lab', 1)").run();
  db.prepare("INSERT INTO categories (id, name, prefix, next_seq) VALUES (1, 'Desktop computer', 'PC', 3)").run();
  db.prepare("INSERT INTO equipment (id, asset_tag, name, category_id, location_id, status, created_at, updated_at) VALUES (1, 'PC-00001', 'PC', 1, 1, 'under_repair', 1, 1), (2, 'PC-00002', 'PC', 1, 1, 'working', 1, 1)").run();
  db.prepare("INSERT INTO reports (id, equipment_id, reporter_id, issue_type, description, status, assigned_to, created_at, updated_at, closed_at) VALUES (7, 1, 2, 'not_working', 'Will not start at all.', 'in_progress', 1, 1000, 2000, NULL), (9, 2, 2, 'software', 'Compiler missing.', 'resolved', NULL, 3000, 4000, 4000)").run();
  db.prepare("INSERT INTO report_updates (id, report_id, user_id, from_status, to_status, note, created_at) VALUES (1, 7, 2, NULL, 'open', NULL, 1000), (2, 7, 1, 'open', 'in_progress', 'Looking at it', 2000), (3, 9, 2, NULL, 'open', NULL, 3000)").run();
  const before = { reports: db.prepare('SELECT * FROM reports ORDER BY id').all(), updates: db.prepare('SELECT * FROM report_updates ORDER BY id').all() };
  db.close();
  return { dir, file, before };
}

test('a register created before this feature is upgraded in place without losing a single report', () => {
  const { dir, file, before } = oldDatabase();
  try {
    let db = openDb(file);
    const columns = db.prepare('PRAGMA table_info(reports)').all();
    const col = (name) => columns.find((c) => c.name === name);
    assert.ok(col('guest_name') && col('guest_ref'));
    assert.equal(col('reporter_id').notnull, 0, 'a report may now have no account behind it');
    const after = db.prepare('SELECT id, equipment_id, reporter_id, issue_type, description, status, assigned_to, created_at, updated_at, closed_at FROM reports ORDER BY id').all();
    assert.deepEqual(after, before.reports);
    assert.deepEqual(db.prepare('SELECT * FROM report_updates ORDER BY id').all(), before.updates);
    assert.equal(db.prepare('SELECT MAX(id) AS m FROM reports').get().m, 9);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reports'").all().map((r) => r.name);
    for (const name of ['idx_reports_equipment', 'idx_reports_reporter', 'idx_reports_status']) assert.ok(indexes.includes(name), name);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'reports_%' AND type = 'table'").get().n, 0, 'no work table left behind');

    // the rules still hold after the upgrade
    const add = db.prepare('INSERT INTO reports (equipment_id, reporter_id, guest_name, issue_type, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)');
    assert.equal(Number(add.run(1, null, 'A Visitor', 'damaged', 'Cracked.').lastInsertRowid), 10, 'numbering continues');
    assert.throws(() => add.run(1, null, null, 'damaged', 'Nobody at all.'), /CHECK/);
    assert.throws(() => add.run(999, 2, null, 'damaged', 'No such item.'), /FOREIGN KEY/);
    assert.throws(() => add.run(1, 999, null, 'damaged', 'No such person.'), /FOREIGN KEY/);
    assert.throws(() => add.run(1, 2, null, 'nonsense', 'Bad type.'), /CHECK/);
    db.prepare('DELETE FROM reports WHERE id = 9').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_updates WHERE report_id = 9').get().n, 0, 'updates still follow their report');
    db.close();

    db = openDb(file); // opening again changes nothing
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 2);
    assert.equal(db.prepare('SELECT description FROM reports WHERE id = 7').get().description, 'Will not start at all.');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the upgraded register runs the whole site', async () => {
  const { dir, file } = oldDatabase();
  try {
    const db = openDb(file);
    const { createApp } = require('../src/app');
    const { buildConfig } = require('../src/config');
    const app = createApp({ db, config: buildConfig({ dbPath: file, sessionSecret: 'test-secret-test-secret-test-secret-1234' }) });
    const agent = request.agent(app);
    const res = await send(agent, 'PC-00002');
    assert.equal(res.status, 303);
    const saved = db.prepare('SELECT * FROM reports WHERE reporter_id IS NULL').get();
    assert.equal(saved.id, 10);
    assert.equal(saved.guest_name, 'Priya Patil');
    assert.equal(db.prepare('SELECT status FROM equipment WHERE id = 2').get().status, 'issue_reported');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
