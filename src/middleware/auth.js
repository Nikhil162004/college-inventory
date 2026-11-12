'use strict';

/** What each role may do. Checked on the server for every request. */
const PERMISSIONS = {
  'equipment.browse': ['admin', 'staff', 'faculty'],
  'equipment.manage': ['admin', 'staff'],
  'equipment.retire': ['admin'],
  'reports.viewAll': ['admin', 'staff', 'faculty'],
  'reports.manage': ['admin', 'staff'],
  'locations.manage': ['admin'],
  'categories.manage': ['admin'],
  'users.manage': ['admin'],
  'audit.view': ['admin'],
};

function can(user, permission) {
  const roles = PERMISSIONS[permission];
  return Boolean(user && roles && roles.includes(user.role));
}

/** Loads the signed-in user fresh from the database on every request, so that
 *  deactivation and role changes take effect immediately. */
function loadUser({ db, config, cookieName }) {
  const getUser = db.prepare(
    'SELECT id, college_id, name, email, role, department, must_change_password, is_active FROM users WHERE id = ?'
  );
  return function (req, res, next) {
    req.user = null;
    const s = req.session;
    if (!s || !s.userId) return next();
    const tooOld = !s.loginAt || Date.now() - s.loginAt > config.sessionAbsoluteMs;
    const user = tooOld ? null : getUser.get(s.userId);
    if (user && user.is_active) {
      req.user = user;
      return next();
    }
    s.destroy(() => {
      res.clearCookie(cookieName, { path: '/' });
      next();
    });
  };
}

/** Only accept local paths as a post-login destination (prevents open redirects). */
function safeNext(value) {
  if (typeof value !== 'string' || value.length > 300) return '';
  if (!/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/.test(value)) return '';
  if (value.startsWith('//') || value.startsWith('/login')) return '';
  return value;
}

function requireAuth(req, res, next) {
  if (!req.user) {
    const next_ = req.method === 'GET' ? safeNext(req.originalUrl) : '';
    return res.redirect(next_ && next_ !== '/' ? '/login?next=' + encodeURIComponent(next_) : '/login');
  }
  res.set('Cache-Control', 'no-store');
  if (req.user.must_change_password && req.path !== '/account/password' && req.path !== '/logout') {
    return res.redirect('/account/password');
  }
  next();
}

function requirePermission(permission) {
  return function (req, res, next) {
    if (can(req.user, permission)) return next();
    const err = new Error('Forbidden');
    err.status = 403;
    next(err);
  };
}

module.exports = { PERMISSIONS, can, loadUser, safeNext, requireAuth, requirePermission };
