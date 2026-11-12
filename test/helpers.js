'use strict';
process.env.NODE_ENV = 'test';
const request = require('supertest');
const { buildConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const passwords = require('../src/security/password');
const { ensureCategories } = require('../scripts/defaults');

passwords.setCostForTests({ N: 1024, r: 8, p: 1 }); // fast hashing in tests only

const PASSWORD = 'correct horse battery staple';
const PEOPLE = {
  admin: ['ADMIN01', 'Asha Admin', 'admin'],
  admin2: ['ADMIN02', 'Second Admin', 'admin'],
  staff: ['STF001', 'Sam Staff', 'staff'],
  faculty: ['FAC001', 'Farah Faculty', 'faculty'],
  student: ['23CS001', 'Sita Student', 'student'],
  student2: ['23CS002', 'Ravi Student', 'student'],
};

/** A fresh application with its own in-memory database. */
async function makeWorld(overrides = {}, extras = {}) {
  const config = buildConfig({ dbPath: ':memory:', sessionSecret: 'test-secret-test-secret-test-secret-1234', loginRateLimit: 1000, ...overrides });
  const db = openDb(':memory:');
  ensureCategories(db);
  const hash = await passwords.hash(PASSWORD);
  const ids = {};
  for (const [key, [collegeId, name, role]] of Object.entries(PEOPLE)) {
    ids[key] = Number(db.prepare(
      'INSERT INTO users (college_id, name, role, department, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(collegeId, name, role, 'CSE', hash, Date.now()).lastInsertRowid);
  }
  const addLocation = db.prepare("INSERT INTO locations (code, name, kind, created_at) VALUES (?, ?, 'lab', ?)");
  const lab1 = Number(addLocation.run('LAB-01', 'Central Computing Centre', Date.now()).lastInsertRowid);
  const lab2 = Number(addLocation.run('LAB-02', 'Programming Lab 1', Date.now()).lastInsertRowid);
  const pcCategory = db.prepare("SELECT id FROM categories WHERE prefix = 'PC'").get().id;
  const app = createApp({ db, config, ...extras });

  const world = {
    app, db, config, ids, lab1, lab2, pcCategory,
    /** Signs in and returns a cookie-keeping agent. */
    async as(key) {
      const { agent, res } = await signIn(app, PEOPLE[key][0], PASSWORD);
      if (res.status !== 302) throw new Error(`sign-in as ${key} failed with ${res.status}`);
      return agent;
    },
    /** Adds equipment directly and returns { id, asset_tag }. */
    addPc(name = 'Desktop computer', location = lab1) {
      const { makeInventory } = require('../src/lib/inventory');
      return makeInventory(db, config).createEquipment({
        name, category_id: pcCategory, location_id: location, brand: null, model: null, serial_no: null, specs: null,
        purchase_date: null, purchase_cost: null, vendor: null, warranty_until: null, notes: null,
      }, 1, ids.admin)[0];
    },
  };
  return world;
}

async function token(agent, path = '/') {
  const res = await agent.get(path);
  const m = /name="_csrf" value="([^"]+)"/.exec(res.text || '');
  if (!m) throw new Error(`no CSRF token on ${path} (status ${res.status})`);
  return m[1];
}

async function signIn(app, collegeId, password, extra = {}) {
  const agent = request.agent(app);
  const csrf = await token(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, college_id: collegeId, password, ...extra });
  return { agent, res };
}

/** POSTs a form with a valid CSRF token taken from `from`. */
async function post(agent, path, data = {}, from = '/') {
  const csrf = await token(agent, from);
  return agent.post(path).type('form').send({ _csrf: csrf, ...data });
}

module.exports = { makeWorld, signIn, post, token, PASSWORD, PEOPLE, request };
