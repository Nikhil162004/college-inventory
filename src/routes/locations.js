'use strict';
const express = require('express');
const v = require('../lib/validate');
const { z } = v;
const { requirePermission } = require('../middleware/auth');
const { describeChanges } = require('../lib/audit');
const { KIND } = require('../lib/format');

const schema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,14}$/, 'Use 2–15 letters, digits or hyphens, e.g. LAB-07'),
  name: v.text(100),
  kind: v.oneOf(Object.keys(KIND)),
  building: v.optText(80),
  floor: v.optText(40),
  incharge_id: v.optId,
  notes: v.optText(500),
});

module.exports = function locationRoutes({ db, config, audit }) {
  const r = express.Router();
  const q = {
    list: db.prepare(
      `SELECT l.id, l.code, l.name, l.kind, l.building, l.floor, u.name AS incharge,
              COUNT(e.id) AS total,
              COALESCE(SUM(e.status IN ('issue_reported','under_repair')), 0) AS faulty
       FROM locations l LEFT JOIN users u ON u.id = l.incharge_id
       LEFT JOIN equipment e ON e.location_id = l.id AND e.status <> 'retired'
       GROUP BY l.id ORDER BY (l.kind = 'lab') DESC, l.code`
    ),
    one: db.prepare(
      `SELECT l.*, u.name AS incharge, u.college_id AS incharge_college_id FROM locations l
       LEFT JOIN users u ON u.id = l.incharge_id WHERE l.id = ?`
    ),
    byCode: db.prepare('SELECT id FROM locations WHERE code = ?'),
    breakdown: db.prepare(
      `SELECT c.id, c.name, COUNT(*) AS total,
              SUM(e.status = 'working') AS working,
              SUM(e.status IN ('issue_reported','under_repair')) AS faulty
       FROM equipment e JOIN categories c ON c.id = e.category_id
       WHERE e.location_id = ? AND e.status <> 'retired' GROUP BY c.id ORDER BY total DESC, c.name`
    ),
    faulty: db.prepare(
      `SELECT e.id, e.asset_tag, e.name, e.status FROM equipment e
       WHERE e.location_id = ? AND e.status IN ('issue_reported','under_repair') ORDER BY e.asset_tag LIMIT 50`
    ),
    people: db.prepare("SELECT id, name, college_id FROM users WHERE role IN ('admin','staff','faculty') AND is_active = 1 ORDER BY name"),
    person: db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('admin','staff','faculty') AND is_active = 1"),
    insert: db.prepare(
      `INSERT INTO locations (code, name, kind, building, floor, incharge_id, notes, created_at)
       VALUES (@code, @name, @kind, @building, @floor, @incharge_id, @notes, @now)`
    ),
    update: db.prepare(
      `UPDATE locations SET code=@code, name=@name, kind=@kind, building=@building, floor=@floor,
         incharge_id=@incharge_id, notes=@notes WHERE id=@id`
    ),
  };

  const browse = requirePermission('equipment.browse');
  const manage = requirePermission('locations.manage');

  function findOr404(req) {
    const id = /^[1-9]\d{0,8}$/.test(req.params.id) ? Number(req.params.id) : 0;
    const loc = q.one.get(id);
    if (!loc) { const err = new Error('Not found'); err.status = 404; throw err; }
    return loc;
  }
  function renderForm(res, status, loc, values, errors) {
    res.status(status).render('locations/form', {
      title: loc ? `Edit ${loc.code}` : 'Add lab or room', loc, values, errors: errors || {}, people: q.people.all(),
    });
  }
  function validate(body, currentId) {
    const { data, errors } = v.check(schema, body);
    const problems = errors || {};
    if (data) {
      const clash = q.byCode.get(data.code);
      if (clash && clash.id !== currentId) problems.code = 'Another lab or room already uses this code';
      if (data.incharge_id && !q.person.get(data.incharge_id)) problems.incharge_id = 'Choose a member of faculty or staff';
    }
    return { data, problems, ok: !Object.keys(problems).length };
  }

  r.get('/', browse, (req, res) => {
    res.render('locations/list', { title: 'Labs & rooms', locations: q.list.all() });
  });

  r.get('/new', manage, (req, res) => renderForm(res, 200, null, { kind: 'lab' }));

  r.post('/', manage, (req, res) => {
    const { data, problems, ok } = validate(req.body, 0);
    if (!ok) return renderForm(res, 422, null, req.body, problems);
    const id = Number(q.insert.run({ ...data, now: Date.now() }).lastInsertRowid);
    audit(req, 'location.create', 'location', id, `Added ${data.code} “${data.name}”`);
    req.flash('ok', `${data.code} added.`);
    res.redirect('/locations/' + id);
  });

  r.get('/:id', browse, (req, res) => {
    const loc = findOr404(req);
    const breakdown = q.breakdown.all(loc.id);
    res.render('locations/detail', {
      title: `${loc.code} · ${loc.name}`, loc, breakdown, faulty: q.faulty.all(loc.id),
      total: breakdown.reduce((n, b) => n + b.total, 0),
    });
  });

  r.get('/:id/edit', manage, (req, res) => {
    const loc = findOr404(req);
    renderForm(res, 200, loc, loc);
  });

  r.post('/:id', manage, (req, res) => {
    const loc = findOr404(req);
    const { data, problems, ok } = validate(req.body, loc.id);
    if (!ok) return renderForm(res, 422, loc, req.body, problems);
    q.update.run({ ...data, id: loc.id });
    const changes = describeChanges(loc, data, {
      code: 'code', name: 'name', kind: 'type', building: 'building', floor: 'floor', incharge_id: 'in-charge', notes: 'notes',
    });
    if (changes) audit(req, 'location.update', 'location', loc.id, `${loc.code}: ${changes}`);
    req.flash('ok', 'Changes saved.');
    res.redirect('/locations/' + loc.id);
  });

  return r;
};
