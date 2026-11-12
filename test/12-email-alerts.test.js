'use strict';
/**
 * Email alerts: when a problem is reported, the people in charge get an email.
 * The address is private: it lives in the server's settings and is never shown
 * on a page. A report is never lost or delayed because mail could not be sent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SMTPServer } = require('smtp-server');
const { makeWorld, request, token, post } = require('./helpers');
const { buildConfig, parseEnvText } = require('../src/config');
const { makeMailer, makeNotifier } = require('../src/lib/notify');
const { makeFormatter } = require('../src/lib/format');
const { updateEnvFile, mailServerFor, explainMailError } = require('../scripts/alerts');

const ROOT = path.join(__dirname, '..');
const ALERTS = { to: ['incharge@college.example'], host: 'smtp.college.example', port: 465, user: 'register@college.example',
  pass: 'app-password-123', from: 'register@college.example', perHour: 60 };
const GOOD = { issue_type: 'not_working', description: 'Does not switch on, no light on the front panel.', reporter_name: 'Priya Patil', reporter_ref: '23CS117' };
const KEYS = ['NODE_ENV', 'ALERT_EMAIL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'ALERTS_PER_HOUR', 'BASE_URL', 'SESSION_SECRET', 'GUEST_REPORTS'];

function withEnv(vars, fn) {
  const before = {};
  for (const key of KEYS) { before[key] = process.env[key]; delete process.env[key]; }
  Object.assign(process.env, { NODE_ENV: 'test' }, vars);
  try { return fn(); } finally {
    for (const key of KEYS) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
  }
}

/** A mailbox that records what would have been sent. */
function outbox({ fail = false } = {}) {
  const sent = [];
  return { sent, mailer: { send: async (message) => { if (fail) throw new Error('connect ETIMEDOUT'); sent.push(message); } } };
}
async function guestSend(w, tag, data = GOOD, headers = {}) {
  const agent = request.agent(w.app);
  const csrf = await token(agent, '/e/' + tag);
  return agent.post(`/e/${tag}/report`).set(headers).type('form').send({ _csrf: csrf, ...data });
}

test('alerts are off until an address and a mail server are configured', () => {
  assert.equal(withEnv({}, () => buildConfig().alerts), null);
  const on = withEnv({ ALERT_EMAIL: 'incharge@college.example, hod@college.example', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'register@gmail.com',
    SMTP_PASS: 'abcd efgh ijkl mnop' }, () => buildConfig().alerts);
  assert.deepEqual(on.to, ['incharge@college.example', 'hod@college.example']);
  assert.equal(on.host, 'smtp.gmail.com');
  assert.equal(on.port, 465, 'encrypted from the first byte unless told otherwise');
  assert.equal(on.from, 'register@gmail.com');
  assert.equal(on.perHour, 60);
  assert.equal(withEnv({ ALERT_EMAIL: 'a@b.example', SMTP_HOST: 'h', SMTP_USER: 'u@b.example', SMTP_PASS: 'p', SMTP_PORT: '587' }, () => buildConfig().alerts.port), 587);
});

test('a half-finished or malformed alert setting stops the start with a clear message', () => {
  assert.throws(() => withEnv({ ALERT_EMAIL: 'incharge@college.example' }, () => buildConfig()), /SMTP_HOST, SMTP_USER and SMTP_PASS/);
  assert.throws(() => withEnv({ ALERT_EMAIL: 'not-an-address', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }, () => buildConfig()), /ALERT_EMAIL/);
  assert.throws(() => withEnv({ ALERT_EMAIL: 'a@b.example\nBcc: x@evil.example', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }, () => buildConfig()), /ALERT_EMAIL/);
  assert.throws(() => withEnv({ ALERT_EMAIL: 'a@b.example', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_PORT: '99999' }, () => buildConfig()), /SMTP_PORT/);
});

test('a report sent from the label emails the people in charge', async () => {
  const box = outbox();
  const w = await makeWorld({ alerts: ALERTS, baseUrl: 'https://inventory.college.example' }, { mailer: box.mailer });
  const pc = w.addPc('Desktop computer');
  assert.equal((await guestSend(w, pc.asset_tag)).status, 303);
  assert.equal(box.sent.length, 1);
  const mail = box.sent[0];
  assert.deepEqual(mail.to, ['incharge@college.example']);
  assert.equal(mail.from.address, 'register@college.example');
  assert.match(mail.subject, new RegExp(`R-00001.*${pc.asset_tag}.*LAB-01`));
  assert.match(mail.subject, /Not working/);
  for (const part of ['R-00001', pc.asset_tag, 'Desktop computer', 'Central Computing Centre', 'Does not switch on, no light on the front panel.',
    'Priya Patil', '23CS117', 'not signed in', 'https://inventory.college.example/reports/1']) {
    assert.ok(mail.text.includes(part), `the email mentions "${part}"`);
  }
  assert.equal(mail.html, undefined, 'plain text only: nothing a visitor typed can become markup');
});

test('a report from someone signed in sends the same alert, with their account named', async () => {
  const box = outbox();
  const w = await makeWorld({ alerts: ALERTS }, { mailer: box.mailer });
  const pc = w.addPc();
  const student = await w.as('student');
  const res = await post(student, `/equipment/${pc.id}/report`, { issue_type: 'damaged', description: 'Side panel is bent and loose.' }, `/equipment/${pc.id}/report`);
  assert.equal(res.status, 302);
  assert.equal(box.sent.length, 1);
  assert.match(box.sent[0].text, /Sita Student/);
  assert.match(box.sent[0].text, /23CS001/);
  assert.match(box.sent[0].text, /Side panel is bent and loose\./);
  assert.doesNotMatch(box.sent[0].text, /not signed in/);
});

test('a report is saved even when the mail server cannot be reached', async () => {
  const box = outbox({ fail: true });
  const logged = [];
  const w = await makeWorld({ alerts: ALERTS }, { mailer: box.mailer, log: (line) => logged.push(line) });
  const pc = w.addPc();
  const res = await guestSend(w, pc.asset_tag);
  assert.equal(res.status, 303);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /R-00001/);
  assert.match(logged[0], /ETIMEDOUT/);
  assert.doesNotMatch(logged[0], /app-password-123/, 'the mail password is never written to the log');
});

test('with alerts off, reporting works exactly as before and nothing is sent', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  assert.equal((await guestSend(w, pc.asset_tag)).status, 303);
  assert.equal(w.config.alerts, null);
});

test('what a visitor types cannot change who receives the email or add headers', async () => {
  const box = outbox();
  const w = await makeWorld({ alerts: ALERTS }, { mailer: box.mailer });
  const pc = w.addPc('Desktop computer');
  const res = await guestSend(w, pc.asset_tag, { ...GOOD, reporter_name: 'Eve\r\nBcc: eve@evil.example', reporter_ref: 'x\nTo: eve@evil.example',
    description: 'First line of the problem.\r\nSubject: changed\r\n\r\nSecond line.' });
  assert.equal(res.status, 303);
  const mail = box.sent[0];
  assert.deepEqual(Object.keys(mail).sort(), ['from', 'subject', 'text', 'to']);
  assert.deepEqual(mail.to, ['incharge@college.example']);
  assert.doesNotMatch(mail.subject, /[\r\n]/);
  assert.doesNotMatch(mail.subject, /Eve|evil|changed/, 'the subject is built only from the register');
  assert.match(mail.text, /Second line\./, 'the description is still delivered, as text');
});

test('the link in the email never comes from the request (a forged Host header)', async () => {
  const box = outbox();
  const w = await makeWorld({ alerts: ALERTS }, { mailer: box.mailer }); // no BASE_URL set
  const pc = w.addPc();
  assert.equal((await guestSend(w, pc.asset_tag, GOOD, { Host: 'evil.example' })).status, 303);
  assert.doesNotMatch(box.sent[0].text, /evil\.example|https?:\/\//);
  assert.match(box.sent[0].text, /Problem reports/, 'it says where to look instead');
});

test('a flood of reports cannot become a flood of email', async () => {
  const box = outbox();
  const w = await makeWorld({ alerts: { ...ALERTS, perHour: 2 } }, { mailer: box.mailer });
  for (const name of ['PC one', 'PC two', 'PC three', 'PC four']) {
    const pc = w.addPc(name);
    assert.equal((await guestSend(w, pc.asset_tag)).status, 303);
  }
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 4, 'every report is saved');
  assert.equal(box.sent.length, 3, 'two alerts, then one notice that more are waiting');
  assert.match(box.sent[2].subject, /more reports/i);
  assert.match(box.sent[2].text, /Problem reports/);
});

test('the alert address is private: no page shows it, not even to the administrator', async () => {
  const box = outbox();
  const w = await makeWorld({ alerts: ALERTS }, { mailer: box.mailer });
  const pc = w.addPc();
  const res = await guestSend(w, pc.asset_tag);
  const visitor = request(w.app);
  const secret = /incharge@college\.example|register@college\.example|app-password-123|smtp\.college\.example/;
  for (const page of ['/login', '/e/' + pc.asset_tag, res.headers.location, '/e/PC-99999', '/healthz', '/instance', '/nothing-here']) {
    const got = await visitor.get(page);
    assert.doesNotMatch(got.text, secret, page);
    assert.doesNotMatch(JSON.stringify(got.headers), secret, page);
  }
  const admin = await w.as('admin');
  for (const page of ['/', '/reports', '/reports/1', '/audit', '/account', '/users', '/equipment/' + pc.id]) {
    assert.doesNotMatch((await admin.get(page)).text, secret, page);
  }
  assert.match((await admin.get('/')).text, /Email alerts for new reports: on/);
  assert.doesNotMatch((await (await w.as('staff')).get('/')).text, /Email alerts/, 'only the administrator is told');
  const off = await makeWorld();
  assert.match((await (await off.as('admin')).get('/')).text, /Email alerts for new reports: off/);
});

// ---- the real thing: an actual mail server conversation -----------------------

function mailServer({ user = 'register@college.example', pass = 'app-password-123' } = {}) {
  const received = [];
  const server = new SMTPServer({
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, session, done) {
      if (auth.username === user && auth.password === pass) return done(null, { user });
      done(new Error('Username and Password not accepted'));
    },
    onData(stream, session, done) {
      let raw = '';
      stream.on('data', (chunk) => { raw += chunk; });
      stream.on('end', () => { received.push({ raw, from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map((r) => r.address), secure: session.secure, user: session.user }); done(); });
    },
  });
  server.on('error', () => {});
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.server.address().port })));
}
const close = (server) => new Promise((resolve) => server.close(resolve));

test('alerts travel over an encrypted, signed-in connection to a real mail server', async () => {
  const { server, received, port } = await mailServer();
  try {
    const alerts = { ...ALERTS, host: '127.0.0.1', port };
    const fmt = makeFormatter('Asia/Kolkata');
    const config = { alerts, appName: 'Inventory Register', collegeName: 'College of Engineering', baseUrl: 'https://inventory.college.example' };
    // the test server has a self-made certificate; that one check is relaxed here and nowhere else
    const notify = makeNotifier({ config, fmt, mailer: makeMailer(alerts, { tls: { rejectUnauthorized: false } }) });
    const delivered = await notify.reportCreated({
      id: 51, createdAt: Date.now(), issueType: 'not_working', description: 'Does not start.\nTried two sockets.',
      item: { asset_tag: 'PC-00007', name: 'Desktop computer', location_code: 'LAB-01', location_name: 'Central Computing Centre' },
      reporter: 'Priya Patil (not signed in; gave the number 23CS117)',
    });
    assert.equal(delivered, true);
    assert.equal(received.length, 1);
    const mail = received[0];
    assert.equal(mail.secure, true, 'the connection was upgraded to TLS before anything was sent');
    assert.equal(mail.user, 'register@college.example', 'signed in to the mail server');
    assert.equal(mail.from, 'register@college.example');
    assert.deepEqual(mail.to, ['incharge@college.example']);
    assert.match(mail.raw, /^Subject: New problem report R-00051: PC-00007 \(LAB-01\)/m);
    assert.match(mail.raw, /^To: incharge@college\.example\r?$/m);
    assert.match(mail.raw, /Content-Type: text\/plain/);
    assert.match(mail.raw, /Tried two sockets\./);

    const test1 = await notify.sendTest();
    assert.equal(test1.ok, true);
    assert.equal(received.length, 2);
    assert.match(received[1].raw, /^Subject: .*test/im);
  } finally {
    await close(server);
  }
});

test('a mail server that cannot prove who it is, or a wrong password, sends nothing and says why', async () => {
  const { server, received, port } = await mailServer();
  try {
    const fmt = makeFormatter('Asia/Kolkata');
    const base = { appName: 'Inventory Register', collegeName: 'College of Engineering', baseUrl: '' };
    const alerts = { ...ALERTS, host: '127.0.0.1', port };
    const strict = makeNotifier({ config: { ...base, alerts }, fmt, mailer: makeMailer(alerts), log: () => {} });
    const refused = await strict.sendTest();
    assert.equal(refused.ok, false, 'certificate checking is on by default');
    assert.match(refused.error, /certificate|self.signed/i);

    const wrong = { ...alerts, pass: 'not-the-password' };
    const bad = makeNotifier({ config: { ...base, alerts: wrong }, fmt, mailer: makeMailer(wrong, { tls: { rejectUnauthorized: false } }), log: () => {} });
    const denied = await bad.sendTest();
    assert.equal(denied.ok, false);
    assert.match(denied.error, /not accepted|auth/i);
    assert.equal(received.length, 0);
  } finally {
    await close(server);
  }
});

// ---- setting it up on your own computer -----------------------------------------

test('the settings file is updated without disturbing what is already in it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-env-'));
  const file = path.join(dir, '.env');
  try {
    updateEnvFile(file, { ALERT_EMAIL: 'incharge@college.example', SMTP_PASS: 'abcd efgh ijkl mnop' });
    assert.deepEqual(parseEnvText(fs.readFileSync(file, 'utf8')), { ALERT_EMAIL: 'incharge@college.example', SMTP_PASS: 'abcd efgh ijkl mnop' });

    fs.writeFileSync(file, '# my settings\nCOLLEGE_NAME=Government College of Engineering\nALERT_EMAIL=old@college.example\n\nPORT=3000\n');
    updateEnvFile(file, { ALERT_EMAIL: 'new@college.example', SMTP_HOST: 'smtp.gmail.com', SMTP_PASS: 'p#ss word' });
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^# my settings$/m);
    assert.equal((text.match(/^ALERT_EMAIL=/gm) || []).length, 1, 'replaced, not repeated');
    assert.deepEqual(parseEnvText(text), { COLLEGE_NAME: 'Government College of Engineering', ALERT_EMAIL: 'new@college.example', PORT: '3000',
      SMTP_HOST: 'smtp.gmail.com', SMTP_PASS: 'p#ss word' });
    assert.throws(() => updateEnvFile(file, { SMTP_PASS: 'two\nlines' }), /line/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the example settings file means what its comments say when copied as it is', () => {
  const example = parseEnvText(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'));
  assert.equal(example.GUEST_REPORTS, '1');
  assert.equal(example.SESSION_IDLE_MINUTES, '120');
  assert.equal(example.TRUST_PROXY, '1');
  assert.equal(example.COLLEGE_NAME, 'Your College Name');
  assert.equal(example.ALERT_EMAIL, undefined, 'alerts stay off until someone fills them in');
  for (const [key, value] of Object.entries(example)) assert.doesNotMatch(value, /\s#/, `${key} must not carry its comment`);
  // quoted values keep everything, including # and spaces
  assert.deepEqual(parseEnvText('A="x # y"\nB=\'p q\'\nC=plain   # note\nD=has#hash\n# E=off\nF='), { A: 'x # y', B: 'p q', C: 'plain', D: 'has#hash', F: '' });
});

test('setup knows the usual mail servers and explains the usual failures in plain words', () => {
  assert.deepEqual(mailServerFor('someone@gmail.com'), { host: 'smtp.gmail.com', port: 465 });
  assert.deepEqual(mailServerFor('Someone@GoogleMail.com'), { host: 'smtp.gmail.com', port: 465 });
  assert.equal(mailServerFor('someone@college.example'), null);
  assert.match(explainMailError('Invalid login: 535-5.7.8 Username and Password not accepted'), /app password/i);
  assert.match(explainMailError('Invalid login: 534-5.7.9 Application-specific password required'), /app password/i);
  assert.match(explainMailError('connect ETIMEDOUT 142.250.1.109:465'), /network|Wi-Fi|firewall/i);
  assert.match(explainMailError('getaddrinfo ENOTFOUND smtp.gmail.com'), /internet/i);
});

test('nothing private is kept in the project files that get shared', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.env$/m, 'the settings file is never committed');
  const shared = ['.env.example', 'README.md', 'render.yaml', 'package.json'];
  for (const name of shared) {
    const text = fs.readFileSync(path.join(ROOT, name), 'utf8');
    assert.doesNotMatch(text, /@gmail\.com/i, `${name} holds no personal address`);
    assert.doesNotMatch(text, /\b[6-9]\d{9}\b/, `${name} holds no phone number`);
  }
});
