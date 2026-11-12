'use strict';
/**
 * Starting it on your own laptop with one double-click, so that a phone on the
 * same Wi-Fi can scan the QR codes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeWorld } = require('./helpers');
const { plan, pickAddress, phoneCheckPath, banner } = require('../scripts/laptop');

const ROOT = path.join(__dirname, '..');
const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal });

test('it works out what still has to be done before starting', () => {
  assert.deepEqual(plan({ nodeMajor: 26, hasModules: false, hasDb: false }).steps, ['install', 'demo-data', 'start']);
  assert.deepEqual(plan({ nodeMajor: 24, hasModules: true, hasDb: false }).steps, ['demo-data', 'start']);
  assert.deepEqual(plan({ nodeMajor: 22, hasModules: true, hasDb: true }).steps, ['start'], 'existing records are never replaced');
});

test('an old Node.js is explained instead of failing halfway through the install', () => {
  for (const nodeMajor of [16, 18, 20, 21]) {
    const p = plan({ nodeMajor, hasModules: false, hasDb: false });
    assert.deepEqual(p.steps, []);
    assert.match(p.problem, /nodejs\.org/);
    assert.match(p.problem, new RegExp(String(nodeMajor)));
  }
  assert.equal(plan({ nodeMajor: 22, hasModules: true, hasDb: true }).problem, null);
});

test('the address given to the phone is the one the Wi-Fi uses', () => {
  const laptop = {
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
    'vEthernet (WSL)': [v4('172.28.112.1')],
    'VirtualBox Host-Only Network': [v4('192.168.56.1')],
    'Wi-Fi': [{ address: 'fe80::1', family: 'IPv6', internal: false }, v4('192.168.1.23')],
  };
  assert.equal(pickAddress(laptop, null), '192.168.1.23', 'virtual adapters are passed over');
  assert.equal(pickAddress(laptop, '192.168.1.23'), '192.168.1.23');
  assert.equal(pickAddress({ 'Ethernet 2': [v4('10.4.0.9')], 'Wi-Fi': [v4('192.168.43.50')] }, '10.4.0.9'), '10.4.0.9', 'the route the computer really uses wins');
  assert.equal(pickAddress(laptop, '203.0.113.9'), '192.168.1.23', 'an address this computer does not have is ignored');
  assert.equal(pickAddress({ en0: [v4('169.254.10.2')] }, null), null, 'a self-assigned address means no network');
  assert.equal(pickAddress({ lo: [v4('127.0.0.1', true)] }, null), null);
  assert.equal(pickAddress({ wlan0: [{ address: '192.168.0.7', family: 4, internal: false }] }, null), '192.168.0.7');
});

test('the phone check opens a real report form when there is equipment, otherwise the sign-in page', async () => {
  const w = await makeWorld();
  assert.equal(phoneCheckPath(w.db), '/login');
  const pc = w.addPc();
  assert.equal(phoneCheckPath(w.db), '/e/' + pc.asset_tag);
  w.db.prepare("UPDATE equipment SET status = 'retired' WHERE id = ?").run(pc.id);
  assert.equal(phoneCheckPath(w.db), '/login', 'a written-off item is not offered');
});

test('the start-up message gives the phone address and what to do when the phone cannot connect', () => {
  const text = banner({ address: '192.168.1.23', port: 3000, checkPath: '/e/PC-00001', qr: '[QR]', demo: true, alertsOn: false });
  assert.match(text, /http:\/\/192\.168\.1\.23:3000\/e\/PC-00001/);
  assert.match(text, /\[QR\]/);
  assert.match(text, /same Wi-Fi/);
  assert.match(text, /hotspot/i);
  assert.match(text, /Allow/);
  assert.match(text, /ADMIN01/);
  assert.match(text, /npm run alerts/);
  const real = banner({ address: '192.168.1.23', port: 3000, checkPath: '/login', qr: '[QR]', demo: false, alertsOn: true });
  assert.doesNotMatch(real, /ADMIN01|Register#/, 'demo sign-ins are shown only with the demo data');
  assert.doesNotMatch(real, /npm run alerts/);
  const offline = banner({ address: null, port: 3000, checkPath: '/login', qr: null, demo: true, alertsOn: false });
  assert.match(offline, /not connected to a network/i);
  assert.match(offline, /http:\/\/localhost:3000/);
});

test('the double-click starters are in the project and are written for their system', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'start-windows.bat'));
  const text = bat.toString('latin1');
  assert.ok(text.includes('\r\n') && !/[^\r]\n/.test(text), 'Windows line endings throughout');
  assert.ok(bat.every((byte) => byte < 128), 'plain ASCII, so any Windows language setting can read it');
  assert.match(text, /scripts\\laptop\.js/);
  assert.match(text, /nodejs\.org/);
  assert.match(text, /cd \/d "%~dp0"/);

  const sh = fs.readFileSync(path.join(ROOT, 'start-mac-linux.command'), 'utf8');
  assert.ok(sh.startsWith('#!/bin/sh\n'));
  assert.ok(!sh.includes('\r'));
  assert.match(sh, /scripts\/laptop\.js/);
  assert.ok(fs.statSync(path.join(ROOT, 'start-mac-linux.command')).mode & 0o100, 'marked as runnable');

  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.laptop, 'node scripts/laptop.js');
  assert.equal(scripts.alerts, 'node scripts/alerts.js');
});
