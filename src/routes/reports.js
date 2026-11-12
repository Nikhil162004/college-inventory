'use strict';
const express = require('express');
const v = require('../lib/validate');
const { z } = v;
const { requirePermission, can } = require('../middleware/auth');
const { REPORT_STATUS } = require('../lib/format');

const filterSchema = z.object({
  q: z.string().trim().max(80).catch(''),
  status: z.string().refine((s) => ['', 'active', 'open', 'in_progress', 'resolved', 'rejected', 'all'].includes(s)).catch(''),
  location: v.optId.catch(null),
  page: v.page,
});
const updateSchema = z.object({
  status: v.oneOf(Object.keys(REPORT_STATUS), 'Choose a status'),
  assigned_to: v.optId,
  note: v.optText(1000),
});

module.exports = function reportRoutes({ db, config, audit, inventory, fmt }) {
  const r = express.Router();
  const q = {
    one: db.prepare(
      `SELECT r.*, e.asset_tag, e.name AS equipment_name, e.status AS equipment_status,
              l.code AS location_code, l.name AS location_name,
              COALESCE(u.name, r.guest_name) AS reporter_name, u.college_id AS reporter_college_id, u.role AS reporter_role, u.department AS reporter_department,
              a.name AS assignee_name
       FROM reports r JOIN equipment e ON e.id = r.equipment_id JOIN locations l ON l.id = e.location_id
       LEFT JOIN users u ON u.id = r.reporter_id LEFT JOIN users a ON a.id = r.assigned_to WHERE r.id = ?`
    ),
    updates: db.prepare(
      `SELECT ru.*, u.name AS user_name, u.role AS user_role FROM report_updates ru
       LEFT JOIN users u ON u.id = ru.user_id WHERE ru.report_id = ? ORDER BY ru.id`
    ),
    staff: db.prepare("SELECT id, name, college_id FROM users WHERE role IN ('admin','staff') AND is_active = 1 ORDER BY name"),
    staffOne: db.prepare("SELECT id, name FROM users WHERE id = ? AND role IN ('admin','staff') AND is_active = 1"),
    locations: db.prepare('SELECT id, code, name FROM locations ORDER BY code'),
    update: db.prepare('UPDATE reports SET status = ?, assigned_to = ?, updated_at = ?, closed_at = ? WHERE id = ?'),
    addUpdate: db.prepare('INSERT INTO report_updates (report_id, user_id, from_status, to_status, note, created_at) VALUES (?,?,?,?,?,?)'),
  };

  /** Students see only their own reports. Returns null when the user may not see it. */
  function loadVisible(req) {
    const id = /^[1-9]\d{0,8}$/.test(req.params.id) ? Number(req.params.id) : 0;
    const report = q.one.get(id);
    if (!report) return null;
    if (!can(req.user, 'reports.viewAll') && report.reporter_id !== req.user.id) return null;
    return report;
  }
  function notFound() {
    const err = new Error('Not found');
    err.status = 404; // same answer whether it does not exist or belongs to someone else
    return err;
  }

  r.get('/', (req, res) => {
    const f = v.check(filterSchema, req.query).data;
    const all = can(req.user, 'reports.viewAll');
    const where = [];
    const params = {};
    if (!all) { where.push('r.reporter_id = @me'); params.me = req.user.id; }
    const status = f.status || (all ? 'active' : 'all');
    if (status === 'active') where.push("r.status IN ('open','in_progress')");
    else if (status !== 'all') { where.push('r.status = @status'); params.status = status; }
    if (all && f.location) { where.push('e.location_id = @location'); params.location = f.location; }
    if (f.q) {
      where.push(`(e.asset_tag LIKE @q ESCAPE '\\' OR e.name LIKE @q ESCAPE '\\' OR r.description LIKE @q ESCAPE '\\' OR r.guest_name LIKE @q ESCAPE '\\')`);
      params.q = v.likePattern(f.q);
    }
    const FROM = `FROM reports r JOIN equipment e ON e.id = r.equipment_id JOIN locations l ON l.id = e.location_id
                  LEFT JOIN users u ON u.id = r.reporter_id`;
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n ${FROM} ${whereSql}`).get(params).n;
    const pg = v.paginate(total, f.page, config.pageSize);
    const reports = db.prepare(
      `SELECT r.id, r.issue_type, r.status, r.created_at, e.asset_tag, e.name AS equipment_name,
              l.code AS location_code, COALESCE(u.name, r.guest_name) AS reporter_name, r.reporter_id
       ${FROM} ${whereSql} ORDER BY r.created_at DESC LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit: pg.pageSize, offset: pg.offset });
    res.render('reports/list', {
      title: all ? 'Problem reports' : 'My reports', reports, pg, all,
      filter: { ...f, status }, locations: all ? q.locations.all() : [],
    });
  });

  r.get('/:id', (req, res, next) => {
    const report = loadVisible(req);
    if (!report) return next(notFound());
    res.render('reports/detail', {
      title: fmt.ticket(report.id), report, updates: q.updates.all(report.id),
      staff: can(req.user, 'reports.manage') ? q.staff.all() : [], errors: {}, values: {},
    });
  });

  r.post('/:id/update', requirePermission('reports.manage'), (req, res, next) => {
    const report = loadVisible(req);
    if (!report) return next(notFound());
    const { data, errors } = v.check(updateSchema, req.body);
    const problems = errors || {};
    if (data) {
      // Whoever takes a report up becomes responsible for it unless someone else is chosen.
      if (!data.assigned_to && data.status === 'in_progress' && report.status !== 'in_progress') data.assigned_to = req.user.id;
      const closing = data.status === 'resolved' || data.status === 'rejected';
      if (closing && data.status !== report.status && !data.note) {
        problems.note = data.status === 'resolved' ? 'Describe what was done to fix it.' : 'Explain why the report is rejected.';
      }
      if (data.assigned_to && !q.staffOne.get(data.assigned_to)) problems.assigned_to = 'Choose a member of the lab staff';
      if (report.equipment_status === 'retired' && data.status !== report.status) {
        problems.status = 'This equipment is written off. Its reports can no longer change status.';
      }
      if (!Object.keys(problems).length && data.status === report.status && data.assigned_to === report.assigned_to && !data.note) {
        problems.note = 'Nothing to save. Change the status or the person assigned, or add a note.';
      }
    }
    if (Object.keys(problems).length) {
      return res.status(422).render('reports/detail', {
        title: fmt.ticket(report.id), report, updates: q.updates.all(report.id),
        staff: q.staff.all(), errors: problems, values: req.body,
      });
    }

    db.transaction(() => {
      const now = Date.now();
      const closed = data.status === 'resolved' || data.status === 'rejected';
      q.update.run(data.status, data.assigned_to, now, closed ? (report.closed_at || now) : null, report.id);
      let note = data.note;
      if (data.assigned_to !== report.assigned_to) {
        const who = data.assigned_to ? q.staffOne.get(data.assigned_to).name : null;
        const line = who ? `Assigned to ${who}.` : 'Assignment removed.';
        note = note ? `${line}\n${note}` : line;
      }
      q.addUpdate.run(report.id, req.user.id, report.status, data.status, note, now);
      inventory.syncStatus(report.equipment_id);
    })();
    audit(req, 'report.update', 'equipment', report.equipment_id,
      `${fmt.ticket(report.id)} on ${report.asset_tag}: ${REPORT_STATUS[report.status]} → ${REPORT_STATUS[data.status]}`);
    req.flash('ok', 'Report updated.');
    res.redirect('/reports/' + report.id);
  });

  return r;
};
