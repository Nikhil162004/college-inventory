'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, signIn, post, PASSWORD } = require('./helpers');

const tempPassword = (html) => /([A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4})/.exec(html)[1];

test('creating an account shows a one-time temporary password that must be replaced', async () => {
  const w = await makeWorld();
  const admin = await w.as('admin');
  const res = await post(admin, '/users', { college_id: '24it007', name: 'Naya Vidyarthi', role: 'student', department: 'IT', email: '' });
  assert.equal(res.status, 200);
  const temp = tempPassword(res.text);
  const row = w.db.prepare("SELECT * FROM users WHERE college_id = '24IT007'").get();
  assert.equal(row.must_change_password, 1);
  assert.ok(!row.password_hash.includes(temp), 'the password is never stored in readable form');
  const { res: first } = await signIn(w.app, '24IT007', temp);
  assert.equal(first.headers.location, '/account/password');
  // duplicates and bad input
  assert.equal((await post(admin, '/users', { college_id: '24IT007', name: 'Again', role: 'student' })).status, 422);
  assert.equal((await post(admin, '/users', { college_id: 'a b', name: 'Bad Id', role: 'student' })).status, 422);
  assert.equal((await post(admin, '/users', { college_id: 'OK12345', name: 'Bad Role', role: 'superuser' })).status, 422);
  assert.equal((await post(admin, '/users', { college_id: 'OK12345', name: 'Bad Mail', role: 'student', email: 'nope' })).status, 422);
});

test('roster import creates valid rows, skips bad ones and never imports administrators', async () => {
  const w = await makeWorld();
  const admin = await w.as('admin');
  const csv = [
    'College_ID,Name,Role,Department,Email',
    '24CS101,"Deshmukh, Aarav",student,CSE,',
    '24CS102,Meera Kulkarni,Student,CSE,meera@college.example',
    'FAC050,Dr. Anil Joshi,faculty,ECE,',
    '24CS101,Duplicate In File,student,CSE,',
    '23CS001,Already Exists,student,CSE,',
    'ADMIN99,Sneaky Admin,admin,,',
    ',Missing Id,student,,',
    '24CS103,Bad Role,principal,,',
    '=cmd|calc,Formula Id,student,,',
  ].join('\r\n');
  const res = await post(admin, '/users/import', { csv }, '/users/import');
  assert.equal(res.status, 200);
  assert.match(res.text, /3 accounts created/);
  assert.match(res.text, /6 rows skipped/);
  const created = w.db.prepare("SELECT college_id, name, role, must_change_password FROM users WHERE college_id IN ('24CS101','24CS102','FAC050') ORDER BY college_id").all();
  assert.deepEqual(created.map((u) => u.role), ['student', 'student', 'faculty']);
  assert.equal(created[0].name, 'Deshmukh, Aarav');
  assert.ok(created.every((u) => u.must_change_password === 1));
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM users WHERE college_id = 'ADMIN99'").get().n, 0);
  assert.equal(w.db.prepare("SELECT name FROM users WHERE college_id = '23CS001'").get().name, 'Sita Student', 'existing accounts are untouched');
  // an imported person can sign in with the password shown
  const line = /24CS102<\/td><td>[^<]*<\/td><td class="mono">([^<]+)</.exec(res.text);
  assert.equal((await signIn(w.app, '24CS102', line[1])).res.headers.location, '/account/password');
  // header problems and size limits
  assert.equal((await post(admin, '/users/import', { csv: 'name,role\nX Y,student' }, '/users/import')).status, 422);
  assert.equal((await post(admin, '/users/import', { csv: '' }, '/users/import')).status, 422);
  const big = 'college_id,name,role\n' + Array.from({ length: 1001 }, (_, i) => `BIG${i},Person ${i},student`).join('\n');
  assert.equal((await post(admin, '/users/import', { csv: big }, '/users/import')).status, 422);
});

test('importing a full batch of 1000 students works in one go', async () => {
  const w = await makeWorld();
  const admin = await w.as('admin');
  const csv = 'college_id,name,role,department\n' + Array.from({ length: 1000 }, (_, i) => `26ME${String(i).padStart(4, '0')},Student Number ${i},student,Mechanical`).join('\n');
  const res = await post(admin, '/users/import', { csv }, '/users/import');
  assert.equal(res.status, 200);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM users WHERE college_id LIKE '26ME%'").get().n, 1000);
  const list = await admin.get('/users?q=26ME&page=40');
  assert.equal(list.status, 200);
  assert.match(list.text, /976–1,000 of 1,000/);
});

test('resetting a password unlocks the account and signs the person out everywhere', async () => {
  const w = await makeWorld();
  const admin = await w.as('admin');
  const student = await w.as('student');
  w.db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(Date.now() + 600000, w.ids.student);
  const res = await post(admin, `/users/${w.ids.student}/reset-password`);
  assert.equal(res.status, 200);
  const temp = tempPassword(res.text);
  assert.equal((await student.get('/')).status, 302, 'existing session is ended');
  assert.equal((await signIn(w.app, '23CS001', PASSWORD)).res.status, 401, 'old password is gone');
  assert.equal((await signIn(w.app, '23CS001', temp)).res.headers.location, '/account/password');
  const self = await post(admin, `/users/${w.ids.admin}/reset-password`);
  assert.equal(self.status, 302, 'administrators change their own password the normal way');
});

test('role changes and deactivation apply at once; the last administrator is protected', async () => {
  const w = await makeWorld();
  const admin = await w.as('admin');
  const staff = await w.as('staff');
  assert.equal((await staff.get('/equipment/new')).status, 200);
  await post(admin, `/users/${w.ids.staff}`, { name: 'Sam Staff', role: 'student', department: 'CSE', is_active: '1' });
  assert.equal((await staff.get('/equipment/new')).status, 302, 'demoted user is signed out');
  const again = await w.as('staff');
  assert.equal((await again.get('/equipment/new')).status, 403, 'and has the new, lower role');

  // An administrator cannot remove their own access...
  const self = await post(admin, `/users/${w.ids.admin}`, { name: 'Asha Admin', role: 'student', is_active: '1' });
  assert.equal(self.status, 422);
  const selfOff = await post(admin, `/users/${w.ids.admin}`, { name: 'Asha Admin', role: 'admin', is_active: '0' });
  assert.equal(selfOff.status, 422);
  // ...and the last remaining administrator cannot be removed by anyone.
  await post(admin, `/users/${w.ids.admin2}`, { name: 'Second Admin', role: 'admin', is_active: '0' });
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").get().n, 1);
  assert.equal(w.db.prepare("SELECT role FROM users WHERE id = ?").get(w.ids.admin).role, 'admin');
});

test('labs and categories: create, validate, keep codes unique', async () => {
  const w = await makeWorld();
  const admin = await w.as('admin');
  const lab = await post(admin, '/locations', { code: 'lab-07', name: 'Computer Networks Lab', kind: 'lab', building: 'CSE Block', floor: 'Second', incharge_id: String(w.ids.faculty) });
  assert.match(lab.headers.location, /^\/locations\/\d+$/);
  assert.equal(w.db.prepare("SELECT code FROM locations WHERE name = 'Computer Networks Lab'").get().code, 'LAB-07');
  assert.equal((await post(admin, '/locations', { code: 'LAB-07', name: 'Clash', kind: 'lab' })).status, 422);
  assert.equal((await post(admin, '/locations', { code: 'LAB-08', name: 'Bad kind', kind: 'spaceship' })).status, 422);
  assert.equal((await post(admin, '/locations', { code: 'LAB-08', name: 'Student in charge', kind: 'lab', incharge_id: String(w.ids.student) })).status, 422);
  const page = await admin.get(lab.headers.location);
  assert.ok(page.text.includes('Farah Faculty'));

  const cat = await post(admin, '/categories', { name: 'Drone', prefix: 'drn' });
  assert.equal(cat.status, 302);
  assert.equal(w.db.prepare("SELECT prefix FROM categories WHERE name = 'Drone'").get().prefix, 'DRN');
  assert.equal((await post(admin, '/categories', { name: 'Drone 2', prefix: 'DRN' })).status, 422);
  assert.equal((await post(admin, '/categories', { name: 'Bad', prefix: 'D1' })).status, 422);
  const drone = w.db.prepare("SELECT id FROM categories WHERE name = 'Drone'").get().id;
  await post(admin, `/categories/${drone}`, { name: 'Drone & UAV', prefix: 'XXX' });
  const renamed = w.db.prepare('SELECT name, prefix FROM categories WHERE id = ?').get(drone);
  assert.deepEqual(renamed, { name: 'Drone & UAV', prefix: 'DRN' }, 'the prefix can never change');
});

test('the activity log records sign-ins and changes and has no edit or delete route', async () => {
  const w = await makeWorld();
  await signIn(w.app, '23CS001', 'a wrong password');
  const admin = await w.as('admin');
  const pc = w.addPc();
  await post(admin, `/equipment/${pc.id}`, { name: 'Renamed computer', location_id: w.lab1 });
  const page = await admin.get('/audit');
  assert.equal(page.status, 200);
  for (const text of ['Wrong password', 'Signed in', 'Renamed computer', 'login.failed', 'equipment.update']) {
    assert.ok(page.text.includes(text), text);
  }
  assert.equal((await admin.get('/audit?group=login')).status, 200);
  for (const path of ['/audit/1', '/audit/1/delete', '/audit/clear']) {
    assert.equal((await post(admin, path)).status, 404, path);
  }
  const passwords = w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE summary LIKE '%wrong password%' AND summary LIKE '%a wrong password%'").get().n;
  assert.equal(passwords, 0, 'attempted passwords are never written to the log');
});
