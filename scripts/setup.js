'use strict';
/**
 * First-time setup: creates the standard categories and the first administrator.
 *   npm run setup
 * Non-interactive use: set ADMIN_ID, ADMIN_NAME and ADMIN_PASSWORD in the environment.
 */
const readline = require('readline');
const { buildConfig } = require('../src/config');
const { openDb } = require('../src/db');
const passwords = require('../src/security/password');
const { ensureCategories } = require('./defaults');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(question); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

(async () => {
  const config = buildConfig();
  const db = openDb(config.dbPath);
  ensureCategories(db);

  const existing = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (existing > 0) {
    console.log(`An administrator already exists (${existing}). Add more from the People page.`);
    return;
  }

  const env = process.env;
  const collegeId = (env.ADMIN_ID || await ask('Administrator college ID (e.g. ADMIN01): ')).toUpperCase();
  const name = env.ADMIN_NAME || await ask('Full name: ');
  if (!/^[A-Z0-9][A-Z0-9-]{2,19}$/.test(collegeId)) throw new Error('College ID must be 3–20 letters, digits or hyphens.');
  if (name.length < 2 || name.length > 100) throw new Error('Enter the full name.');

  let password = env.ADMIN_PASSWORD;
  if (!password) {
    password = await ask('Password (at least 10 characters, not shown): ', { hidden: true });
    const again = await ask('Password again: ', { hidden: true });
    if (password !== again) throw new Error('The two passwords do not match.');
  }
  const problem = passwords.policyError(password, { college_id: collegeId, name });
  if (problem) throw new Error(problem);

  db.prepare(
    `INSERT INTO users (college_id, name, role, department, password_hash, must_change_password, created_at)
     VALUES (?, ?, 'admin', 'Administration', ?, 0, ?)`
  ).run(collegeId, name, await passwords.hash(password), Date.now());
  console.log(`Administrator ${collegeId} created. Start the server with "npm start" and sign in.`);
})().catch((err) => {
  console.error('Setup failed: ' + err.message);
  process.exitCode = 1;
});
