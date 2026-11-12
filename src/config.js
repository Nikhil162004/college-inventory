'use strict';
/**
 * Central configuration. Every setting comes from environment variables
 * (optionally loaded from a .env file) so that no secret lives in the code.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

/**
 * Reads KEY=value lines. A value may be quoted to keep spaces and # exactly;
 * without quotes, anything after " #" is a comment.
 */
function parseEnvText(text) {
  const found = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(["'])(.*)\1(\s+#.*)?$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    found[m[1]] = value;
  }
  return found;
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnvText(fs.readFileSync(file, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const EMAIL = /^[^\s@<>,;:"()\[\]\\]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function bool(v, fallback = false) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function buildConfig(overrides = {}) {
  if (process.env.NODE_ENV !== 'test') loadDotEnv(path.join(ROOT, '.env'));
  const env = process.env;
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';

  // EMBED_PREVIEW is only for showing the app inside a hosted preview frame.
  // It relaxes framing and cookie SameSite rules and must stay off in production.
  const embedPreview = bool(env.EMBED_PREVIEW, false);
  if (isProd && embedPreview) {
    throw new Error('EMBED_PREVIEW must not be enabled when NODE_ENV=production.');
  }

  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProd) throw new Error('SESSION_SECRET is required in production (use 32+ random characters).');
    sessionSecret = crypto.randomBytes(32).toString('hex'); // development only: sessions reset on restart
  }
  if (isProd && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET is too short. Use at least 32 random characters.');
  }

  // The address printed inside QR codes. Some hosts announce the site's public
  // address themselves (Render: RENDER_EXTERNAL_URL); it is used when BASE_URL is not set.
  const baseUrl = (env.BASE_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (isProd && !/^https:\/\//.test(baseUrl)) {
    throw new Error('BASE_URL is required in production and must start with https:// (it is printed inside every QR code).');
  }

  // Email alerts for new reports. Off unless an address is given; then the mail
  // server details are required too, so a half-filled setting is noticed at once.
  let alerts = null;
  if ((env.ALERT_EMAIL || '').trim()) {
    const to = env.ALERT_EMAIL.split(',').map((a) => a.trim()).filter(Boolean);
    if (!to.length || to.length > 5 || /[\r\n]/.test(env.ALERT_EMAIL) || !to.every((a) => EMAIL.test(a))) {
      throw new Error('ALERT_EMAIL must be an email address (or up to five, separated by commas).');
    }
    if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
      throw new Error('ALERT_EMAIL is set, but SMTP_HOST, SMTP_USER and SMTP_PASS are also needed to send mail. Run "npm run alerts" to set them up.');
    }
    const port = int(env.SMTP_PORT, 465);
    if (port < 1 || port > 65535) throw new Error('SMTP_PORT must be a port number, usually 465 or 587.');
    const from = (env.SMTP_FROM || env.SMTP_USER).trim();
    if (!EMAIL.test(from)) throw new Error('SMTP_FROM (or SMTP_USER) must be the email address the alerts are sent from.');
    alerts = Object.freeze({
      to: Object.freeze(to), host: env.SMTP_HOST.trim(), port, user: env.SMTP_USER.trim(), pass: env.SMTP_PASS, from,
      perHour: Math.max(1, int(env.ALERTS_PER_HOUR, 60)),
    });
  }

  const config = {
    root: ROOT,
    nodeEnv,
    isProd,
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dbPath: env.DB_PATH || path.join(ROOT, 'data', 'inventory.db'),
    baseUrl,
    appName: 'Inventory Register',
    collegeName: env.COLLEGE_NAME || 'College of Engineering',
    timezone: env.TIMEZONE || 'Asia/Kolkata',
    trustProxy: int(env.TRUST_PROXY, 0),
    embedPreview,
    // A public demonstration: the made-up college, served with every production
    // safeguard. Its sign-ins are printed on the sign-in page, so never real data.
    publicDemo: bool(env.PUBLIC_DEMO, false),
    cookieSecure: isProd || embedPreview || bool(env.COOKIE_SECURE, false),
    sessionSecret,
    sessionIdleMs: int(env.SESSION_IDLE_MINUTES, 120) * 60 * 1000,
    sessionAbsoluteMs: int(env.SESSION_MAX_HOURS, 12) * 60 * 60 * 1000,
    loginMaxFailures: int(env.LOGIN_MAX_FAILURES, 5),
    loginLockMs: int(env.LOGIN_LOCK_MINUTES, 15) * 60 * 1000,
    loginRateLimit: int(env.LOGIN_RATE_LIMIT, 30), // failed sign-ins per IP per 15 min
    reportsPerHour: int(env.REPORTS_PER_HOUR, 10),
    // Reporting from the QR label without an account. The limits are per network
    // address (a campus Wi-Fi shares few addresses, so this one is generous) and
    // per item (open reports from visitors at any one time).
    alerts,
    guestReports: bool(env.GUEST_REPORTS, true),
    guestReportsPerHour: int(env.GUEST_REPORTS_PER_HOUR, 30),
    guestReportsPerItem: int(env.GUEST_REPORTS_PER_ITEM, 3),
    pageSize: 25,
    ...overrides,
  };
  return Object.freeze(config);
}

module.exports = { buildConfig, parseEnvText };
