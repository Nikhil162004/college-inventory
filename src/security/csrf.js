'use strict';
/**
 * CSRF protection (synchroniser token pattern).
 * A random token is kept in the server-side session and must be sent back as a
 * hidden form field with every state-changing request.
 */
const crypto = require('crypto');

function tokenFor(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('base64url');
  return req.session.csrf;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function csrfProtection(req, res, next) {
  res.locals.csrfToken = () => tokenFor(req); // created lazily, only when a form is rendered
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const sent = req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '';
  const expected = req.session && req.session.csrf;
  if (!expected || !sent || !safeEqual(sent, expected)) {
    const err = new Error('Invalid or missing CSRF token');
    err.status = 403;
    err.code = 'EBADCSRFTOKEN';
    return next(err);
  }
  next();
}

module.exports = { csrfProtection };
