'use strict';
/**
 * Starts the register on your own computer so that phones on the same Wi-Fi can
 * scan the QR codes:   npm run laptop   (or double-click the start file).
 *
 * The first time, it installs what the program needs and loads the demonstration
 * data. After that it only starts the site. Existing records are never replaced.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIN_NODE = 22;

/** What still has to be done. Old Node.js versions have no ready-made database driver. */
function plan({ nodeMajor, hasModules, hasDb }) {
  if (nodeMajor < MIN_NODE) {
    return {
      steps: [],
      problem: `This computer has Node.js ${nodeMajor}, which is too old for the register (it needs ${MIN_NODE} or newer).\n`
        + 'Install the current "LTS" version from https://nodejs.org (keep every default), then start again.',
    };
  }
  const steps = [];
  if (!hasModules) steps.push('install');
  if (!hasDb) steps.push('demo-data');
  steps.push('start');
  return { steps, problem: null };
}

const VIRTUAL = /vethernet|virtualbox|vmware|vmnet|wsl|hyper-v|docker|^br-|^veth|tailscale|zerotier|^utun|^tun|^tap|loopback|bluetooth/i;
const WIFI = /wi-?fi|wlan|wireless|^en0$|^wl/i;
const isV4 = (entry) => entry.family === 'IPv4' || entry.family === 4;

/**
 * The address a phone on the same network should use. `routed` is the address
 * the computer itself uses to reach the outside (see routedAddress) and wins
 * when it really belongs to this computer.
 */
function pickAddress(interfaces = os.networkInterfaces(), routed = null) {
  const found = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list || []) {
      if (!isV4(entry) || entry.internal || entry.address.startsWith('127.') || entry.address.startsWith('169.254.')) continue;
      found.push({ name, address: entry.address });
    }
  }
  if (routed && found.some((f) => f.address === routed)) return routed;
  const real = found.filter((f) => !VIRTUAL.test(f.name));
  const best = real.find((f) => WIFI.test(f.name)) || real[0] || found[0];
  return best ? best.address : null;
}

/** Asks the system which of its addresses it would use to reach the internet. Sends nothing. */
function routedAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (value) => { try { socket.close(); } catch { /* already closed */ } resolve(value); };
    socket.on('error', () => done(null));
    try {
      socket.connect(53, '192.0.2.1', () => {
        let address = null;
        try { address = socket.address().address; } catch { /* no route */ }
        done(address && address !== '0.0.0.0' ? address : null);
      });
    } catch { done(null); }
  });
}

/** Where the phone check should land: a real report form if there is equipment. */
function phoneCheckPath(db) {
  const row = db.prepare("SELECT asset_tag FROM equipment WHERE status != 'retired' ORDER BY id LIMIT 1").get();
  return row ? '/e/' + row.asset_tag : '/login';
}

function banner({ address, port, checkPath, qr, demo, alertsOn }) {
  const rule = '='.repeat(66);
  const lines = ['', rule, '  The Inventory Register is running.', rule, ''];
  if (!address) {
    lines.push('  This computer is not connected to a network, so a phone cannot reach it yet.',
      '  Connect to Wi-Fi (or to your phone\'s hotspot) and start again.', '',
      `  On this computer:  http://localhost:${port}`, '');
  } else {
    lines.push(`  On this computer and on phones:  http://${address}:${port}`, '',
      '  CHECK YOUR PHONE NOW: connect it to the same Wi-Fi as this computer,',
      '  open the camera and point it at this code (or type the address under it):', '');
    if (qr) lines.push(qr);
    lines.push(`      http://${address}:${port}${checkPath}`, '',
      checkPath === '/login' ? '  The sign-in page should open on the phone.' : '  The "report a problem" form should open on the phone. No sign-in is needed.', '',
      '  If the phone cannot open it:',
      '   1. Windows asked "Allow this app through the firewall?" - choose Allow,',
      '      with both Private and Public networks ticked. (README: "Phone cannot connect".)',
      '   2. College and hostel Wi-Fi often stops devices from talking to each other.',
      '      Turn on your phone\'s Wi-Fi hotspot, connect this computer to it, start again.',
      '   3. Mobile data must not be the only connection: the phone has to be on the',
      '      same Wi-Fi (or be the hotspot).', '');
  }
  if (demo) {
    lines.push('  Demonstration sign-ins (made-up data):',
      '    Administrator  ADMIN01   Register#Admin26',
      '    Lab staff      STF001    Register#Staff26',
      '    Faculty        FAC001    Register#Faculty26',
      '    Student        23CS001   Register#Student26', '');
  }
  lines.push(alertsOn
    ? '  Email alerts for new reports: on.'
    : '  Email alerts for new reports: off. To get an email for every report,\n  stop the register and run:  npm run alerts', '');
  lines.push('  To stop the register: press Ctrl+C in this window, or close it.', rule, '');
  return lines.join('\n');
}

module.exports = { plan, pickAddress, routedAddress, phoneCheckPath, banner };

// ---- run from the command line ----------------------------------------------------

/** Runs npm with fixed words (npm is a .cmd file on Windows, so it goes through the shell). */
function npm(words) {
  return spawnSync('npm ' + words, { cwd: ROOT, stdio: 'inherit', shell: true }).status === 0;
}

function waitUntilUp(port, child, seconds = 40) {
  return new Promise((resolve) => {
    const until = Date.now() + seconds * 1000;
    let stopped = false;
    child.once('exit', () => { stopped = true; });
    const attempt = () => {
      if (stopped) return resolve(false);
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(true); else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = () => (Date.now() > until ? resolve(false) : setTimeout(attempt, 400));
    attempt();
  });
}

function openBrowser(url) {
  try {
    const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* the address is printed anyway */ }
}

async function main() {
  const dbFile = path.join(ROOT, 'data', 'inventory.db');
  const { steps, problem } = plan({
    nodeMajor: Number(process.versions.node.split('.')[0]),
    hasModules: fs.existsSync(path.join(ROOT, 'node_modules', 'better-sqlite3')) && fs.existsSync(path.join(ROOT, 'node_modules', 'express')),
    hasDb: fs.existsSync(dbFile),
  });
  if (problem) { console.error('\n' + problem + '\n'); return 1; }

  if (steps.includes('install')) {
    console.log('\nFirst start: installing what the program needs (about a minute, needs the internet) ...\n');
    const ok = npm((fs.existsSync(path.join(ROOT, 'package-lock.json')) ? 'ci' : 'install') + ' --no-audit --no-fund');
    if (!ok) { console.error('\nThe installation did not finish. Check the internet connection and start again.\n'); return 1; }
  }
  if (steps.includes('demo-data')) {
    console.log('\nLoading the demonstration data (20 labs, 1,660 items, 3,577 accounts; about half a minute) ...\n');
    if (spawnSync(process.execPath, [path.join('scripts', 'seed-demo.js')], { cwd: ROOT, stdio: 'inherit' }).status !== 0) { console.error('\nThe demonstration data could not be loaded.\n'); return 1; }
  }

  const { buildConfig } = require('../src/config');
  let config;
  try { config = buildConfig(); } catch (err) { console.error('\nA setting in the file ".env" needs attention:\n  ' + err.message + '\n'); return 1; }
  if (config.isProd) {
    console.error('\nThe file ".env" sets this up as the real site (NODE_ENV=production). Start that with "npm start" on the server.\n');
    return 1;
  }

  const child = spawn(process.execPath, [path.join('src', 'server.js')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, HOST: '0.0.0.0', STARTED_BY_LAPTOP: '1' } });
  const stop = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const finished = new Promise((resolve) => child.once('exit', (code) => resolve(code === null ? 0 : code)));

  if (!(await waitUntilUp(config.port, child))) {
    stop();
    console.error(`\nThe register did not start. If another program is using port ${config.port}, close it (or an older window of the register) and start again.\n`);
    return (await finished) || 1;
  }

  const address = pickAddress(os.networkInterfaces(), await routedAddress());
  const Database = require('better-sqlite3');
  const db = new Database(dbFile, { readonly: true });
  const checkPath = phoneCheckPath(db);
  const demo = Boolean(db.prepare("SELECT 1 FROM meta WHERE key = 'demo'").get());
  db.close();
  let qr = null;
  if (address) {
    try { qr = await require('qrcode').toString(`http://${address}:${config.port}${checkPath}`, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }); } catch { qr = null; }
  }
  console.log(banner({ address, port: config.port, checkPath, qr, demo, alertsOn: Boolean(config.alerts) }));
  if (!process.argv.includes('--no-open')) openBrowser(`http://${address || 'localhost'}:${config.port}/`);
  return finished;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
