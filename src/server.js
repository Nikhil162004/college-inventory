'use strict';
const { buildConfig } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');

const { lanAddresses, startupProblem } = require('./lib/startup');

const config = buildConfig();
const db = openDb(config.dbPath);

const problem = startupProblem({ db, config });
if (problem) {
  console.error('Refusing to start. ' + problem);
  db.close();
  process.exit(1);
}

const app = createApp({ db, config });

const server = app.listen(config.port, config.host, () => {
  console.log(`${config.appName} listening on http://${config.host}:${config.port} (${config.nodeEnv})`);
  // Trying it out on your own computer: phones on the same Wi-Fi can use these
  // addresses, and QR codes made while the site is opened by one of them will
  // open on those phones.
  if (!config.isProd && !config.embedPreview && !config.baseUrl && !process.env.STARTED_BY_LAPTOP && ['0.0.0.0', '::'].includes(config.host)) {
    console.log(`  On this computer:  http://localhost:${config.port}`);
    for (const address of lanAddresses()) {
      console.log(`  On this network:   http://${address}:${config.port}   <- open the site by this address to make QR codes that phones can scan`);
    }
  }
  if (config.isProd && config.publicDemo) {
    console.log(`  PUBLIC DEMONSTRATION: made-up data, and the sign-ins are shown on the sign-in page. Never keep real records here.`);
    console.log(`  QR codes open ${config.baseUrl}`);
  }
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    console.log('No accounts exist yet. Run "npm run setup" to create the first administrator.');
  }
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
