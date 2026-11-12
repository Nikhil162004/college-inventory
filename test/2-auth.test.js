'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, signIn, post, token, PASSWORD, request } = require('./helpers');

test('anonymous visitors are sent to sign in, and brought back afterwards', async () => {
  const w = await makeWorld();
  const pc = w.addPc();
  for (const path of ['/', '/equipment', '/users', '/audit', '/reports/1', '/no-such-page']) {
    const res = await request(w.app).get(path);
    assert.equal(res.status, 302, path);
    assert.match(res.headers.location, /^\/login/, path);
  }
  // Scanning a label now opens the visitor's report form (test/11); its "sign in"
  // link, and every protected page, still bring people back to where they were going.
  const scan = await request(w.app).get('/e/' + pc.asset_tag);
  assert.equal(scan.status, 200);
  assert.ok(scan.text.includes('href="/login?next=' + encodeURIComponent('/e/' + pc.asset_tag) + '"'));
  const item = await request(w.app).get('/equipment/' + pc.id);
  assert.equal(item.headers.location, '/login?next=' + encodeURIComponent('/equipment/' + pc.id));
  const { res } = await signIn(w.app, '23CS001', PASSWORD, { next: '/e/' + pc.asset_tag });
  assert.equal(res.headers.location, '/e/' + pc.asset_tag, 'scanned QR destination survives sign-in');
});

test('sign-in cannot be used as an open redirect', async () => {
  const w = await makeWorld();
  for (const next of ['//evil.example', 'https://evil.example/x', '/\\evil.example']) {
    const { res } = await signIn(w.app, '23CS001', PASSWORD, { next });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/');
  }
});

test('wrong ID and wrong password give the same answer', async () => {
  const w = await makeWorld();
  const a = (await signIn(w.app, '23CS001', 'wrong password here')).res;
  const b = (await signIn(w.app, 'NOBODY99', 'wrong password here')).res;
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  const strip = (html) => html.replace(/name="_csrf" value="[^"]+"/, '').replace(/value="(23CS001|NOBODY99)"/, '');
  assert.equal(strip(a.text), strip(b.text), 'the page must not reveal whether the ID exists');
});

test('the session cookie is HttpOnly + SameSite and the ID changes at sign-in', async () => {
  const w = await makeWorld();
  const agent = request.agent(w.app);
  const first = await agent.get('/login');
  const before = /sid=([^;]+)/.exec(String(first.headers['set-cookie']))[1];
  const csrf = /name="_csrf" value="([^"]+)"/.exec(first.text)[1];
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, college_id: '23cs001', password: PASSWORD });
  assert.equal(res.status, 302);
  const cookie = String(res.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const after = /sid=([^;]+)/.exec(cookie)[1];
  assert.notEqual(after, before, 'session fixation: the pre-login session ID must not survive');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get(decodeURIComponent(before).slice(2).split('.')[0]).n, 0);
});

test('behind HTTPS the cookie is Secure and uses the __Host- prefix', async () => {
  const w = await makeWorld({ cookieSecure: true, trustProxy: 1 });
  const res = await request(w.app).get('/login').set('X-Forwarded-Proto', 'https');
  const cookie = String(res.headers['set-cookie']);
  assert.match(cookie, /^__Host-sid=/);
  assert.match(cookie, /Secure/);
  assert.match(res.headers['strict-transport-security'], /max-age=\d+/);
});

test('an account locks after 5 wrong passwords, even for the right password', async () => {
  const w = await makeWorld();
  for (let i = 0; i < 5; i++) {
    assert.equal((await signIn(w.app, '23CS001', 'wrong password ' + i)).res.status, 401);
  }
  const locked = await signIn(w.app, '23CS001', PASSWORD);
  assert.equal(locked.res.status, 401, 'correct password is refused while locked');
  assert.ok(w.db.prepare("SELECT 1 FROM audit_log WHERE action = 'login.locked'").get());
  // Another account is unaffected, and the lock expires.
  assert.equal((await signIn(w.app, '23CS002', PASSWORD)).res.status, 302);
  w.db.prepare('UPDATE users SET locked_until = ? WHERE college_id = ?').run(Date.now() - 1000, '23CS001');
  assert.equal((await signIn(w.app, '23CS001', PASSWORD)).res.status, 302);
});

test('repeated failures from one address are rate limited', async () => {
  const w = await makeWorld({ loginRateLimit: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await signIn(w.app, 'GHOST' + i, 'whatever whatever')).res.status, 401);
  assert.equal((await signIn(w.app, 'GHOST9', 'whatever whatever')).res.status, 429);
  assert.equal((await signIn(w.app, '23CS001', PASSWORD)).res.status, 429, 'blocked even with a correct password');
});

test('forms without a valid CSRF token are refused', async () => {
  const w = await makeWorld();
  const noToken = await request(w.app).post('/login').type('form').send({ college_id: '23CS001', password: PASSWORD });
  assert.equal(noToken.status, 403);
  const agent = await w.as('admin');
  const pc = w.addPc();
  const forged = await agent.post(`/equipment/${pc.id}/retire`).type('form').send({ reason: 'forged request' });
  assert.equal(forged.status, 403);
  const wrong = await agent.post(`/equipment/${pc.id}/retire`).type('form').send({ _csrf: 'A'.repeat(43), reason: 'forged request' });
  assert.equal(wrong.status, 403);
  assert.equal(w.db.prepare('SELECT status FROM equipment WHERE id = ?').get(pc.id).status, 'working');
  // A token from someone else's session does not work either.
  const other = await w.as('staff');
  const stolen = await token(other, '/');
  const cross = await agent.post(`/equipment/${pc.id}/retire`).type('form').send({ _csrf: stolen, reason: 'forged request' });
  assert.equal(cross.status, 403);
});

test('sessions of visitors who never sign in expire quickly; signed-in sessions get the normal lifetime', async () => {
  const w = await makeWorld();
  const agent = request.agent(w.app);
  const csrf = await token(agent, '/login');
  const anonymous = w.db.prepare('SELECT expires_at FROM sessions').get();
  assert.ok(anonymous.expires_at - Date.now() <= 30 * 60 * 1000 + 1000);
  await agent.post('/login').type('form').send({ _csrf: csrf, college_id: '23CS001', password: PASSWORD });
  const signedIn = w.db.prepare('SELECT expires_at FROM sessions WHERE user_id = ?').get(w.ids.student);
  assert.ok(signedIn.expires_at - Date.now() > 60 * 60 * 1000, 'idle timeout of two hours after sign-in');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'the anonymous session was replaced, not kept');
  // Expired sessions are refused and can be pruned.
  w.db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await agent.get('/')).status, 302);
});

test('sign-out ends the session on the server', async () => {
  const w = await makeWorld();
  const agent = await w.as('student');
  assert.equal((await agent.get('/')).status, 200);
  const out = await post(agent, '/logout');
  assert.equal(out.headers.location, '/login');
  assert.equal((await agent.get('/')).status, 302);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(w.ids.student).n, 0);
});

test('a temporary password must be replaced before anything else', async () => {
  const w = await makeWorld();
  w.db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(w.ids.student);
  const { agent, res } = await signIn(w.app, '23CS001', PASSWORD);
  assert.equal(res.headers.location, '/account/password');
  for (const path of ['/', '/reports', '/account']) {
    assert.equal((await agent.get(path)).headers.location, '/account/password', path);
  }
  const weak = await post(agent, '/account/password', { current_password: PASSWORD, new_password: 'password123', confirm_password: 'password123' }, '/account/password');
  assert.equal(weak.status, 422);
  const mismatch = await post(agent, '/account/password', { current_password: PASSWORD, new_password: 'mango tree by the gate', confirm_password: 'different entirely' }, '/account/password');
  assert.equal(mismatch.status, 422);
  const ok = await post(agent, '/account/password', { current_password: PASSWORD, new_password: 'mango tree by the gate', confirm_password: 'mango tree by the gate' }, '/account/password');
  assert.equal(ok.status, 302);
  assert.equal((await agent.get('/')).status, 200);
  assert.equal((await signIn(w.app, '23CS001', PASSWORD)).res.status, 401, 'old password no longer works');
  assert.equal((await signIn(w.app, '23CS001', 'mango tree by the gate')).res.status, 302);
});

test('changing the password signs out every other device', async () => {
  const w = await makeWorld();
  const laptop = await w.as('faculty');
  const phone = await w.as('faculty');
  const wrong = await post(laptop, '/account/password', { current_password: 'not my password', new_password: 'mango tree by the gate', confirm_password: 'mango tree by the gate' }, '/account/password');
  assert.equal(wrong.status, 422);
  const ok = await post(laptop, '/account/password', { current_password: PASSWORD, new_password: 'mango tree by the gate', confirm_password: 'mango tree by the gate' }, '/account/password');
  assert.equal(ok.status, 302);
  assert.equal((await laptop.get('/')).status, 200, 'this device stays signed in');
  assert.equal((await phone.get('/')).status, 302, 'the other device is signed out');
});

test('deactivating an account takes effect on the very next request', async () => {
  const w = await makeWorld();
  const agent = await w.as('student');
  assert.equal((await agent.get('/')).status, 200);
  w.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(w.ids.student);
  assert.equal((await agent.get('/')).status, 302);
  assert.equal((await signIn(w.app, '23CS001', PASSWORD)).res.status, 401);
});

test('sessions end after the absolute time limit', async () => {
  const w = await makeWorld();
  const agent = await w.as('student');
  const row = w.db.prepare('SELECT sid, data FROM sessions WHERE user_id = ?').get(w.ids.student);
  const data = JSON.parse(row.data);
  data.loginAt = Date.now() - w.config.sessionAbsoluteMs - 1000;
  w.db.prepare('UPDATE sessions SET data = ? WHERE sid = ?').run(JSON.stringify(data), row.sid);
  assert.equal((await agent.get('/')).status, 302);
});
