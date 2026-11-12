'use strict';
/**
 * Email alerts for new problem reports.
 *
 * Mail is sent after the report has been saved and never holds it up: if the
 * mail server cannot be reached, the report is still in the register and the
 * failure is written to the server log. Messages are plain text, the subject is
 * built only from the register's own data, and the recipients come only from
 * the server's settings, so nothing a visitor types can redirect an alert.
 */
const nodemailer = require('nodemailer');
const { ISSUE } = require('./format');

const HOUR = 60 * 60 * 1000;
const oneLine = (value) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

/** Connects to the configured mail server. `extra` exists for tests only. */
function makeMailer(alerts, extra = {}) {
  const transport = nodemailer.createTransport({
    host: alerts.host,
    port: alerts.port,
    secure: alerts.port === 465,          // encrypted from the first byte
    requireTLS: alerts.port !== 465,      // otherwise encryption must start before signing in
    auth: { user: alerts.user, pass: alerts.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
    ...extra,
  });
  return { send: (message) => transport.sendMail(message) };
}

function makeNotifier({ config, fmt, mailer = null, log = console.error }) {
  const alerts = config.alerts || null;
  const enabled = Boolean(alerts && mailer);
  const recent = [];                      // when the last alerts went out
  let noticeAt = 0;                       // when "more are waiting" was last sent

  const envelope = (subject, text) => ({
    from: { name: config.appName, address: alerts.from },
    to: [...alerts.to],
    subject: oneLine(subject).slice(0, 200),
    text,
  });
  const whereToLook = () => (config.baseUrl
    ? `Open the report (sign-in needed):\n${config.baseUrl}/reports/`
    : 'To handle it, sign in to the register and open "Problem reports".');

  async function deliver(message, what) {
    try {
      await mailer.send(message);
      return true;
    } catch (err) {
      log(`[alert] ${what} is saved in the register, but the alert email could not be sent: ${oneLine(err && err.message)}`);
      return false;
    }
  }

  /** Called after a report has been saved. Resolves to whether an email went out. */
  function reportCreated({ id, createdAt, issueType, description, item, reporter }) {
    if (!enabled) return Promise.resolve(false);
    const now = Date.now();
    while (recent.length && recent[0] <= now - HOUR) recent.shift();
    const ticket = fmt.ticket(id);

    if (recent.length >= alerts.perHour) {
      if (noticeAt > now - HOUR) return Promise.resolve(false);
      noticeAt = now;
      return deliver(envelope(
        `${config.appName}: more reports are waiting`,
        `More than ${alerts.perHour} problem reports have arrived within an hour, so separate emails are paused for now.\n`
        + 'Every report is saved. Sign in to the register and open "Problem reports" to see them all.\n'
      ), `${ticket} (and others)`);
    }
    recent.push(now);

    const link = config.baseUrl ? `${whereToLook()}${id}` : whereToLook();
    const lines = [
      `A problem has been reported on the ${config.appName} (${config.collegeName}).`,
      '',
      `Report:     ${ticket}`,
      `Equipment:  ${oneLine(item.asset_tag)} - ${oneLine(item.name)}`,
      `Location:   ${oneLine(item.location_code)} - ${oneLine(item.location_name)}`,
      `Problem:    ${ISSUE[issueType] || 'Other'}`,
      `Reported:   ${fmt.dateTime(createdAt)}`,
      `By:         ${oneLine(reporter)}`,
      '',
      'What they wrote:',
      String(description).split(/\r?\n/).map((l) => '    ' + oneLine(l)).join('\n'),
      '',
      link,
      '',
    ];
    return deliver(envelope(
      `New problem report ${ticket}: ${oneLine(item.asset_tag)} (${oneLine(item.location_code)}) - ${ISSUE[issueType] || 'Other'}`,
      lines.join('\n')
    ), ticket);
  }

  /** Sends one message to check the settings. Resolves to { ok, error }. */
  async function sendTest() {
    if (!enabled) return { ok: false, error: 'Email alerts are not set up.' };
    try {
      await mailer.send(envelope(
        `${config.appName}: test alert`,
        `This is a test from the ${config.appName} (${config.collegeName}).\n\nEmail alerts are working. You will get a message like this one whenever a problem is reported.\n`
      ));
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: oneLine(err && err.message) };
    }
  }

  return { enabled, reportCreated, sendTest };
}

module.exports = { makeMailer, makeNotifier };
