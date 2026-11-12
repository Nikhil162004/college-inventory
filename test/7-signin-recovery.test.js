'use strict';
// Sign-in must never end in a dead end. These tests cover every way the sign-in
// form can reach the server after the visitor's short-lived session is gone:
// the page was left open, the server was restarted, or the browser kept no cookie.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, token, PASSWORD, request } = require('./helpers');

const tokenIn = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];
const signedInSessions = (w) => w.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id IS NOT NULL').get().n;
const audits = (w, action) => w.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n;

test('a sign-in form that has gone stale is handed back fresh instead of "Form expired"', async () => {
  const w = await makeWorld();
  const agent = request.agent(w.app);
  const stale = await token(agent, '/login');
  w.db.prepare('DELETE FROM sessions').run(); // page left open too long, or the server was restarted

  const res = await agent.post('/login').type('form').send({ _csrf: stale, college_id: '23cs001', password: PASSWORD });
  assert.equal(res.status, 403, 'the stale form itself is still refused');
  assert.doesNotMatch(res.text, /Form expired/);
  assert.match(res.text, /<form method="post" action="\/login"/, 'the sign-in form is shown again');
  assert.match(res.text, /has been refreshed/);
  assert.match(res.text, /value="23CS001"/, 'the college ID does not have to be typed again');
  assert.doesNotMatch(res.text, new RegExp(PASSWORD), 'the password is never sent back');
  assert.match(res.text, /<input id="password"[^>]* autofocus>/, 'the cursor starts in the password box');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(signedInSessions(w), 0, 'nobody was signed in by the stale form');
  assert.equal(audits(w, 'login'), 0);

  // The form that came back works straight away.
  const retry = await agent.post('/login').type('form').send({ _csrf: tokenIn(res.text), college_id: '23CS001', password: PASSWORD });
  assert.equal(retry.status, 302);
  assert.equal(retry.headers.location, '/');
  assert.equal((await agent.get('/')).status, 200);
});

test('a stale sign-in form never checks the password, so it cannot lock an account', async () => {
  const w = await makeWorld();
  for (let i = 0; i < 8; i++) {
    const res = await request(w.app).post('/login').type('form').send({ _csrf: 'A'.repeat(43), college_id: '23CS001', password: 'wrong wrong wrong' });
    assert.equal(res.status, 403);
  }
  const user = w.db.prepare('SELECT failed_logins, locked_until FROM users WHERE college_id = ?').get('23CS001');
  assert.equal(user.failed_logins, 0);
  assert.equal(user.locked_until, null);
  assert.equal(audits(w, 'login.failed'), 0);
});

test('a forged sign-in from another site is still refused', async () => {
  const w = await makeWorld();
  const victim = request.agent(w.app);
  await victim.get('/login');
  // What an attacker's page can send: the right credentials, but no token.
  const forged = await victim.post('/login').type('form').send({ college_id: 'ADMIN01', password: PASSWORD });
  assert.equal(forged.status, 403);
  assert.equal(signedInSessions(w), 0);
  assert.equal((await victim.get('/')).status, 302, 'the browser is not signed in afterwards');
  // A token from somebody else's visit does not help either.
  const other = await token(request.agent(w.app), '/login');
  const borrowed = await victim.post('/login').type('form').send({ _csrf: other, college_id: 'ADMIN01', password: PASSWORD });
  assert.equal(borrowed.status, 403);
  assert.equal(signedInSessions(w), 0);
});

test('when the browser keeps no cookie at all, the page says so instead of looping', async () => {
  const w = await makeWorld();
  // First try: could simply be an old page, so it is refreshed and marked.
  const first = await request(w.app).post('/login').type('form').send({ _csrf: 'A'.repeat(43), college_id: '23CS001', password: PASSWORD });
  assert.equal(first.status, 403);
  assert.match(first.text, /has been refreshed/);
  assert.match(first.text, /name="_again" value="1"/);
  // Second try from the fresh form, and still no cookie came back: cookies are blocked.
  const second = await request(w.app).post('/login').type('form')
    .send({ _csrf: tokenIn(first.text), _again: '1', college_id: '23CS001', password: PASSWORD });
  assert.equal(second.status, 403);
  assert.match(second.text, /cookie/i);
  assert.doesNotMatch(second.text, /has been refreshed/);
  assert.doesNotMatch(second.text, /own tab/, 'the preview advice is not shown on a normal installation');
  assert.match(second.text, /<form method="post" action="\/login"/);
});

test('in the hosted preview the cookie message offers to open the site in its own tab', async () => {
  const w = await makeWorld({ embedPreview: true, cookieSecure: true });
  const res = await request(w.app).post('/login').type('form')
    .send({ _csrf: 'A'.repeat(43), _again: '1', college_id: '23CS001', password: PASSWORD });
  assert.equal(res.status, 403);
  assert.match(res.text, /own tab/);
  assert.match(res.text, /<a href="\/login" target="_blank" rel="noopener">/);
});

test('the refreshed sign-in form keeps a safe destination and escapes what was typed', async () => {
  const w = await makeWorld();
  const send = (body) => request(w.app).post('/login').type('form').send({ _csrf: 'A'.repeat(43), password: 'x', ...body });
  const kept = await send({ college_id: '23CS001', next: '/e/PC-00001' });
  assert.match(kept.text, /name="next" value="\/e\/PC-00001"/, 'a scanned QR code still leads to its equipment');
  const evil = await send({ college_id: '23CS001', next: '//evil.example/x' });
  assert.doesNotMatch(evil.text, /evil\.example/);
  const xss = await send({ college_id: '"><script>alert(1)</script>' });
  assert.doesNotMatch(xss.text, /<script>alert/);
});

test('a form sent after the session has ended leads to sign-in with an explanation', async () => {
  const w = await makeWorld();
  const staff = await w.as('staff');
  const csrf = await token(staff, '/equipment/new');
  w.db.prepare('DELETE FROM sessions').run(); // idle for too long
  const before = w.db.prepare('SELECT COUNT(*) AS n FROM equipment').get().n;

  const res = await staff.post('/equipment').type('form')
    .send({ _csrf: csrf, name: 'Oscilloscope', category_id: w.pcCategory, location_id: w.lab1, quantity: 1 });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/login');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM equipment').get().n, before, 'nothing was saved');

  const page = await staff.get('/login');
  assert.match(page.text, /signed out/i);
  assert.match(page.text, /not saved/i);
  assert.doesNotMatch((await staff.get('/login')).text, /not saved/i, 'the explanation is shown once');
});

test('signing out after the session has already ended just shows the sign-in page', async () => {
  const w = await makeWorld();
  const student = await w.as('student');
  const csrf = await token(student, '/');
  w.db.prepare('DELETE FROM sessions').run();
  const res = await student.post('/logout').type('form').send({ _csrf: csrf });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/login');
  assert.doesNotMatch((await student.get('/login')).text, /not saved/i);
});

test('an old sign-in tab used after signing in elsewhere goes to the overview', async () => {
  const w = await makeWorld();
  const agent = request.agent(w.app);
  const oldTab = await token(agent, '/login');
  const signIn = await agent.post('/login').type('form').send({ _csrf: oldTab, college_id: '23CS001', password: PASSWORD });
  assert.equal(signIn.status, 302);
  // The first tab still shows the sign-in form with the token from before.
  const res = await agent.post('/login').type('form').send({ _csrf: oldTab, college_id: 'ADMIN01', password: PASSWORD });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/');
  const home = await agent.get('/');
  assert.match(home.text, /Sita Student/, 'still signed in as the same person');
  assert.doesNotMatch(home.text, /Asha Admin/);
});

test('a signed-in person sending a wrong token still gets a refusal, and nothing changes', async () => {
  const w = await makeWorld();
  const admin = await w.as('admin');
  const pc = w.addPc();
  const res = await admin.post(`/equipment/${pc.id}/retire`).type('form').send({ _csrf: 'A'.repeat(43), reason: 'forged request' });
  assert.equal(res.status, 403);
  assert.match(res.text, /Form expired/);
  assert.equal(w.db.prepare('SELECT status FROM equipment WHERE id = ?').get(pc.id).status, 'working');
});

test('the sign-in page tells the browser how long its form stays valid', async () => {
  const w = await makeWorld();
  const page = await request(w.app).get('/login?next=/e/PC-00001');
  const m = /data-fresh-for="(\d+)"/.exec(page.text);
  assert.ok(m, 'the form carries its lifetime');
  const session = w.db.prepare('SELECT expires_at FROM sessions').get();
  assert.ok(Number(m[1]) * 1000 < session.expires_at - Date.now(), 'the page renews itself before the form goes stale');
  assert.match(page.text, /data-fresh-url="\/login\?next=%2Fe%2FPC-00001"/);
});

// ---------------------------------------------------------------------------
// Signing in from a stale page on the first try.
//
// Browsers tell the server where a form was submitted from (Sec-Fetch-Site, or
// Origin on older browsers). A page on another website cannot fake that. When a
// sign-in form with a stale token demonstrably came from this site's own
// sign-in page, the person is signed in instead of being asked to type again.
// ---------------------------------------------------------------------------
const stalePost = (target, headers, body = {}) => {
  const req = target.post('/login').type('form');
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send({ _csrf: 'A'.repeat(43), college_id: '23CS001', password: PASSWORD, ...body });
};
const OWN_PAGE = { 'Sec-Fetch-Site': 'same-origin' };

test('a stale sign-in page that was submitted from this site signs in on the first try', async () => {
  const w = await makeWorld();
  const agent = request.agent(w.app);
  await agent.get('/login');
  w.db.prepare('DELETE FROM sessions').run(); // the server was restarted since the page was shown

  const res = await stalePost(agent, OWN_PAGE, { next: '/e/PC-00001' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login/check?next=%2Fe%2FPC-00001', 'first confirms that the browser kept the cookie');
  const check = await agent.get(res.headers.location);
  assert.equal(check.status, 302);
  assert.equal(check.headers.location, '/e/PC-00001');
  assert.match((await agent.get('/')).text, /Sita Student/);
  assert.equal(signedInSessions(w), 1);
  assert.equal(audits(w, 'login'), 1);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'no leftover visitor session');
});

test('on that path the password is still checked, counted and locked like any other sign-in', async () => {
  const w = await makeWorld();
  for (let i = 0; i < 4; i++) {
    const res = await stalePost(request(w.app), OWN_PAGE, { password: 'wrong wrong wrong' });
    assert.equal(res.status, 401);
    assert.match(res.text, /college ID or password is incorrect/);
  }
  assert.equal(w.db.prepare('SELECT failed_logins FROM users WHERE college_id = ?').get('23CS001').failed_logins, 4);
  await stalePost(request(w.app), OWN_PAGE, { password: 'wrong wrong wrong' });
  assert.ok(w.db.prepare('SELECT locked_until FROM users WHERE college_id = ?').get('23CS001').locked_until > Date.now(), 'locked after five');
  const locked = await stalePost(request(w.app), OWN_PAGE);
  assert.equal(locked.status, 401, 'the correct password is refused while locked');
  assert.equal(signedInSessions(w), 0);
  // The per-network limit on failed sign-ins applies too.
  const w2 = await makeWorld({ loginRateLimit: 2 });
  for (let i = 0; i < 2; i++) await stalePost(request(w2.app), OWN_PAGE, { college_id: 'GHOST' + i });
  assert.equal((await stalePost(request(w2.app), OWN_PAGE)).status, 429);
});

test('a sign-in form sent from any other site is refused whatever else it claims', async () => {
  const w = await makeWorld();
  const forgeries = [
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },                       // a sister site on the same domain is not this site
    { 'Sec-Fetch-Site': 'none' },
    { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://127.0.0.1' },
    { Origin: 'https://evil.example' },
    { Origin: 'null' },                                      // sandboxed frames, data: pages
    { Origin: 'not a url' },
    { Referer: 'http://127.0.0.1/login' },                   // a Referer alone proves nothing
    {},
  ];
  for (const headers of forgeries) {
    const victim = request.agent(w.app);
    await victim.get('/login');
    const res = await stalePost(victim, headers, { college_id: 'ADMIN01' });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal((await victim.get('/')).status, 302, 'not signed in: ' + JSON.stringify(headers));
  }
  assert.equal(signedInSessions(w), 0);
  assert.equal(audits(w, 'login'), 0);
  assert.equal(audits(w, 'login.failed'), 0, 'the passwords were never even looked at');
});

test('older browsers without Sec-Fetch-Site are recognised by a matching Origin', async () => {
  const w = await makeWorld();
  // A real listening server, so that every request below goes to the same address.
  const server = require('node:http').createServer(w.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = '127.0.0.1:' + server.address().port;
  try {
    const otherPort = await stalePost(request(server), { Origin: 'http://127.0.0.1:1' });
    assert.equal(otherPort.status, 403);
    const otherScheme = await stalePost(request(server), { Origin: 'https://' + host });
    assert.equal(otherScheme.status, 403);
    const good = await stalePost(request(server), { Origin: 'http://' + host });
    assert.equal(good.status, 302);
    assert.equal(good.headers.location, '/login/check');
  } finally {
    server.close();
  }
  // The configured public address counts as this site as well.
  const w2 = await makeWorld({ baseUrl: 'https://inventory.college.example' });
  const viaProxy = await stalePost(request(w2.app), { Origin: 'https://inventory.college.example' });
  assert.equal(viaProxy.status, 302);
  const lookalike = await stalePost(request(w2.app), { Origin: 'https://inventory.college.example.evil.example' });
  assert.equal(lookalike.status, 403);
});

test('if the browser then does not keep the cookie, the check page says so', async () => {
  const w = await makeWorld();
  const res = await stalePost(request(w.app), OWN_PAGE);     // no cookie jar: every cookie is dropped
  assert.equal(res.status, 302);
  const check = await request(w.app).get(res.headers.location);
  assert.equal(check.status, 200);
  assert.match(check.text, /did not send back this site's cookie/);
  assert.doesNotMatch(check.text, /has been refreshed/);
  assert.match(check.text, /<form method="post" action="\/login"/);
  assert.doesNotMatch(check.text, /own tab/);
  assert.doesNotMatch(check.text, /Preview details/, 'diagnostics are for the hosted preview only');
  assert.equal(check.headers['cache-control'], 'no-store');

  const preview = await makeWorld({ embedPreview: true, cookieSecure: true });
  const viaPreview = await request(preview.app).get('/login/check');
  assert.match(viaPreview.text, /own tab/);
  assert.match(viaPreview.text, /Preview details: cookie not received/);
});

test('the check page only ever leads to a page on this site', async () => {
  const w = await makeWorld();
  const student = await w.as('student');
  assert.equal((await student.get('/login/check')).headers.location, '/');
  assert.equal((await student.get('/login/check?next=/reports')).headers.location, '/reports');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '/login/check']) {
    const res = await student.get('/login/check?next=' + encodeURIComponent(bad));
    assert.equal(res.headers.location, '/', bad);
  }
  // Somebody who must choose a new password is still sent there first.
  w.db.prepare('UPDATE users SET must_change_password = 1 WHERE college_id = ?').run('23CS002');
  const agent = request.agent(w.app);
  const res = await stalePost(agent, OWN_PAGE, { college_id: '23CS002', next: '/reports' });
  assert.equal((await agent.get(res.headers.location)).headers.location, '/account/password');
});

test('only the sign-in form is treated this way: every other form still needs its token', async () => {
  const w = await makeWorld();
  const admin = await w.as('admin');
  const pc = w.addPc();
  // Signed in, wrong token, even from the site itself: refused.
  const res = await admin.post(`/equipment/${pc.id}/retire`).type('form').set('Sec-Fetch-Site', 'same-origin')
    .send({ _csrf: 'A'.repeat(43), reason: 'forged request' });
  assert.equal(res.status, 403);
  assert.match(res.text, /Form expired/);
  assert.equal(w.db.prepare('SELECT status FROM equipment WHERE id = ?').get(pc.id).status, 'working');
  // Signed out: nothing is saved and the person is sent to sign in.
  const before = w.db.prepare('SELECT COUNT(*) AS n FROM equipment').get().n;
  const anon = await request(w.app).post('/equipment').type('form').set('Sec-Fetch-Site', 'same-origin')
    .send({ _csrf: 'A'.repeat(43), name: 'Oscilloscope', category_id: w.pcCategory, location_id: w.lab1, quantity: 1 });
  assert.equal(anon.status, 303);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM equipment').get().n, before);
  // Signed in already and an old sign-in tab is used: stays the same person.
  const student = await w.as('student');
  const again = await stalePost(student, OWN_PAGE, { college_id: 'ADMIN01' });
  assert.equal(again.status, 303);
  assert.match((await student.get('/')).text, /Sita Student/);
});

test('a sign-in with a valid token is unchanged and goes straight to its destination', async () => {
  const w = await makeWorld();
  const agent = request.agent(w.app);
  const csrf = await token(agent, '/login');
  const res = await agent.post('/login').type('form').set('Sec-Fetch-Site', 'same-origin')
    .send({ _csrf: csrf, college_id: '23CS001', password: PASSWORD, next: '/reports' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/reports');
});

// ---------------------------------------------------------------------------
// The sign-in page can tell that the server has been restarted since it was
// shown, and fetches itself again before anything is typed.
// ---------------------------------------------------------------------------
test('the server reports an instance id that changes on restart and reveals nothing else', async () => {
  const w = await makeWorld();
  const res = await request(w.app).get('/instance');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/plain/);
  assert.match(res.text, /^[A-Za-z0-9_-]{10,24}$/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['access-control-allow-origin'], '*', 'readable from a sandboxed preview frame');
  assert.equal(res.headers['access-control-allow-credentials'], undefined, 'never together with cookies');
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'asking does not create a session');
  assert.equal((await request(w.app).get('/instance')).text, res.text, 'stable while the server runs');
  const restarted = await makeWorld();
  assert.notEqual((await request(restarted.app).get('/instance')).text, res.text, 'different after a restart');
  // Only GET: it is not a way to send anything to the server.
  assert.notEqual((await request(w.app).post('/instance')).status, 200);
});

test('the sign-in form records which server instance produced it', async () => {
  const w = await makeWorld();
  const id = (await request(w.app).get('/instance')).text;
  const page = await request(w.app).get('/login');
  assert.match(page.text, new RegExp(`data-instance="${id}"`));
  const admin = await w.as('admin');
  assert.doesNotMatch((await admin.get('/')).text, /data-instance/, 'only the sign-in page needs it');
});
