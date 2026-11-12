'use strict';
// The hosted demo preview shows the site inside a frame on another website.
// Some browsers do not return cookies there, and without a cookie nobody can
// stay signed in. In preview mode ONLY, the session is then carried in the
// address of every link and form instead (parameter "_ps").
//
// These tests also pin down that none of this exists outside preview mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, token, PASSWORD, request } = require('./helpers');

const PREVIEW = { embedPreview: true, cookieSecure: true };
const tokenIn = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];
const decode = (s) => s.replace(/&amp;/g, '&');
/** Address of the POST form whose action starts with `prefix`. */
const actionOf = (html, prefix) => {
  const m = new RegExp(`<form method="post" action="(${prefix.replace(/[/.]/g, '\\$&')}[^"]*)"`).exec(html);
  assert.ok(m, 'form posting to ' + prefix);
  return decode(m[1]);
};
/** Every local link and form address on a page that should carry the session. */
function addresses(html) {
  const out = [];
  for (const tag of html.match(/<a\b[^>]*>/g) || []) {
    const href = /\shref="([^"]*)"/.exec(tag);
    if (!href || !href[1].startsWith('/') || href[1].startsWith('/static/') || /target="_blank"/.test(tag)) continue;
    out.push(decode(href[1]));
  }
  for (const tag of html.match(/<form\b[^>]*>/g) || []) {
    if (/method="post"/.test(tag)) out.push(decode(/\saction="([^"]*)"/.exec(tag)[1]));
  }
  return out;
}

/** A browser that never sends a cookie: every request is made from scratch. */
async function signInWithoutCookies(app, collegeId) {
  const page = await request(app).get('/login');
  const action = actionOf(page.text, '/login');
  const res = await request(app).post(action).type('form').send({ _csrf: tokenIn(page.text), college_id: collegeId, password: PASSWORD });
  return { page, action, res };
}

test('preview: a browser that returns no cookies can sign in and stays signed in from page to page', async () => {
  const w = await makeWorld(PREVIEW);
  const { action, res } = await signInWithoutCookies(w.app, 'STF001');
  assert.match(action, /^\/login\?_ps=/, 'the sign-in form carries the visit in its address');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/\?_ps=s%3A/, 'and so does the way onward');

  const home = await request(w.app).get(res.headers.location);
  assert.equal(home.status, 200);
  assert.match(home.text, /Sam Staff/);
  const links = addresses(home.text);
  assert.ok(links.length > 8);
  for (const url of links) assert.match(url, /[?&]_ps=s%3A/, 'carries the session: ' + url);
  assert.doesNotMatch(home.text, /_ps=[^"]*_ps=/, 'never added twice');

  // Follow a link, then a link on that page.
  const equipmentUrl = links.find((u) => u.startsWith('/equipment?'));
  const list = await request(w.app).get(equipmentUrl);
  assert.equal(list.status, 200);
  assert.match(list.text, /<h1[^>]*>Equipment/);
  const labs = await request(w.app).get(addresses(list.text).find((u) => u.startsWith('/locations?')));
  assert.match(labs.text, /Central Computing Centre/);
});

test('preview without cookies: search forms, adding equipment, reporting and resolving all work', async () => {
  const w = await makeWorld(PREVIEW);
  const staff = (await signInWithoutCookies(w.app, 'STF001')).res.headers.location;
  const ps = /_ps=([^&]+)/.exec(staff)[1];

  // Add equipment through the form (POST), then land on the new item.
  const form = await request(w.app).get('/equipment/new?_ps=' + ps);
  const created = await request(w.app).post(actionOf(form.text, '/equipment')).type('form')
    .send({ _csrf: tokenIn(form.text), name: 'Storage oscilloscope', category_id: w.pcCategory, location_id: w.lab1, quantity: 1 });
  assert.equal(created.status, 302);
  assert.match(created.headers.location, /^\/equipment\/\d+\?_ps=/);
  const item = await request(w.app).get(created.headers.location);
  assert.match(item.text, /Storage oscilloscope/);
  assert.match(item.text, /has been added|added/i, 'the confirmation message survives the redirect');

  // A search form (GET) keeps the session through a hidden field.
  const list = await request(w.app).get('/equipment?_ps=' + ps);
  const search = /<form method="get" action="\/equipment"[^>]*>\s*<input type="hidden" name="_ps" value="([^"]+)">/.exec(list.text);
  assert.ok(search, 'hidden session field in the search form');
  const found = await request(w.app).get('/equipment').query({ q: 'oscilloscope', _ps: search[1] });
  assert.equal(found.status, 200);
  assert.match(found.text, /Storage oscilloscope/);
  assert.match(found.text, /value="oscilloscope"/);
  assert.doesNotMatch(found.text, /name="q" value="[^"]*_ps/, 'the session never leaks into the search box');

  // A student reports it; staff resolve it.
  const student = (await signInWithoutCookies(w.app, '23CS001')).res.headers.location;
  const sps = /_ps=([^&]+)/.exec(student)[1];
  const tag = /[A-Z]+-\d{5}/.exec(item.text)[0];
  const scanned = await request(w.app).get(`/e/${tag}?_ps=${sps}`);
  assert.equal(scanned.status, 302);
  const reportForm = await request(w.app).get(scanned.headers.location.replace(/\?/, '/report?'));
  const filed = await request(w.app).post(actionOf(reportForm.text, '/equipment')).type('form')
    .send({ _csrf: tokenIn(reportForm.text), issue_type: 'not_working', description: 'No trace on either channel.' });
  assert.equal(filed.status, 302, filed.text.slice(0, 200));
  assert.match(filed.headers.location, /^\/reports\/\d+\?_ps=/);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 1);
  const reportPage = await request(w.app).get(filed.headers.location.replace(/_ps=[^&]+/, '_ps=' + ps));
  const done = await request(w.app).post(actionOf(reportPage.text, '/reports')).type('form')
    .send({ _csrf: tokenIn(reportPage.text), status: 'resolved', note: 'Probe replaced.' });
  assert.equal(done.status, 302);
  assert.equal(w.db.prepare('SELECT status FROM reports').get().status, 'resolved');
});

test('preview without cookies: signing out ends it, and the old address stops working', async () => {
  const w = await makeWorld(PREVIEW);
  const { res } = await signInWithoutCookies(w.app, '23CS001');
  const home = await request(w.app).get(res.headers.location);
  const out = await request(w.app).post(actionOf(home.text, '/logout')).type('form').send({ _csrf: tokenIn(home.text) });
  assert.equal(out.status, 302);
  assert.equal(out.headers.location, '/login', 'no session is carried after signing out');
  const again = await request(w.app).get(res.headers.location);
  assert.equal(again.status, 302);
  assert.match(again.headers.location, /^\/login/);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id IS NOT NULL').get().n, 0);
});

test('preview without cookies: the session cannot be forged, and the app itself never sees the parameter', async () => {
  const w = await makeWorld(PREVIEW);
  const { res } = await signInWithoutCookies(w.app, 'ADMIN01');
  const good = decodeURIComponent(/_ps=([^&]+)/.exec(res.headers.location)[1]);
  assert.equal((await request(w.app).get('/users').query({ _ps: good })).status, 200);
  const forgeries = [
    good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA'),        // signature altered
    good.replace(/^s:.{6}/, 's:AAAAAA'),                             // session id altered
    good.slice(2),                                                   // prefix missing
    's:' + 'A'.repeat(32) + '.' + 'A'.repeat(43),
    '../../etc/passwd', '<script>alert(1)</script>', '',
  ];
  for (const bad of forgeries) {
    const r = await request(w.app).get('/users').query({ _ps: bad });
    assert.equal(r.status, 302, 'refused: ' + bad);
    assert.doesNotMatch(r.headers.location, /script|passwd/, 'a bad value is never echoed');
  }
  // Signed by a different server (another secret): refused as well.
  const other = await makeWorld({ ...PREVIEW, sessionSecret: 'another-secret-another-secret-another-123' });
  const foreign = decodeURIComponent(/_ps=([^&]+)/.exec((await signInWithoutCookies(other.app, 'ADMIN01')).res.headers.location)[1]);
  assert.equal((await request(w.app).get('/users').query({ _ps: foreign })).status, 302);

  // The destination remembered for after sign-in is the clean address.
  const bounced = await request(w.app).get('/equipment?status=retired&_ps=bogus');
  assert.match(bounced.headers.location, /^\/login\?next=%2Fequipment%3Fstatus%3Dretired(&|$)/);
  // Forms still need their own token: the session in the address is not enough.
  const forged = await request(w.app).post('/equipment?_ps=' + encodeURIComponent(good)).type('form')
    .send({ name: 'x', category_id: w.pcCategory, location_id: w.lab1, quantity: 1 });
  assert.equal(forged.status, 403);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM equipment').get().n, 0);
});

test('preview: a sign-in page shown before a restart still works without cookies', async () => {
  const w = await makeWorld(PREVIEW);
  const page = await request(w.app).get('/login');
  w.db.prepare('DELETE FROM sessions').run();
  const res = await request(w.app).post(actionOf(page.text, '/login')).type('form').set('Sec-Fetch-Site', 'same-origin')
    .send({ _csrf: tokenIn(page.text), college_id: '23CS001', password: PASSWORD });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\/check\?_ps=/);
  const check = await request(w.app).get(res.headers.location);
  assert.equal(check.status, 302);
  assert.match(check.headers.location, /^\/\?_ps=/);
  assert.match((await request(w.app).get(check.headers.location)).text, /Sita Student/);
});

test('preview: a page made before this mode existed (no session in its form) still signs in', async () => {
  const w = await makeWorld(PREVIEW);
  // What an old sign-in page in the pane sends: plain address, stale token, no cookie.
  const res = await request(w.app).post('/login').type('form').set('Sec-Fetch-Site', 'same-origin')
    .send({ _csrf: 'A'.repeat(43), _again: '1', college_id: 'ADMIN01', password: PASSWORD });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\/check\?_ps=/);
  const check = await request(w.app).get(res.headers.location);
  assert.match(check.headers.location, /^\/\?_ps=/);
  const home = await request(w.app).get(check.headers.location);
  assert.match(home.text, /Asha Admin/);
  assert.doesNotMatch(home.text, /did not send back/);
});

test('preview: a browser that does return cookies is left alone', async () => {
  const w = await makeWorld({ embedPreview: true });        // plain http in tests, so the test client keeps the cookie
  const agent = request.agent(w.app);
  const csrf = await token(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, college_id: 'STF001', password: PASSWORD });
  assert.equal(res.headers.location, '/');
  const home = await agent.get('/');
  assert.match(home.text, /Sam Staff/);
  assert.doesNotMatch(home.text, /_ps/, 'no session in any address when cookies work');
  assert.doesNotMatch((await agent.get('/equipment')).text, /_ps/);
  // And a session in the address cannot override the cookie somebody is signed in with.
  const admin = await signInWithoutCookies(w.app, 'ADMIN01');
  const mixed = await agent.get('/' + admin.res.headers.location.slice(1));
  assert.match(mixed.text, /Sam Staff/);
  assert.doesNotMatch(mixed.text, /Asha Admin/);
});

test('preview: the "open in its own tab" link is not given a session', async () => {
  const w = await makeWorld(PREVIEW);
  const res = await request(w.app).get('/login/check');
  assert.match(res.text, /<a href="\/login" target="_blank" rel="noopener">/);
});

test('OUTSIDE preview mode none of this exists', async () => {
  const w = await makeWorld();
  const agent = request.agent(w.app);
  const csrf = await token(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, college_id: 'ADMIN01', password: PASSWORD });
  assert.equal(res.headers.location, '/');
  const cookie = decodeURIComponent(res.headers['set-cookie'][0].split(';')[0].split('=').slice(1).join('='));
  assert.match(cookie, /^s:/);
  // Even the genuine, correctly signed session value is ignored when it arrives in an address.
  for (const path of ['/', '/users', '/equipment', '/audit']) {
    const r = await request(w.app).get(path).query({ _ps: cookie });
    assert.equal(r.status, 302, path);
    assert.match(r.headers.location, /^\/login/);
  }
  const post = await request(w.app).post('/categories?_ps=' + encodeURIComponent(cookie)).type('form').send({ name: 'X', prefix: 'XX' });
  assert.notEqual(post.status, 200);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM categories WHERE prefix = 'XX'").get().n, 0);
  // No page ever mentions the parameter.
  for (const path of ['/login', '/login/check']) assert.doesNotMatch((await request(w.app).get(path)).text, /_ps/, path);
  for (const path of ['/', '/equipment', '/reports', '/users', '/locations', '/categories', '/audit', '/account']) {
    assert.doesNotMatch((await agent.get(path)).text, /_ps/, path);
  }
  assert.doesNotMatch((await request(w.app).get('/equipment')).headers.location, /_ps/);
});
