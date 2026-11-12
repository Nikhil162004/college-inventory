'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const { SqliteSessionStore } = require('./security/session-store');
const { csrfProtection } = require('./security/csrf');
const { loadUser, requireAuth, can } = require('./middleware/auth');
const { makeFormatter } = require('./lib/format');
const { makeAudit } = require('./lib/audit');
const { makeInventory } = require('./lib/inventory');
const { makeMailer, makeNotifier } = require('./lib/notify');

function assetVersion(dir) {
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(dir).sort()) h.update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex').slice(0, 10);
}

function createApp({ db, config, mailer = null, log = console.error }) {
  const app = express();
  const publicDir = path.join(__dirname, 'public');
  const fmt = makeFormatter(config.timezone);
  const cookieName = config.cookieSecure ? '__Host-sid' : 'sid';
  const store = new SqliteSessionStore(db, { ttlMs: config.sessionIdleMs });
  const ctx = {
    db, config, fmt, store, cookieName,
    audit: makeAudit(db),
    inventory: makeInventory(db, config),
  };
  ctx.notify = makeNotifier({ config, fmt, log, mailer: mailer || (config.alerts ? makeMailer(config.alerts) : null) });
  const version = assetVersion(publicDir);
  // Changes every time the server starts. An open sign-in page compares it with
  // the one it was made with and fetches itself again after a restart.
  const instanceId = crypto.randomBytes(12).toString('base64url');
  ctx.instanceId = instanceId;
  const demoFlag = db.prepare("SELECT 1 FROM meta WHERE key = 'demo'");
  const isDemo = () => (!config.isProd || config.publicDemo) && Boolean(demoFlag.get());

  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  if (config.embedPreview) {
    // Hosted preview only: one proxy in front, which always serves over HTTPS.
    app.set('trust proxy', 1);
    app.use((req, res, next) => { req.headers['x-forwarded-proto'] = 'https'; next(); });
  } else if (config.trustProxy) {
    app.set('trust proxy', config.trustProxy);
  }

  // ---- Security headers -------------------------------------------------
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],            // no inline scripts anywhere
        styleSrc: ["'self'"],             // no inline styles anywhere
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: config.embedPreview ? ['*'] : ["'none'"],
      },
    },
    frameguard: config.embedPreview ? false : { action: 'deny' },
    crossOriginResourcePolicy: { policy: config.embedPreview ? 'cross-origin' : 'same-origin' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'same-origin' },
    hsts: config.cookieSecure ? { maxAge: 15552000 } : false,
  }));
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });

  // Safe defaults so the error page can always render.
  app.use((req, res, next) => {
    Object.assign(res.locals, {
      appName: config.appName, collegeName: config.collegeName, assetVersion: version,
      fmt, user: null, can: () => false, currentPath: req.path,
      csrfToken: () => '', takeFlash: () => null, isDemo: false, guestReports: config.guestReports, alertsOn: ctx.notify.enabled,
    });
    next();
  });

  app.use('/static', express.static(publicDir, { index: false, maxAge: config.isProd ? '30d' : 0 }));
  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.type('text/plain').send('ok');
  });

  // Public, cookie-less and harmless: just the id of this server run. It may be
  // read from any page (a sandboxed preview frame counts as "another site").
  app.get('/instance', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.type('text/plain').send(instanceId);
  });

  // ---- Sessions ---------------------------------------------------------
  if (config.embedPreview) {
    // Demo preview only (never in production, see config.js): lets a browser
    // that returns no cookies to a framed site stay signed in.
    app.use(require('./preview/cookieless')({ cookieName, secret: config.sessionSecret }));
  }
  app.use(session({
    name: cookieName,
    secret: config.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,                          // idle timeout: renewed on activity
    cookie: {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.embedPreview ? 'none' : 'lax',
      partitioned: config.embedPreview ? true : undefined,
      maxAge: config.sessionIdleMs,
      path: '/',
    },
  }));
  app.use(loadUser({ db, config, cookieName }));
  app.use((req, res, next) => {
    req.flash = (type, text) => { req.session.flash = { type, text }; };
    res.locals.user = req.user;
    res.locals.can = (permission) => can(req.user, permission);
    res.locals.isDemo = isDemo();
    res.locals.takeFlash = () => {
      const f = req.session.flash || null;
      if (f) delete req.session.flash;
      return f;
    };
    next();
  });

  // ---- Request bodies (small limits; only the roster import may be larger) --
  const smallBody = express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 100 });
  const importBody = express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 10 });
  app.use((req, res, next) => {
    const big = req.path === '/users/import' && can(req.user, 'users.manage');
    (big ? importBody : smallBody)(req, res, next);
  });
  const auth = require('./routes/auth')(ctx);
  const guest = require('./routes/guest')(ctx);
  app.use(csrfProtection);
  app.use(guest.recoverFromStaleForm);      // a visitor's report form that sat open too long is not lost
  app.use(auth.recoverFromStaleForm);       // signed-out visitors get a fresh sign-in form, not a dead end

  // ---- Routes -----------------------------------------------------------
  app.use(auth.publicRouter);
  app.use(guest.router);                    // the QR label's report form: the only pages open to visitors
  app.use(requireAuth);                     // everything below needs a signed-in user
  app.use(auth.accountRouter);
  app.use(require('./routes/dashboard')(ctx));
  app.use('/equipment', require('./routes/equipment')(ctx));
  app.use('/reports', require('./routes/reports')(ctx));
  app.use('/locations', require('./routes/locations')(ctx));
  app.use('/categories', require('./routes/categories')(ctx));
  app.use('/users', require('./routes/users')(ctx));
  app.use('/audit', require('./routes/audit')(ctx));

  // ---- Errors -----------------------------------------------------------
  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Page not found', code: 404,
      message: 'There is nothing at this address. It may have been typed incorrectly.',
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = Number(err.status || err.statusCode) || 500;
    if (status < 400 || status > 599) status = 500;
    if (status >= 500) console.error(`[error] ${req.method} ${req.path}`, err);
    if (res.headersSent) return res.end();
    const pages = {
      400: ['Request not understood', 'The request could not be read. Go back and try again.'],
      403: ['Not allowed', 'Your account does not have permission to do this.'],
      404: ['Not found', 'That record does not exist.'],
      413: ['Too much data', 'The submitted form is larger than allowed.'],
      429: ['Slow down', 'Too many requests. Wait a little and try again.'],
    };
    let [title, message] = pages[status] || ['Something went wrong', 'The problem has been logged. Please try again in a moment.'];
    if (err.code === 'EBADCSRFTOKEN') {
      title = 'Form expired';
      message = 'For your safety this form could not be accepted. Go back, reload the page and submit it again.';
    }
    res.status(status).render('error', { title, code: status, message });
  });

  return app;
}

module.exports = { createApp };
