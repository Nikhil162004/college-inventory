'use strict';
const express = require('express');
const v = require('../lib/validate');
const { z } = v;
const { requirePermission, can } = require('../middleware/auth');
const { describeChanges } = require('../lib/audit');
const { toCsv } = require('../lib/csv');
const { ISSUE, STATUS, ROLE } = require('../lib/format');
const wrap = require('../lib/wrap');

const MAX_QUANTITY = 200;
const LABELS_PER_PAGE = 120;
const EXPORT_LIMIT = 20000;

const fieldsSchema = {
  name: v.text(120),
  location_id: v.id,
  brand: v.optText(80),
  model: v.optText(80),
  serial_no: v.optText(80),
  specs: v.optText(500),
  purchase_date: v.optDate,
  purchase_cost: v.optMoney,
  vendor: v.optText(120),
  warranty_until: v.optDate,
  notes: v.optText(1000),
};
const createSchema = z.object({
  ...fieldsSchema,
  category_id: v.id,
  quantity: z.string().trim().regex(/^\d{1,3}$/, `Enter a number from 1 to ${MAX_QUANTITY}`).transform(Number)
    .refine((n) => n >= 1 && n <= MAX_QUANTITY, `Enter a number from 1 to ${MAX_QUANTITY}`),
});
const editSchema = z.object(fieldsSchema);
const filterSchema = z.object({
  q: z.string().trim().max(80).catch(''),
  location: v.optId.catch(null),
  category: v.optId.catch(null),
  status: z.string().refine((s) => ['', 'working', 'issue_reported', 'under_repair', 'retired'].includes(s)).catch(''),
  page: v.page,
});
const reportSchema = z.object({
  issue_type: v.oneOf(Object.keys(ISSUE), 'Choose what is wrong'),
  description: v.text(1000, 10),
});
const retireSchema = z.object({ reason: v.text(300, 5) });

const EDIT_LABELS = {
  name: 'name', location_id: 'location', brand: 'brand', model: 'model', serial_no: 'serial no.',
  specs: 'specifications', purchase_date: 'purchase date', purchase_cost: 'cost', vendor: 'vendor',
  warranty_until: 'warranty until', notes: 'notes',
};

module.exports = function equipmentRoutes({ db, config, audit, inventory, fmt, notify }) {
  const r = express.Router();

  const q = {
    categories: db.prepare('SELECT id, name, prefix FROM categories ORDER BY name'),
    locations: db.prepare('SELECT id, code, name FROM locations ORDER BY code'),
    location: db.prepare('SELECT id, code, name FROM locations WHERE id = ?'),
    category: db.prepare('SELECT id, name, prefix FROM categories WHERE id = ?'),
    one: db.prepare(
      `SELECT e.*, c.name AS category, l.code AS location_code, l.name AS location_name, u.name AS created_by_name
       FROM equipment e JOIN categories c ON c.id = e.category_id JOIN locations l ON l.id = e.location_id
       LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?`
    ),
    update: db.prepare(
      `UPDATE equipment SET name=@name, location_id=@location_id, brand=@brand, model=@model, serial_no=@serial_no,
         specs=@specs, purchase_date=@purchase_date, purchase_cost=@purchase_cost, vendor=@vendor,
         warranty_until=@warranty_until, notes=@notes, updated_at=@now WHERE id=@id`
    ),
    retire: db.prepare("UPDATE equipment SET status='retired', retired_reason=?, updated_at=? WHERE id=?"),
    unretire: db.prepare("UPDATE equipment SET status='working', retired_reason=NULL, updated_at=? WHERE id=?"),
    closeReportsFor: db.prepare(
      `SELECT id, status FROM reports WHERE equipment_id = ? AND status IN ('open','in_progress')`
    ),
    closeReport: db.prepare("UPDATE reports SET status='rejected', updated_at=?, closed_at=? WHERE id=?"),
    addUpdate: db.prepare('INSERT INTO report_updates (report_id, user_id, from_status, to_status, note, created_at) VALUES (?,?,?,?,?,?)'),
    reportsFor: db.prepare(
      `SELECT r.id, r.issue_type, r.status, r.created_at, r.description, COALESCE(u.name, r.guest_name) AS reporter, u.college_id AS reporter_id_text, r.reporter_id
       FROM reports r LEFT JOIN users u ON u.id = r.reporter_id WHERE r.equipment_id = ? ORDER BY r.created_at DESC LIMIT 25`
    ),
    activeReportsFor: db.prepare(
      `SELECT id, issue_type, status, created_at FROM reports
       WHERE equipment_id = ? AND status IN ('open','in_progress') ORDER BY created_at DESC`
    ),
    myActiveReport: db.prepare(
      `SELECT id FROM reports WHERE equipment_id = ? AND reporter_id = ? AND status IN ('open','in_progress')`
    ),
    myRecentCount: db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > ?'),
    insertReport: db.prepare(
      `INSERT INTO reports (equipment_id, reporter_id, issue_type, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`
    ),
    history: db.prepare(
      `SELECT a.action, a.summary, a.created_at, a.actor FROM audit_log a
       WHERE a.entity_type = 'equipment' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 30`
    ),
  };

  function parseId(req) {
    return /^[1-9]\d{0,8}$/.test(req.params.id) ? Number(req.params.id) : 0;
  }
  function findOr404(req) {
    const item = q.one.get(parseId(req));
    if (!item) {
      const err = new Error('Not found');
      err.status = 404;
      throw err;
    }
    return item;
  }

  /** Turns the list filters into a WHERE clause using bound parameters only. */
  function buildWhere(f) {
    const where = [];
    const params = {};
    if (f.q) {
      where.push(`(e.asset_tag LIKE @q ESCAPE '\\' OR e.name LIKE @q ESCAPE '\\' OR e.serial_no LIKE @q ESCAPE '\\'
                   OR e.brand LIKE @q ESCAPE '\\' OR e.model LIKE @q ESCAPE '\\')`);
      params.q = v.likePattern(f.q);
    }
    if (f.location) { where.push('e.location_id = @location'); params.location = f.location; }
    if (f.category) { where.push('e.category_id = @category'); params.category = f.category; }
    if (f.status) { where.push('e.status = @status'); params.status = f.status; }
    else where.push("e.status <> 'retired'");
    return { sql: where.join(' AND '), params };
  }
  const FROM = `FROM equipment e JOIN categories c ON c.id = e.category_id JOIN locations l ON l.id = e.location_id`;

  // ---- List ---------------------------------------------------------------
  r.get('/', requirePermission('equipment.browse'), (req, res) => {
    const f = v.check(filterSchema, req.query).data;
    const w = buildWhere(f);
    const total = db.prepare(`SELECT COUNT(*) AS n ${FROM} WHERE ${w.sql}`).get(w.params).n;
    const pg = v.paginate(total, f.page, config.pageSize);
    const items = db.prepare(
      `SELECT e.id, e.asset_tag, e.name, e.status, e.brand, e.model, c.name AS category, l.code AS location_code, l.name AS location_name
       ${FROM} WHERE ${w.sql} ORDER BY e.asset_tag LIMIT @limit OFFSET @offset`
    ).all({ ...w.params, limit: pg.pageSize, offset: pg.offset });
    res.render('equipment/list', {
      title: 'Equipment', items, pg, filter: f,
      categories: q.categories.all(), locations: q.locations.all(),
    });
  });

  // ---- CSV export -----------------------------------------------------------
  r.get('/export.csv', requirePermission('equipment.manage'), (req, res) => {
    const f = v.check(filterSchema, req.query).data;
    const w = buildWhere(f);
    const rows = db.prepare(
      `SELECT e.asset_tag, e.name, c.name AS category, l.code AS location_code, l.name AS location_name, e.status,
              e.brand, e.model, e.serial_no, e.specs, e.purchase_date, e.purchase_cost, e.vendor, e.warranty_until, e.notes
       ${FROM} WHERE ${w.sql} ORDER BY e.asset_tag LIMIT ${EXPORT_LIMIT}`
    ).all(w.params);
    audit(req, 'equipment.export', null, null, `Exported ${rows.length} equipment records to CSV`);
    const csv = toCsv(
      ['Asset tag', 'Name', 'Category', 'Location code', 'Location', 'Status', 'Brand', 'Model', 'Serial no.',
        'Specifications', 'Purchase date', 'Cost (INR)', 'Vendor', 'Warranty until', 'Notes'],
      rows.map((e) => [e.asset_tag, e.name, e.category, e.location_code, e.location_name, STATUS[e.status], e.brand, e.model,
        e.serial_no, e.specs, e.purchase_date, e.purchase_cost, e.vendor, e.warranty_until, e.notes])
    );
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="equipment-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  // ---- Printable QR labels ---------------------------------------------------
  r.get('/labels', requirePermission('equipment.manage'), wrap(async (req, res) => {
    const f = v.check(filterSchema, req.query).data;
    const w = buildWhere(f);
    const total = db.prepare(`SELECT COUNT(*) AS n ${FROM} WHERE ${w.sql}`).get(w.params).n;
    const pg = v.paginate(total, f.page, LABELS_PER_PAGE);
    const items = db.prepare(
      `SELECT e.id, e.asset_tag, e.name, l.code AS location_code ${FROM} WHERE ${w.sql}
       ORDER BY e.asset_tag LIMIT @limit OFFSET @offset`
    ).all({ ...w.params, limit: pg.pageSize, offset: pg.offset });
    for (const item of items) item.qr = await inventory.qrSvg(inventory.scanUrl(req, item.asset_tag));
    res.render('equipment/labels', { title: 'QR labels', items, pg, filter: f, qrNote: inventory.scanNote(req) });
  }));

  // ---- Add ------------------------------------------------------------------
  function renderForm(res, status, { item, values, errors }) {
    res.status(status).render('equipment/form', {
      title: item ? `Edit ${item.asset_tag}` : 'Add equipment',
      item, values, errors: errors || {},
      categories: q.categories.all(), locations: q.locations.all(), maxQuantity: MAX_QUANTITY,
    });
  }

  r.get('/new', requirePermission('equipment.manage'), (req, res) => {
    const loc = /^[1-9]\d{0,8}$/.test(String(req.query.location || '')) ? String(req.query.location) : '';
    renderForm(res, 200, { item: null, values: { quantity: '1', location_id: loc } });
  });

  r.post('/', requirePermission('equipment.manage'), (req, res) => {
    const { data, errors } = v.check(createSchema, req.body);
    const problems = errors || {};
    if (data) {
      if (!q.category.get(data.category_id)) problems.category_id = 'Choose a category';
      if (!q.location.get(data.location_id)) problems.location_id = 'Choose a location';
      if (data.quantity > 1 && data.serial_no) {
        problems.serial_no = 'Serial numbers are unique. Leave this empty when adding several items and fill it in per item afterwards.';
      }
    }
    if (Object.keys(problems).length) return renderForm(res, 422, { item: null, values: req.body, errors: problems });

    const { quantity, ...fields } = data;
    const created = inventory.createEquipment(fields, quantity, req.user.id);
    const loc = q.location.get(fields.location_id);
    for (const item of created) {
      audit(req, 'equipment.create', 'equipment', item.id, `Added ${item.asset_tag} “${fields.name}” in ${loc.code}`);
    }
    if (created.length === 1) {
      req.flash('ok', `${created[0].asset_tag} added. Print its QR label and fix it on the item.`);
      return res.redirect('/equipment/' + created[0].id);
    }
    req.flash('ok', `${created.length} items added: ${created[0].asset_tag} to ${created[created.length - 1].asset_tag}.`);
    res.redirect('/equipment' + fmt.qs({ location: fields.location_id, category: fields.category_id }));
  });

  // ---- Detail ---------------------------------------------------------------
  r.get('/:id', wrap(async (req, res) => {
    const item = findOr404(req);
    const full = can(req.user, 'equipment.browse');
    const view = {
      title: item.asset_tag, item, full,
      activeReports: q.activeReportsFor.all(item.id),
      mine: q.myActiveReport.get(item.id, req.user.id) || null,
      reports: [], history: [], qr: null, scanUrl: null, qrNote: null,
    };
    if (full) {
      view.reports = q.reportsFor.all(item.id);
      view.history = q.history.all(item.id);
    }
    if (can(req.user, 'equipment.manage')) {
      view.scanUrl = inventory.scanUrl(req, item.asset_tag);
      view.qr = await inventory.qrSvg(view.scanUrl);
      const note = inventory.scanNote(req);
      view.qrNote = note && note.kind !== 'unset' ? note : null; // the printing reminder belongs on the label sheet
    }
    res.render('equipment/detail', view);
  }));

  // ---- Edit -----------------------------------------------------------------
  r.get('/:id/edit', requirePermission('equipment.manage'), (req, res) => {
    const item = findOr404(req);
    renderForm(res, 200, { item, values: item });
  });

  r.post('/:id', requirePermission('equipment.manage'), (req, res) => {
    const item = findOr404(req);
    const { data, errors } = v.check(editSchema, req.body);
    const problems = errors || {};
    if (data && !q.location.get(data.location_id)) problems.location_id = 'Choose a location';
    if (Object.keys(problems).length) return renderForm(res, 422, { item, values: req.body, errors: problems });

    q.update.run({ ...data, id: item.id, now: Date.now() });
    const before = { ...item, location_id: item.location_code };
    const after = { ...data, location_id: q.location.get(data.location_id).code };
    const changes = describeChanges(before, after, EDIT_LABELS);
    if (changes) audit(req, 'equipment.update', 'equipment', item.id, `${item.asset_tag}: ${changes}`);
    req.flash('ok', changes ? 'Changes saved.' : 'Nothing was changed.');
    res.redirect('/equipment/' + item.id);
  });

  // ---- Write off / restore (administrators only; nothing is ever deleted) ------
  r.post('/:id/retire', requirePermission('equipment.retire'), (req, res) => {
    const item = findOr404(req);
    const { data, errors } = v.check(retireSchema, req.body);
    if (errors || item.status === 'retired') {
      req.flash('error', errors ? 'Give a reason of at least 5 characters for writing off this item.' : 'This item is already written off.');
      return res.redirect('/equipment/' + item.id);
    }
    db.transaction(() => {
      const now = Date.now();
      for (const rep of q.closeReportsFor.all(item.id)) {
        q.closeReport.run(now, now, rep.id);
        q.addUpdate.run(rep.id, req.user.id, rep.status, 'rejected', 'Closed automatically: the equipment was written off.', now);
      }
      q.retire.run(data.reason, now, item.id);
    })();
    audit(req, 'equipment.retire', 'equipment', item.id, `${item.asset_tag} written off: ${data.reason}`);
    req.flash('ok', `${item.asset_tag} has been written off. Its record is kept.`);
    res.redirect('/equipment/' + item.id);
  });

  r.post('/:id/restore', requirePermission('equipment.retire'), (req, res) => {
    const item = findOr404(req);
    if (item.status === 'retired') {
      q.unretire.run(Date.now(), item.id);
      audit(req, 'equipment.restore', 'equipment', item.id, `${item.asset_tag} returned to service`);
      req.flash('ok', `${item.asset_tag} is back in service.`);
    }
    res.redirect('/equipment/' + item.id);
  });

  // ---- Report a problem (every signed-in user) ------------------------------------
  function reportBlock(item, user) {
    if (item.status === 'retired') return 'This item has been written off and can no longer be reported.';
    const mine = q.myActiveReport.get(item.id, user.id);
    if (mine) return { existing: mine.id };
    if (!can(user, 'reports.manage')) {
      const recent = q.myRecentCount.get(user.id, Date.now() - 60 * 60 * 1000).n;
      if (recent >= config.reportsPerHour) {
        return `You have filed ${recent} reports in the last hour, which is the limit. Please try again later or tell the lab staff in person.`;
      }
    }
    return null;
  }

  r.get('/:id/report', (req, res) => {
    const item = findOr404(req);
    const block = reportBlock(item, req.user);
    if (block && block.existing) {
      req.flash('info', 'You have already reported this item. Your report is still being handled.');
      return res.redirect('/reports/' + block.existing);
    }
    res.render('equipment/report', {
      title: `Report a problem: ${item.asset_tag}`, item, block,
      activeReports: q.activeReportsFor.all(item.id), values: {}, errors: {},
    });
  });

  r.post('/:id/report', (req, res) => {
    const item = findOr404(req);
    const block = reportBlock(item, req.user);
    if (block && block.existing) return res.redirect('/reports/' + block.existing);
    const { data, errors } = v.check(reportSchema, req.body);
    if (block || errors) {
      return res.status(block ? 429 : 422).render('equipment/report', {
        title: `Report a problem: ${item.asset_tag}`, item, block,
        activeReports: q.activeReportsFor.all(item.id), values: req.body, errors: errors || {},
      });
    }
    const reportId = db.transaction(() => {
      const now = Date.now();
      const id = Number(q.insertReport.run(item.id, req.user.id, data.issue_type, data.description, now, now).lastInsertRowid);
      q.addUpdate.run(id, req.user.id, null, 'open', null, now);
      inventory.syncStatus(item.id);
      return id;
    })();
    audit(req, 'report.create', 'equipment', item.id, `Problem reported on ${item.asset_tag}: ${ISSUE[data.issue_type]}`);
    notify.reportCreated({
      id: reportId, createdAt: Date.now(), issueType: data.issue_type, description: data.description, item,
      reporter: `${req.user.name} (${req.user.college_id}, ${ROLE[req.user.role] || req.user.role})`,
    });
    req.flash('ok', 'Thank you. Your report has been sent to the lab staff.');
    res.redirect('/reports/' + reportId);
  });

  return r;
};
