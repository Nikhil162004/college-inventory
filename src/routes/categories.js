'use strict';
const express = require('express');
const v = require('../lib/validate');
const { z } = v;
const { requirePermission } = require('../middleware/auth');

const createSchema = z.object({
  name: v.text(60),
  prefix: z.string().trim().toUpperCase().regex(/^[A-Z]{2,5}$/, 'Use 2–5 letters, e.g. PRJ'),
});
const renameSchema = z.object({ name: v.text(60) });

module.exports = function categoryRoutes({ db, audit }) {
  const r = express.Router();
  r.use(requirePermission('categories.manage'));

  const q = {
    list: db.prepare(
      `SELECT c.id, c.name, c.prefix, c.next_seq, COUNT(e.id) AS total
       FROM categories c LEFT JOIN equipment e ON e.category_id = c.id AND e.status <> 'retired'
       GROUP BY c.id ORDER BY c.name`
    ),
    one: db.prepare('SELECT * FROM categories WHERE id = ?'),
    byName: db.prepare('SELECT id FROM categories WHERE name = ?'),
    byPrefix: db.prepare('SELECT id FROM categories WHERE prefix = ?'),
    insert: db.prepare('INSERT INTO categories (name, prefix) VALUES (?, ?)'),
    rename: db.prepare('UPDATE categories SET name = ? WHERE id = ?'),
  };
  const render = (res, status, values, errors) =>
    res.status(status).render('categories', { title: 'Categories', categories: q.list.all(), values, errors });

  r.get('/', (req, res) => render(res, 200, {}, {}));

  r.post('/', (req, res) => {
    const { data, errors } = v.check(createSchema, req.body);
    const problems = errors || {};
    if (data) {
      if (q.byName.get(data.name)) problems.name = 'A category with this name already exists';
      if (q.byPrefix.get(data.prefix)) problems.prefix = 'Another category already uses this prefix';
    }
    if (Object.keys(problems).length) return render(res, 422, req.body, problems);
    const id = Number(q.insert.run(data.name, data.prefix).lastInsertRowid);
    audit(req, 'category.create', 'category', id, `Added category “${data.name}” (${data.prefix})`);
    req.flash('ok', `Category “${data.name}” added. Its asset tags will start with ${data.prefix}-.`);
    res.redirect('/categories');
  });

  // Only the name can change. The prefix is printed on labels and stays fixed.
  r.post('/:id', (req, res, next) => {
    const cat = q.one.get(/^[1-9]\d{0,8}$/.test(req.params.id) ? Number(req.params.id) : 0);
    if (!cat) { const err = new Error('Not found'); err.status = 404; return next(err); }
    const { data, errors } = v.check(renameSchema, req.body);
    const clash = data && q.byName.get(data.name);
    if (errors || (clash && clash.id !== cat.id)) {
      req.flash('error', errors ? `Could not rename: ${errors.name}` : 'Another category already has that name.');
      return res.redirect('/categories');
    }
    if (data.name !== cat.name) {
      q.rename.run(data.name, cat.id);
      audit(req, 'category.update', 'category', cat.id, `Renamed category “${cat.name}” to “${data.name}”`);
      req.flash('ok', 'Category renamed.');
    }
    res.redirect('/categories');
  });

  return r;
};
