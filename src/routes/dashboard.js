'use strict';
const express = require('express');
const { TAG_PATTERN } = require('../lib/inventory');
const { can } = require('../middleware/auth');

module.exports = function dashboardRoutes({ db }) {
  const r = express.Router();
  const q = {
    statusCounts: db.prepare('SELECT status, COUNT(*) AS n FROM equipment GROUP BY status'),
    reportCounts: db.prepare('SELECT status, COUNT(*) AS n FROM reports GROUP BY status'),
    locations: db.prepare("SELECT COUNT(*) AS n, SUM(kind = 'lab') AS labs FROM locations"),
    recentReports: db.prepare(
      `SELECT r.id, r.issue_type, r.status, r.created_at, e.id AS equipment_id, e.asset_tag, e.name AS equipment_name, l.code AS location_code
       FROM reports r JOIN equipment e ON e.id = r.equipment_id JOIN locations l ON l.id = e.location_id
       WHERE r.status IN ('open','in_progress') ORDER BY r.created_at DESC LIMIT 8`
    ),
    myReports: db.prepare(
      `SELECT r.id, r.issue_type, r.status, r.created_at, e.asset_tag, e.name AS equipment_name, l.code AS location_code
       FROM reports r JOIN equipment e ON e.id = r.equipment_id JOIN locations l ON l.id = e.location_id
       WHERE r.reporter_id = ? ORDER BY r.created_at DESC LIMIT 5`
    ),
    attention: db.prepare(
      `SELECT l.id, l.code, l.name, COUNT(*) AS total,
              SUM(e.status IN ('issue_reported','under_repair')) AS faulty
       FROM equipment e JOIN locations l ON l.id = e.location_id
       WHERE e.status <> 'retired'
       GROUP BY l.id HAVING faulty > 0 ORDER BY faulty DESC, l.code LIMIT 6`
    ),
    byCategory: db.prepare(
      `SELECT c.id, c.name, COUNT(e.id) AS n FROM categories c
       JOIN equipment e ON e.category_id = c.id AND e.status <> 'retired'
       GROUP BY c.id ORDER BY n DESC LIMIT 8`
    ),
    byTag: db.prepare('SELECT id FROM equipment WHERE asset_tag = ?'),
  };

  r.get('/', (req, res) => {
    const view = { title: 'Overview', myReports: q.myReports.all(req.user.id), overview: null };
    if (can(req.user, 'equipment.browse')) {
      const status = { working: 0, issue_reported: 0, under_repair: 0, retired: 0 };
      for (const row of q.statusCounts.all()) status[row.status] = row.n;
      const reports = { open: 0, in_progress: 0, resolved: 0, rejected: 0 };
      for (const row of q.reportCounts.all()) reports[row.status] = row.n;
      const loc = q.locations.get();
      view.overview = {
        status, reports,
        inUse: status.working + status.issue_reported + status.under_repair,
        locations: loc.n, labs: loc.labs || 0,
        recentReports: q.recentReports.all(),
        attention: q.attention.all(),
        byCategory: q.byCategory.all(),
      };
    }
    res.render('dashboard', view);
  });

  // "Find by asset tag" box and the address printed in every QR code.
  r.get('/find', (req, res) => {
    const raw = typeof req.query.tag === 'string' ? req.query.tag : '';
    const tag = raw.trim().toUpperCase().replace(/\s+/g, '');
    if (!tag) return res.redirect('/');
    res.redirect('/e/' + encodeURIComponent(tag.slice(0, 20)));
  });

  r.get('/e/:tag', (req, res) => {
    const tag = String(req.params.tag).toUpperCase();
    const row = TAG_PATTERN.test(tag) ? q.byTag.get(tag) : null;
    if (!row) {
      return res.status(404).render('error', {
        title: 'Equipment not found', code: 404,
        message: `No equipment carries the asset tag “${tag.slice(0, 20)}”. Check the label and try again. Tags look like PC-00042.`,
      });
    }
    res.redirect('/equipment/' + row.id);
  });

  return r;
};
