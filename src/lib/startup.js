'use strict';
const os = require('os');

/** IPv4 addresses by which other devices on the same network can reach this computer. */
function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const list of Object.values(interfaces)) {
    for (const entry of list || []) {
      const v4 = entry.family === 'IPv4' || entry.family === 4;
      if (v4 && !entry.internal && !entry.address.startsWith('127.')) found.push(entry.address);
    }
  }
  return found;
}

/**
 * A reason not to start, or null. The demonstration data comes with sign-ins
 * whose passwords are printed in the README, so it must never be served as the
 * real site. The one exception is a site that declares itself a public
 * demonstration (PUBLIC_DEMO=1): it shows a notice on every page.
 */
function startupProblem({ db, config }) {
  if (config.isProd && !config.publicDemo && db.prepare("SELECT 1 FROM meta WHERE key = 'demo'").get()) {
    return 'This database contains the demonstration data, whose passwords are public. '
      + 'It cannot be used with NODE_ENV=production. Point DB_PATH at a new, empty file '
      + '(or delete the data folder) and run "npm run setup" to create the first administrator.';
  }
  return null;
}

module.exports = { lanAddresses, startupProblem };
