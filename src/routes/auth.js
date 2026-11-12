'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const passwords = require('../security/password');
const { safeNext } = require('../middleware/auth');
const wrap = require('../lib/wrap');
const { makeSentFromThisSite } = require('../lib/same-site');

module.exports = function authRoutes({ db, config, audit, store, cookieName, instanceId }) {
  const publicRouter = express.Router();
  const accountRouter = express.Router();

  const q = {
    byCollegeId: db.prepare('SELECT * FROM users WHERE college_id = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    fail: db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?'),
    success: db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, failed_logins = 0, locked_until = NULL WHERE id = ?'),
  };

  // Sessions of visitors who have not signed in are kept only briefly, so that
  // automated requests to the sign-in page cannot fill the session table.
  const ANONYMOUS_SESSION_MS = 30 * 60 * 1000;
  // The sign-in page reloads itself (when nothing has been typed) well before
  // that, so that its form does not go stale while the page sits open.
  const SIGNIN_FRESH_SECONDS = 20 * 60;

  const hasSessionCookie = (req) =>
    String(req.headers.cookie || '').split(';').some((c) => c.trim().startsWith(cookieName + '='));

  const sentFromThisSite = makeSentFromThisSite(config);

  /** Hosted preview only: a line the viewer can pass on when sign-in fails there. */
  function previewDetails(req) {
    const word = (name) => (/^[a-z-]{1,20}$/.test(req.get(name) || '') ? req.get(name) : 'not stated');
    return `Preview details: cookie ${hasSessionCookie(req) ? 'received' : 'not received'}; `
      + `form sent from: ${word('sec-fetch-site')}; shown in: ${word('sec-fetch-dest')}.`;
  }

  /** The one place that draws the sign-in page. */
  function renderLogin(req, res, status, { next = '', collegeId = '', error = null, notice = null, cookieHelp = false, again = false } = {}) {
    res.set('Cache-Control', 'no-store');
    if (req.session && !req.session.userId) req.session.cookie.maxAge = ANONYMOUS_SESSION_MS;
    res.status(status).render('login', {
      title: 'Sign in', next, collegeId, error, notice, cookieHelp, again,
      embedPreview: config.embedPreview,
      previewDetails: config.embedPreview && (notice || cookieHelp) ? previewDetails(req) : '',
      instanceId,
      freshFor: SIGNIN_FRESH_SECONDS,
      freshUrl: next ? '/login?next=' + encodeURIComponent(next) : '/login',
    });
  }

  const cleanCollegeId = (value) => String(value || '').trim().toUpperCase().slice(0, 40);

  // The same message for every failure, so nobody can find out which IDs exist.
  const lockMinutes = Math.round(config.loginLockMs / 60000);
  const GENERIC = `The college ID or password is incorrect. After ${config.loginMaxFailures} wrong attempts an account is locked for ${lockMinutes} minutes.`;

  // A hash of a random value: verified when the ID is unknown so that the
  // response takes just as long as for a real account.
  let dummyHash;
  const getDummyHash = () => (dummyHash ||= passwords.hash(require('crypto').randomBytes(16).toString('hex')));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.loginRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) => {
      renderLogin(req, res, 429, { error: 'Too many failed sign-in attempts from this network. Wait 15 minutes and try again.' });
    },
  });

  /** Counts a wrong password and locks the account when the limit is reached. */
  function registerFailure(user) {
    const failures = user.failed_logins + 1;
    if (failures >= config.loginMaxFailures) {
      q.fail.run(0, Date.now() + config.loginLockMs, user.id);
      return true;
    }
    q.fail.run(failures, user.locked_until, user.id);
    return false;
  }

  publicRouter.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    renderLogin(req, res, 200, { next: safeNext(req.query.next) });
  });

  // After a sign-in from a stale page (see recoverFromStaleForm) the browser is
  // sent here first. If it kept the new cookie, it goes on to its destination;
  // if it did not, it is told so instead of bouncing back to an empty sign-in page.
  publicRouter.get('/login/check', (req, res) => {
    const nextUrl = safeNext(req.query.next);
    if (req.user) return res.redirect(req.user.must_change_password ? '/account/password' : (nextUrl || '/'));
    renderLogin(req, res, 200, { next: nextUrl, cookieHelp: true, again: true });
  });

  publicRouter.post('/login', loginLimiter, wrap(async (req, res, next) => {
    const collegeId = cleanCollegeId(req.body.college_id);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const nextUrl = safeNext(req.body.next);
    res.set('Cache-Control', 'no-store');
    const fail = () => renderLogin(req, res, 401, { next: nextUrl, error: GENERIC, collegeId });

    if (!collegeId || !password || password.length > 200) return fail();

    const user = q.byCollegeId.get(collegeId);
    const now = Date.now();
    if (!user || !user.is_active || (user.locked_until && user.locked_until > now)) {
      await passwords.verify(password, await getDummyHash());
      audit(req, 'login.failed', 'user', user ? user.id : null, 'Sign-in refused', collegeId);
      return fail();
    }

    if (!(await passwords.verify(password, user.password_hash))) {
      const locked = registerFailure(user);
      audit(req, locked ? 'login.locked' : 'login.failed', 'user', user.id,
        locked ? `Account locked for ${lockMinutes} minutes after repeated wrong passwords` : 'Wrong password', collegeId);
      return fail();
    }

    q.success.run(now, user.id);
    // New session ID on sign-in, so a pre-login session can never be reused.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      req.session.loginAt = now;
      req.user = user;
      audit(req, 'login', 'user', user.id, 'Signed in');
      req.session.save((err2) => {
        if (err2) return next(err2);
        if (req.staleSignIn) {
          return res.redirect('/login/check' + (nextUrl ? '?next=' + encodeURIComponent(nextUrl) : ''));
        }
        res.redirect(user.must_change_password ? '/account/password' : (nextUrl || '/'));
      });
    });
  }));

  publicRouter.post('/logout', (req, res, next) => {
    if (req.user) audit(req, 'logout', 'user', req.user.id, 'Signed out');
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie(cookieName, { path: '/' });
      res.redirect('/login');
    });
  });

  /**
   * A form arrived whose security token does not match the session.
   *
   * For somebody who is signed in, that is refused outright (see the error page
   * in app.js). For somebody who is not signed in it nearly always means the
   * session simply ended while the page was open: the sign-in page sat in a tab
   * for too long, the server was restarted, or the browser kept no cookie.
   *
   * The sign-in form is the one form that can still be honoured then, and only
   * when the browser itself states that it was submitted from this site's own
   * page: the token exists to stop other websites from submitting forms, and
   * that statement rules them out just as well. The password is then checked
   * exactly as usual (lockout and rate limit included).
   *
   * In every other case nothing from the form is acted on -- no password is
   * checked and nothing is saved -- and the visitor gets a fresh sign-in form
   * with a plain explanation instead of a dead end.
   */
  // eslint-disable-next-line no-unused-vars
  function recoverFromStaleForm(err, req, res, next) {
    if (err.code !== 'EBADCSRFTOKEN' || req.method !== 'POST') return next(err);
    const body = req.body || {};

    if (req.path === '/login') {
      // Already signed in (for example in another tab): nothing to do here.
      if (req.user) return res.redirect(303, '/');
      if (sentFromThisSite(req)) {
        req.staleSignIn = true;
        return next();                           // on to the normal sign-in handler
      }
      // A form we handed out a moment ago came back without any cookie at all:
      // the browser is not keeping cookies, and trying again cannot help.
      const cookiesBlocked = !hasSessionCookie(req) && body._again === '1';
      return renderLogin(req, res, 403, {
        next: safeNext(body.next),
        collegeId: cleanCollegeId(body.college_id),
        again: true,
        cookieHelp: cookiesBlocked,
        notice: cookiesBlocked ? null : 'This sign-in page had been open for a while, so it has been refreshed. Please enter your password again.',
      });
    }

    if (req.user) return next(err);
    if (req.path !== '/logout') {
      req.flash('warn', 'You were signed out because the page had been idle for too long. Sign in and repeat the last step: it was not saved.');
    }
    res.redirect(303, '/login');
  }

  // ---- Signed-in account pages -------------------------------------------
  accountRouter.get('/account', (req, res) => {
    const me = q.byId.get(req.user.id);
    res.render('account', { title: 'My account', me });
  });

  accountRouter.get('/account/password', (req, res) => {
    res.render('password', { title: 'Change password', errors: {} });
  });

  accountRouter.post('/account/password', wrap(async (req, res, next) => {
    const me = q.byId.get(req.user.id);
    const current = typeof req.body.current_password === 'string' ? req.body.current_password : '';
    const fresh = typeof req.body.new_password === 'string' ? req.body.new_password : '';
    const confirm = typeof req.body.confirm_password === 'string' ? req.body.confirm_password : '';
    const errors = {};

    if (!current || current.length > 200 || !(await passwords.verify(current, me.password_hash))) {
      // Wrong current password counts like a failed sign-in: a stolen session
      // cannot be used to guess the password indefinitely.
      if (registerFailure(me)) {
        audit(req, 'login.locked', 'user', me.id, 'Account locked: wrong current password while changing password');
        store.destroyUserSessions(me.id);
        return res.redirect('/login');
      }
      errors.current_password = 'This is not your current password.';
    } else {
      const problem = passwords.policyError(fresh, me);
      if (problem) errors.new_password = problem;
      else if (fresh === current) errors.new_password = 'The new password must be different from the current one.';
      else if (fresh !== confirm) errors.confirm_password = 'The two passwords do not match.';
    }
    if (Object.keys(errors).length) {
      return res.status(422).render('password', { title: 'Change password', errors });
    }

    q.setPassword.run(await passwords.hash(fresh), me.id);
    audit(req, 'password.change', 'user', me.id, 'Changed own password');
    store.destroyUserSessions(me.id, req.sessionID);   // sign out every other device
    const loginAt = req.session.loginAt;
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = me.id;
      req.session.loginAt = loginAt;
      req.flash('ok', 'Your password has been changed. Other devices have been signed out.');
      req.session.save((err2) => (err2 ? next(err2) : res.redirect('/')));
    });
  }));

  return { publicRouter, accountRouter, recoverFromStaleForm };
};
