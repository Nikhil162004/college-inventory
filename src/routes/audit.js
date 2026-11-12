'use strict';
const express = require('express');
const v = require('../lib/validate');
const { z } = v;
const { requirePermission } = require('../middleware/auth');

const GROUPS = ['', 'login', 'password', 'user', 'equipment', 'report', 'location', 'category'];
const filterSchema = z.object({
  q: z.string().trim().max(80).catch(''),
  group: z.string().refine((s) => GROUPS.includes(s)).catch(''),
  page: v.page,
});

module.exports = function auditRoutes({ db }) {
  const r = express.Router();
  r.use(requirePermission('audit.view'));

  r.get('/', (req, res) => {
    const f = v.check(filterSchema, req.query).data;
    const where = [];
    const params = {};
    if (f.group) { where.push("a.action LIKE @group ESCAPE '\\'"); params.group = f.group + '%'; }
    if (f.q) {
      where.push(`(a.actor LIKE @q ESCAPE '\\' OR a.summary LIKE @q ESCAPE '\\')`);
      params.q = v.likePattern(f.q);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${whereSql}`).get(params).n;
    const pg = v.paginate(total, f.page, 50);
    const entries = db.prepare(
      `SELECT a.id, a.actor, a.action, a.summary, a.ip, a.created_at, a.entity_type, a.entity_id
       FROM audit_log a ${whereSql} ORDER BY a.id DESC LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit: pg.pageSize, offset: pg.offset });
    res.render('audit', { title: 'Activity log', entries, pg, filter: f, groups: GROUPS });
  });

  return r;
};
