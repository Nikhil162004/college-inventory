'use strict';
/**
 * Sets up email alerts for new problem reports:   npm run alerts
 * Sends a test with the saved settings:           npm run alerts -- --test
 * Turns alerts off again:                         npm run alerts -- --off
 *
 * The answers are saved in the file ".env" in this folder, on this computer
 * only. That file is never part of the project that gets shared (.gitignore).
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const KEYS = ['ALERT_EMAIL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

function quote(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error('A setting must fit on one line.');
  if (text !== '' && !/[\s#"']/.test(text)) return text;
  if (!text.includes('"')) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  throw new Error('A setting cannot contain both kinds of quotation mark.');
}

/** Sets (or, with null, removes) settings in a .env file and leaves every other line alone. */
function updateEnvFile(file, values) {
  const pending = new Map(Object.entries(values).map(([key, value]) => [key, value === null ? null : quote(value)]));
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out = [];
  for (const line of lines) {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!m || !pending.has(m[1])) { out.push(line); continue; }
    const value = pending.get(m[1]);
    pending.delete(m[1]);
    if (value !== null) out.push(`${m[1]}=${value}`);
  }
  for (const [key, value] of pending) if (value !== null) out.push(`${key}=${value}`);
  fs.writeFileSync(file, out.join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows has no such permission bits */ }
}

/** The outgoing mail server for well-known providers, or null when it must be asked. */
function mailServerFor(address) {
  const domain = String(address).trim().toLowerCase().split('@')[1] || '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return { host: 'smtp.gmail.com', port: 465 };
  if (['outlook.com', 'hotmail.com', 'live.com'].includes(domain)) return { host: 'smtp-mail.outlook.com', port: 587 };
  if (domain === 'yahoo.com' || domain === 'yahoo.in' || domain === 'yahoo.co.in') return { host: 'smtp.mail.yahoo.com', port: 465 };
  return null;
}

/** Turns a mail server's error into what to do about it. */
function explainMailError(message) {
  const text = String(message || '');
  if (/5\.7\.[89]|53[45]|Invalid login|not accepted|Application-specific|auth/i.test(text)) {
    return 'The mail server refused the sign-in: the mailbox name or the password is not right. '
      + 'Gmail does not accept your normal password here; it needs a 16-letter "app password". '
      + 'Turn on 2-Step Verification, create one at https://myaccount.google.com/apppasswords and run "npm run alerts" again.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return 'The mail server could not be found. Is this computer connected to the internet?';
  if (/Greeting never received/i.test(text)) {
    return 'The mail server answered, but not in the way this port expects. Use port 465 (encrypted from the start) or 587 (STARTTLS), whichever your mail provider names.';
  }
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|timeout/i.test(text)) {
    return 'The mail server did not answer. Some college and office networks block outgoing mail: try another network (for example your phone\'s Wi-Fi hotspot) or ask whoever runs the firewall to allow it.';
  }
  if (/certificate|self.signed/i.test(text)) return 'The mail server could not prove its identity (certificate problem), so nothing was sent. Check the server name.';
  return 'The mail server said: ' + text;
}

module.exports = { updateEnvFile, mailServerFor, explainMailError, ENV_FILE };

// ---- run from the command line ----------------------------------------------------

function prompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const lines = [];
  const waiting = [];
  let closed = false;
  let hidden = false;
  rl.on('line', (line) => { const next = waiting.shift(); if (next) next(line); else lines.push(line); });
  rl.on('close', () => { closed = true; for (const next of waiting.splice(0)) next(null); });
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (text) => { if (!hidden) write(text); };     // a password is not shown while it is typed

  async function ask(question, { secret = false } = {}) {
    process.stdout.write(question);
    hidden = secret;
    const answer = lines.length ? lines.shift() : closed ? null : await new Promise((resolve) => waiting.push(resolve));
    hidden = false;
    if (secret || !process.stdin.isTTY) process.stdout.write('\n');
    if (answer === null) throw new Error('\nNo answer was given, so nothing was changed.');
    return answer.trim();
  }
  return { ask, close: () => rl.close() };
}

/** Sends one test email, with the given settings or with the saved ones. */
async function sendTest(candidate = null) {
  for (const key of [...KEYS, 'ALERTS_PER_HOUR']) delete process.env[key];   // use what the file says now
  const { buildConfig } = require('../src/config');
  const { makeMailer, makeNotifier } = require('../src/lib/notify');
  const { makeFormatter } = require('../src/lib/format');
  let config;
  try { config = buildConfig(); } catch (err) { console.error(err.message); return false; }
  const alerts = candidate || config.alerts;
  if (!alerts) { console.error('Email alerts are not set up yet. Run "npm run alerts".'); return false; }
  const notify = makeNotifier({ config: { ...config, alerts }, fmt: makeFormatter(config.timezone), mailer: makeMailer(alerts) });
  console.log('Sending a test email ...');
  const result = await notify.sendTest();
  if (result.ok) {
    console.log('Sent. Look in the inbox (and the spam folder the first time).');
    return true;
  }
  console.error('The test email could not be sent.');
  console.error(explainMailError(result.error));
  return false;
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--test') return (await sendTest()) ? 0 : 1;
  if (arg && arg !== '--off') { console.error('Use "npm run alerts", "npm run alerts -- --test" or "npm run alerts -- --off".'); return 1; }
  if (arg === '--off') {
    updateEnvFile(ENV_FILE, Object.fromEntries(KEYS.map((key) => [key, null])));
    console.log('Email alerts are off. Reports are still saved in the register.');
    return 0;
  }

  const EMAIL = /^[^\s@<>,;:"()[\]\\]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
  const io = prompter();
  try {
    console.log('\nEmail alerts for new problem reports');
    console.log('------------------------------------');
    console.log('Your answers are saved only in the file ".env" in this folder, on this computer.\n');

    let to = '';
    while (!EMAIL.test(to)) to = await io.ask('Send the alerts to which email address?  ');
    let user = await io.ask(`Send them from which mailbox?  (press Enter to use ${to})  `);
    if (!EMAIL.test(user)) user = to;

    let server = mailServerFor(user);
    if (!server) {
      const host = await io.ask('Outgoing mail (SMTP) server name, as given by your mail provider:  ');
      const port = Number.parseInt(await io.ask('Port (press Enter for 465):  '), 10) || 465;
      server = { host, port };
    }
    const gmail = server.host === 'smtp.gmail.com';
    if (gmail) {
      console.log('\nGmail needs an "app password" (not your normal password):');
      console.log('  1. Turn on 2-Step Verification for the Google account, if it is not on yet.');
      console.log('  2. Open https://myaccount.google.com/apppasswords , type a name such as "Inventory", press Create.');
      console.log('  3. Copy the 16 letters it shows and paste them below.\n');
    }
    let pass = '';
    while (!pass) pass = await io.ask(gmail ? 'App password (it stays hidden while you type):  ' : 'Mailbox password (it stays hidden while you type):  ', { secret: true });
    if (gmail) pass = pass.replace(/\s+/g, '');

    io.close();
    console.log('');
    // nothing is saved until one email has really gone out
    if (!(await sendTest({ to: [to], host: server.host, port: server.port, user, pass, from: user, perHour: 60 }))) {
      console.error('\nNothing was saved. Run "npm run alerts" to try again.');
      return 1;
    }
    updateEnvFile(ENV_FILE, { ALERT_EMAIL: to, SMTP_HOST: server.host, SMTP_PORT: String(server.port), SMTP_USER: user, SMTP_PASS: pass, SMTP_FROM: null });
    console.log('\nSaved. Email alerts are on from the next time the register starts.');
    return 0;
  } finally {
    io.close();
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
}
