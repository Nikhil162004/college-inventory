'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

/** The CREATE TABLE statement for one table, exactly as schema.sql has it. */
function tableSql(name) {
  const start = SCHEMA.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  const end = SCHEMA.indexOf('\n);', start);
  if (start < 0 || end < 0) throw new Error(`schema.sql has no table "${name}"`);
  return SCHEMA.slice(start, end + 3);
}

/**
 * Registers created before reports could be sent without signing in have a
 * reports table that insists on an account. SQLite cannot relax that in place,
 * so the table is rebuilt (the procedure from sqlite.org/lang_altertable.html):
 * everything happens in one transaction, and nothing is kept unless every row
 * arrived and every reference still points at something.
 */
function upgradeReports(db) {
  const columns = db.prepare('PRAGMA table_info(reports)').all();
  if (!columns.length || columns.some((c) => c.name === 'guest_name')) return; // new database, or already done
  const kept = columns.map((c) => c.name).join(', ');
  const before = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(id), 0) AS ids FROM reports').get();

  db.pragma('foreign_keys = OFF'); // cannot be changed inside a transaction
  try {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS reports_upgrade');
      db.exec(tableSql('reports').replace('CREATE TABLE IF NOT EXISTS reports (', 'CREATE TABLE reports_upgrade ('));
      db.exec(`INSERT INTO reports_upgrade (${kept}) SELECT ${kept} FROM reports`);
      db.exec('DROP TABLE reports');
      db.exec('ALTER TABLE reports_upgrade RENAME TO reports');
      const after = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(id), 0) AS ids FROM reports').get();
      if (after.n !== before.n || after.ids !== before.ids) throw new Error('Upgrade of the reports table lost rows; nothing was changed.');
      const broken = db.pragma('foreign_key_check');
      if (broken.length) throw new Error('Upgrade of the reports table left broken references; nothing was changed.');
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  console.log(`Database upgraded: reports can now be sent without signing in (${before.n} existing reports kept).`);
}

/** Opens (and if needed creates) the database and applies the schema. */
function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');     // readers never block the writer
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  upgradeReports(db);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);                     // creates whatever does not exist yet (tables and indexes)
  return db;
}

module.exports = { openDb };
