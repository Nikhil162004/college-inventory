'use strict';
const express = require('express');
const v = require('../lib/validate');
const { z } = v;
const { requirePermission } = require('../middleware/auth');
const { describeChanges } = require('../lib/audit');
const { parseCsv } = require('../lib/csv');
const { ROLE } = require('../lib/format');
const passwords = require('../security/password');
const wrap = require('../lib/wrap');

const IMPORT_MAX_ROWS = 1000;
const IMPORT_COLUMNS = ['college_id', 'name', 'role', 'department', 'email'];

const collegeId = z.string().trim().toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{2,19}$/, 'Use 3–20 letters, digits or hyphens');
const profile = {
  name: v.text(100, 2),
  email: v.optEmail,
  role: v.oneOf(Object.keys(ROLE), 'Choose a role'),
  department: v.optText(60),
};
const createSchema = z.object({ college_id: collegeId, ...profile });
const editSchema = z.object({ ...profile, is_active: v.oneOf(['0', '1']).transform(Number) });
const filterSchema = z.object({
  q: z.string().trim().max(80).catch(''),
  role: z.string().refine((s) => s === '' || s in ROLE).catch(''),
  page: v.page,
});

module.exports = function userRoutes({ db, config, audit, store }) {
  const r = express.Router();
  r.use(requirePermission('users.manage'));

  const q = {
    one: db.prepare('SELECT id, college_id, name, email, role, department, is_active, must_change_password, locked_until, last_login_at, created_at FROM users WHERE id = ?'),
    byCollegeId: db.prepare('SELECT id FROM users WHERE college_id = ?'),
    insert: db.prepare(
      `INSERT INTO users (college_id, name, email, role, department, password_hash, must_change_password, created_at)
       VALUES (@college_id, @name, @email, @role, @department, @password_hash, 1, @now)`
    ),
    update: db.prepare('UPDATE users SET name=@name, email=@email, role=@role, department=@department, is_active=@is_active WHERE id=@id'),
    resetPassword: db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?'),
    activeAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1"),
  };

  function findOr404(req) {
    const id = /^[1-9]\d{0,8}$/.test(req.params.id) ? Number(req.params.id) : 0;
    const person = q.one.get(id);
    if (!person) { const err = new Error('Not found'); err.status = 404; throw err; }
    return person;
  }
  const renderForm = (res, status, person, values, errors) =>
    res.status(status).render('users/form', {
      title: person ? `Edit ${person.college_id}` : 'Add person', person, values, errors: errors || {},
    });

  // ---- List -----------------------------------------------------------------
  r.get('/', (req, res) => {
    const f = v.check(filterSchema, req.query).data;
    const where = [];
    const params = {};
    if (f.q) {
      where.push(`(college_id LIKE @q ESCAPE '\\' OR name LIKE @q ESCAPE '\\' OR department LIKE @q ESCAPE '\\')`);
      params.q = v.likePattern(f.q);
    }
    if (f.role) { where.push('role = @role'); params.role = f.role; }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM users ${whereSql}`).get(params).n;
    const pg = v.paginate(total, f.page, config.pageSize);
    const people = db.prepare(
      `SELECT id, college_id, name, role, department, is_active, last_login_at FROM users ${whereSql}
       ORDER BY role = 'student', college_id LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit: pg.pageSize, offset: pg.offset });
    res.render('users/list', { title: 'People', people, pg, filter: f });
  });

  // ---- Add one person -------------------------------------------------------------
  r.get('/new', (req, res) => renderForm(res, 200, null, { role: 'student' }));

  r.post('/', wrap(async (req, res) => {
    const { data, errors } = v.check(createSchema, req.body);
    const problems = errors || {};
    if (data && q.byCollegeId.get(data.college_id)) problems.college_id = 'This college ID already has an account';
    if (Object.keys(problems).length) return renderForm(res, 422, null, req.body, problems);

    const temp = passwords.generateTemporaryPassword();
    const id = Number(q.insert.run({ ...data, password_hash: await passwords.hashTemporary(temp), now: Date.now() }).lastInsertRowid);
    audit(req, 'user.create', 'user', id, `Created ${ROLE[data.role]} account ${data.college_id}`);
    res.render('users/credentials', {
      title: 'Account created', heading: 'Account created',
      rows: [{ college_id: data.college_id, name: data.name, password: temp }], skipped: [],
    });
  }));

  // ---- Import a roster (CSV) --------------------------------------------------------
  r.get('/import', (req, res) => {
    res.render('users/import', { title: 'Import roster', error: null, csv: '', maxRows: IMPORT_MAX_ROWS });
  });

  r.post('/import', wrap(async (req, res) => {
    const csv = typeof req.body.csv === 'string' ? req.body.csv : '';
    const fail = (error) => res.status(422).render('users/import', { title: 'Import roster', error, csv, maxRows: IMPORT_MAX_ROWS });
    const rows = parseCsv(csv);
    if (rows.length < 2) return fail('Paste or load a CSV file with a header row and at least one person.');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    for (const col of ['college_id', 'name', 'role']) {
      if (!header.includes(col)) return fail(`The header row must contain the column “${col}”. Expected columns: ${IMPORT_COLUMNS.join(', ')}.`);
    }
    const body = rows.slice(1);
    if (body.length > IMPORT_MAX_ROWS) return fail(`A single import may contain at most ${IMPORT_MAX_ROWS} people. Split the file and import it in parts.`);

    const accepted = [];
    const skipped = [];
    const seen = new Set();
    body.forEach((cells, i) => {
      const record = {};
      IMPORT_COLUMNS.forEach((col) => {
        const at = header.indexOf(col);
        record[col] = at >= 0 && cells[at] !== undefined ? cells[at].trim() : '';
      });
      record.role = record.role.toLowerCase();
      const { data, errors } = v.check(createSchema, record);
      const line = i + 2;
      if (errors) {
        const [field, message] = Object.entries(errors)[0];
        skipped.push({ line, college_id: record.college_id, reason: `${field}: ${message}` });
      } else if (data.role === 'admin') {
        skipped.push({ line, college_id: data.college_id, reason: 'Administrator accounts cannot be imported. Add them one at a time.' });
      } else if (seen.has(data.college_id)) {
        skipped.push({ line, college_id: data.college_id, reason: 'Appears more than once in this file' });
      } else if (q.byCollegeId.get(data.college_id)) {
        skipped.push({ line, college_id: data.college_id, reason: 'Already has an account' });
      } else {
        seen.add(data.college_id);
        accepted.push(data);
      }
    });

    // Hash in small parallel batches so the server stays responsive.
    for (let i = 0; i < accepted.length; i += 8) {
      await Promise.all(accepted.slice(i, i + 8).map(async (person) => {
        person.password = passwords.generateTemporaryPassword();
        person.password_hash = await passwords.hashTemporary(person.password);
      }));
    }
    const created = [];
    db.transaction(() => {
      const now = Date.now();
      for (const p of accepted) {
        if (q.byCollegeId.get(p.college_id)) { // created by someone else while we were hashing
          skipped.push({ line: '—', college_id: p.college_id, reason: 'Already has an account' });
          continue;
        }
        q.insert.run({ college_id: p.college_id, name: p.name, email: p.email, role: p.role, department: p.department, password_hash: p.password_hash, now });
        created.push({ college_id: p.college_id, name: p.name, password: p.password });
      }
    })();
    audit(req, 'user.import', null, null, `Imported ${created.length} accounts from a roster (${skipped.length} rows skipped)`);
    res.render('users/credentials', {
      title: 'Import finished', heading: `${created.length} account${created.length === 1 ? '' : 's'} created`, rows: created, skipped,
    });
  }));

  // ---- Edit -----------------------------------------------------------------------
  r.get('/:id/edit', (req, res) => {
    const person = findOr404(req);
    renderForm(res, 200, person, person);
  });

  r.post('/:id', (req, res) => {
    const person = findOr404(req);
    const { data, errors } = v.check(editSchema, req.body);
    const problems = errors || {};
    if (data) {
      const losesAdmin = person.role === 'admin' && person.is_active && (data.role !== 'admin' || !data.is_active);
      if (losesAdmin && person.id === req.user.id) {
        problems.role = 'You cannot remove your own administrator access. Ask another administrator.';
      } else if (losesAdmin && q.activeAdmins.get().n <= 1) {
        problems.role = 'At least one active administrator is required.';
      }
    }
    if (Object.keys(problems).length) return renderForm(res, 422, person, req.body, problems);

    q.update.run({ ...data, id: person.id });
    if (!data.is_active || data.role !== person.role) store.destroyUserSessions(person.id); // takes effect at once
    const changes = describeChanges(person, data, { name: 'name', email: 'email', role: 'role', department: 'department', is_active: 'active' });
    if (changes) audit(req, 'user.update', 'user', person.id, `${person.college_id}: ${changes}`);
    req.flash('ok', changes ? 'Changes saved.' : 'Nothing was changed.');
    res.redirect('/users/' + person.id + '/edit');
  });

  // ---- Reset password (also unlocks a locked account) -------------------------------
  r.post('/:id/reset-password', wrap(async (req, res) => {
    const person = findOr404(req);
    if (person.id === req.user.id) {
      req.flash('error', 'Use “Change password” under My account for your own password.');
      return res.redirect('/users/' + person.id + '/edit');
    }
    const temp = passwords.generateTemporaryPassword();
    q.resetPassword.run(await passwords.hashTemporary(temp), person.id);
    store.destroyUserSessions(person.id);
    audit(req, 'password.reset', 'user', person.id, `Reset the password of ${person.college_id}`);
    res.render('users/credentials', {
      title: 'Password reset', heading: 'Password reset',
      rows: [{ college_id: person.college_id, name: person.name, password: temp }], skipped: [],
    });
  }));

  return r;
};
