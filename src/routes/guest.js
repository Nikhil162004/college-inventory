'use strict';
/**
 * Reporting a problem from the QR label without an account.
 *
 * Whoever stands in front of the item can scan its label and send a report.
 * These are the only pages a visitor can use; they show just enough to
 * recognise the item. What arrives is unverified: staff see it marked as
 * "not signed in", and limits per item and per network address keep one
 * person from flooding the register.
 */
const crypto = require('crypto');
const express = require('express');
const v = require('../lib/validate');
const { z } = v;
const { TAG_PATTERN } = require('../lib/inventory');
const { ISSUE } = require('../lib/format');
const { makeSentFromThisSite } = require('../lib/same-site');

const FORM_SESSION_MS = 30 * 60 * 1000;      // a visitor's form stays valid this long
const SAME_REPORT_MS = 10 * 60 * 1000;       // the same report again within this time is a double tap
const REPORT_PATH = /^\/e\/[^/]+\/report$/;

const schema = z.object({
  issue_type: v.oneOf(Object.keys(ISSUE), 'Choose what is wrong'),
  description: v.text(1000, 10),
  reporter_name: v.text(80, 2),
  reporter_ref: v.optText(40),
});

module.exports = function guestRoutes({ db, config, audit, inventory, fmt, notify }) {
  const router = express.Router();
  const sentFromThisSite = makeSentFromThisSite(config);
  const q = {
    byTag: db.prepare(
      `SELECT e.id, e.asset_tag, e.name, e.status, l.code AS location_code, l.name AS location_name
       FROM equipment e JOIN locations l ON l.id = e.location_id WHERE e.asset_tag = ?`
    ),
    active: db.prepare(
      `SELECT issue_type, status, created_at FROM reports
       WHERE equipment_id = ? AND status IN ('open','in_progress') ORDER BY created_at DESC LIMIT 5`
    ),
    guestActive: db.prepare(
      `SELECT COUNT(*) AS n FROM reports WHERE equipment_id = ? AND reporter_id IS NULL AND status IN ('open','in_progress')`
    ),
    fromAddress: db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'report.guest' AND ip = ? AND created_at > ?"),
    same: db.prepare(
      `SELECT id FROM reports WHERE equipment_id = ? AND reporter_id IS NULL AND guest_name = ? AND description = ? AND created_at > ?`
    ),
    insert: db.prepare(
      `INSERT INTO reports (equipment_id, reporter_id, guest_name, guest_ref, issue_type, description, status, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, 'open', ?, ?)`
    ),
    addUpdate: db.prepare('INSERT INTO report_updates (report_id, user_id, from_status, to_status, note, created_at) VALUES (?, NULL, NULL, ?, NULL, ?)'),
    receipt: db.prepare(
      `SELECT r.id, r.created_at, e.asset_tag, e.name, l.code AS location_code, l.name AS location_name
       FROM reports r JOIN equipment e ON e.id = r.equipment_id JOIN locations l ON l.id = e.location_id
       WHERE r.id = ? AND r.reporter_id IS NULL`
    ),
  };

  const cleanTag = (raw) => String(raw).toUpperCase();
  const find = (tag) => (TAG_PATTERN.test(tag) ? q.byTag.get(tag) : null);

  /** Proof that a receipt address was handed out by this site (no cookie needed to show it). */
  const receiptKey = (id) => crypto.createHmac('sha256', config.sessionSecret).update(`guest-report:${id}`).digest('base64url').slice(0, 22);
  const receiptUrl = (tag, id) => `/e/${tag}/sent?r=${id}&k=${receiptKey(id)}`;
  function keyMatches(id, sent) {
    const a = Buffer.from(receiptKey(id));
    const b = Buffer.from(String(sent || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function notFound(res, tag) {
    res.status(404).render('error', {
      title: 'Equipment not found', code: 404,
      message: `No equipment carries the asset tag “${tag.slice(0, 20)}”. Check the label and try again. Tags look like PC-00042.`,
    });
  }

  /** The one place that draws the visitor's form. */
  function renderForm(req, res, status, item, { values = {}, errors = {}, notice = null, problem = null } = {}) {
    res.set('Cache-Control', 'no-store');
    if (req.session && !req.session.userId) req.session.cookie.maxAge = FORM_SESSION_MS;
    let closed = null;
    if (item.status === 'retired') closed = 'This item is no longer in use, so it takes no reports.';
    else if (q.guestActive.get(item.id).n >= config.guestReportsPerItem) {
      closed = 'This item has already been reported and the lab staff have been told. There is no need to report it again.';
    }
    res.status(status).render('public/report', {
      title: `Report a problem: ${item.asset_tag}`, item, values, errors, notice, problem, closed,
      activeReports: closed ? [] : q.active.all(item.id),
    });
  }

  // "Type the number on the label" box on the sign-in page.
  router.get('/find', (req, res, next) => {
    if (req.user || !config.guestReports) return next();
    const raw = typeof req.query.tag === 'string' ? req.query.tag : '';
    const tag = raw.trim().toUpperCase().replace(/\s+/g, '');
    if (!tag) return res.redirect('/login');
    res.redirect('/e/' + encodeURIComponent(tag.slice(0, 20)));
  });

  // The address inside every QR code.
  router.get('/e/:tag', (req, res, next) => {
    if (req.user || !config.guestReports) return next();   // signed in: the full item page; switched off: sign-in
    const tag = cleanTag(req.params.tag);
    const item = find(tag);
    if (!item) return notFound(res, tag);
    renderForm(req, res, 200, item);
  });

  router.post('/e/:tag/report', (req, res, next) => {
    const tag = cleanTag(req.params.tag);
    if (req.user) return res.redirect(303, '/e/' + encodeURIComponent(tag.slice(0, 20)));
    if (!config.guestReports) return next();
    const item = find(tag);
    if (!item) return notFound(res, tag);
    const body = req.body || {};
    if (item.status === 'retired') return renderForm(req, res, 410, item);

    // A field people never see. Programs that fill in every field give themselves away.
    if (typeof body.leave_blank === 'string' && body.leave_blank !== '') {
      return res.status(400).render('error', {
        title: 'Report not accepted', code: 400, message: 'The report could not be accepted. Scan the label again and fill in the form by hand.',
      });
    }

    const { data, errors } = v.check(schema, body);
    if (errors) {
      if (errors.reporter_name) errors.reporter_name = 'Enter your name';
      return renderForm(req, res, 422, item, { values: body, errors });
    }

    const now = Date.now();
    const same = q.same.get(item.id, data.reporter_name, data.description, now - SAME_REPORT_MS);
    if (same) return res.redirect(303, receiptUrl(item.asset_tag, same.id));

    if (q.guestActive.get(item.id).n >= config.guestReportsPerItem) return renderForm(req, res, 429, item, { values: body });
    if (q.fromAddress.get(req.ip, now - 60 * 60 * 1000).n >= config.guestReportsPerHour) {
      return renderForm(req, res, 429, item, {
        values: body,
        problem: 'Too many reports have been sent from this network in the last hour, so this one was not saved. Please try again later, or tell the lab staff in person.',
      });
    }

    const id = db.transaction(() => {
      const reportId = Number(q.insert.run(item.id, data.reporter_name, data.reporter_ref, data.issue_type, data.description, now, now).lastInsertRowid);
      q.addUpdate.run(reportId, 'open', now);
      inventory.syncStatus(item.id);
      return reportId;
    })();
    audit(req, 'report.guest', 'equipment', item.id,
      `${fmt.ticket(id)} on ${item.asset_tag} sent without signing in by “${data.reporter_name}”: ${ISSUE[data.issue_type]}`, 'guest');
    notify.reportCreated({
      id, createdAt: now, issueType: data.issue_type, description: data.description, item,
      reporter: `${data.reporter_name} (not signed in${data.reporter_ref ? '; gave the number ' + data.reporter_ref : ''})`,
    });
    res.redirect(303, receiptUrl(item.asset_tag, id));
  });

  // Shown after sending. The address carries its own proof, so it works after a
  // refresh and in browsers that keep no cookies.
  router.get('/e/:tag/sent', (req, res, next) => {
    if (!config.guestReports) return next();
    const tag = cleanTag(req.params.tag);
    const id = /^[1-9]\d{0,8}$/.test(String(req.query.r)) ? Number(req.query.r) : 0;
    const report = id && keyMatches(id, req.query.k) ? q.receipt.get(id) : null;
    if (!report || report.asset_tag !== tag) {
      return res.status(404).render('error', { title: 'Page not found', code: 404, message: 'There is nothing at this address. Scan the label again to send a report.' });
    }
    res.set('Cache-Control', 'no-store');
    res.render('public/sent', { title: `Report ${fmt.ticket(report.id)} sent`, report });
  });

  /**
   * The form came back without a valid token: the page sat open too long, or
   * the browser keeps no cookies. If the browser itself says the form was sent
   * from this site's own page, it is as good as the token and the report is
   * taken. Otherwise the form is shown again, refreshed, with everything the
   * visitor typed still in it.
   */
  // eslint-disable-next-line no-unused-vars
  function recoverFromStaleForm(err, req, res, next) {
    if (err.code !== 'EBADCSRFTOKEN' || req.method !== 'POST' || req.user || !config.guestReports || !REPORT_PATH.test(req.path)) return next(err);
    if (sentFromThisSite(req)) return next();
    const tag = cleanTag(decodeURIComponent(req.path.split('/')[2] || ''));
    const item = find(tag);
    if (!item) return notFound(res, tag);
    renderForm(req, res, 403, item, {
      values: req.body || {},
      notice: 'This page had been open for a while, so it has been refreshed. Check your report and press Send again.',
    });
  }

  return { router, recoverFromStaleForm };
};
