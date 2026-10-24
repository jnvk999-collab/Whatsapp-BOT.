/**
 * One command that says why photos are not turning into PDFs:   node doctor.js
 *
 * Checks, in plain words: is the bot running, is WhatsApp linked, is the internet
 * reachable, are the group names known, what did the bot DO with the last photos,
 * and when was the last PDF made. Prints a verdict and what to do next.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const ok = [], warn = [], bad = [];
const pass = m => ok.push('  OK    ' + m);
const caution = m => warn.push('  CHECK ' + m);
const fail = m => bad.push('  WRONG ' + m);
const H = s => '\n' + s + '\n' + '-'.repeat(s.length);

function logLines(n = 4000) {
  const dir = path.join(__dirname, 'logs');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort();
  if (!files.length) return [];
  return fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8').trim().split('\n').slice(-n);
}

function reach(host, port = 443, ms = 6000) {
  return new Promise(res => {
    const s = net.connect({ host, port });
    const done = v => { try { s.destroy(); } catch {} res(v); };
    s.setTimeout(ms);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

(async () => {
  console.log('OIC WhatsApp bot - check up\n' + '='.repeat(34));

  // 1. running?
  const PID = path.join(__dirname, '.pid');
  const pid = fs.existsSync(PID) ? parseInt(fs.readFileSync(PID, 'utf8'), 10) : 0;
  let alive = false;
  try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
  if (alive) pass(`the bot is running (pid ${pid})`);
  else fail('the bot is NOT running. Start it with:  node start.js');

  // 2. linked to WhatsApp?
  const lines = logLines();
  const lastReady = [...lines].reverse().find(l => l.includes('Ready as'));
  const lastClosed = [...lines].reverse().find(l => l.includes('connection closed'));
  if (fs.existsSync(path.join(__dirname, 'qr.png'))) fail('WhatsApp is not linked: open qr.png in this folder and scan it from WhatsApp > Linked devices');
  else if (lastReady) pass('WhatsApp was linked: ' + lastReady.trim().slice(0, 90));
  else caution('no "Ready as" line in the log yet, so the bot may never have connected');
  if (lastClosed && lastReady && lines.indexOf(lastClosed) > lines.indexOf(lastReady)) caution('the connection dropped after the last successful link: ' + lastClosed.trim());

  // 3. internet
  for (const [name, host] of [['WhatsApp', 'web.whatsapp.com'], ['GitHub (updates)', 'api.github.com'], ['Gmail (email)', 'smtp.gmail.com']]) {
    if (await reach(host, host === 'smtp.gmail.com' ? 465 : 443)) pass(`${name} is reachable`);
    else fail(`${name} cannot be reached (${host}). Internet, firewall, antivirus or VPN is blocking it`);
  }

  // 4. group names known
  const cacheFile = path.join(__dirname, 'groups-cache.json');
  let known = {};
  try { known = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  const nKnown = Object.keys(known).length;
  const ignore = require('./lib/ignore');
  const allow = ignore.allowedGroups();
  if (!allow) caution('no allowed-groups.txt, so ALL groups are handled');
  else {
    pass(`allowed-groups.txt lists ${allow.size} group(s)`);
    if (!nKnown) caution('no group names remembered yet (groups-cache.json missing). Until the bot can read group names, photos are handled anyway so none are lost');
    else {
      const norm = s => String(s || '').replace(/^﻿/, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const names = Object.values(known).map(norm);
      const missing = [...allow].filter(a => !names.includes(a));
      if (missing.length) caution(`these names in allowed-groups.txt do not match any group WhatsApp reported: ${missing.join(' | ')}`);
      else pass(`every group in allowed-groups.txt was found (${nKnown} groups known)`);
    }
  }

  // 5. settings that decide what happens to photos
  const minPhotos = parseInt(process.env.MIN_PHOTOS || '3', 10);
  pass(`a set needs at least ${minPhotos} photos before a PDF is made`);
  pass(`merge waits ${process.env.MERGE_WAIT_SECONDS || 45}s after the last photo`);
  if ((process.env.AUTO_PDF || '1') !== '1') fail('AUTO_PDF is not 1 in .env, so no PDFs will ever be made');
  if (!process.env.EMAIL_APP_PASSWORD) caution('no EMAIL_APP_PASSWORD in .env, so PDFs will not be emailed');

  // 6. what the bot actually did with recent photos
  const counts = {};
  const tally = (re, key) => { const n = lines.filter(l => re.test(l)).length; if (n) counts[key] = n; };
  tally(/\[ignore\]/, 'messages ignored (group or number not allowed)');
  tally(/\[skip\]/, 'sets skipped (fewer photos than the minimum)');
  tally(/\[groups\] name of .* unknown/, 'photos handled while the group name was unknown');
  tally(/merged .* into/i, 'PDFs made');
  tally(/\[fatal-caught\]|\[rejection\]/, 'crashes caught');
  tally(/\[watchdog\]/, 'watchdog restarts');
  const recent = lines.filter(l => /\[ignore\]|\[skip\]/.test(l)).slice(-5);

  // 7. last PDF on disk
  const MERGED = process.env.MERGED_DIR || path.join(__dirname, 'merged');
  let newest = null;
  (function walk(dir, depth) {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.toLowerCase().endsWith('.pdf')) {
        const t = fs.statSync(p).mtimeMs;
        if (!newest || t > newest.t) newest = { p, t };
      }
    }
  })(MERGED, 0);
  if (newest) {
    const days = Math.floor((Date.now() - newest.t) / 86400000);
    const msg = `last merged PDF: ${path.basename(newest.p)} (${days === 0 ? 'today' : days + ' day(s) ago'})`;
    days > 2 ? caution(msg) : pass(msg);
  } else caution('no merged PDF has ever been made in ' + MERGED);

  // report
  console.log(H('What is wrong'));
  console.log(bad.length ? bad.join('\n') : '  nothing clearly broken');
  if (warn.length) { console.log(H('Worth a look')); console.log(warn.join('\n')); }
  console.log(H('Fine'));
  console.log(ok.join('\n'));
  console.log(H('What the log shows'));
  if (!Object.keys(counts).length) console.log('  no photo activity in the log yet');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${String(v).padStart(4)}  ${k}`);
  if (recent.length) { console.log('\n  most recent skips/ignores:'); recent.forEach(l => console.log('    ' + l.trim())); }

  console.log(H('Next step'));
  if (!alive) console.log('  Run:  node start.js');
  else if (bad.length) console.log('  Fix the WRONG lines above, then:  node stop.js   node start.js');
  else if (warn.length) console.log('  Send these CHECK lines to Claude if photos still do not arrive.');
  else console.log('  Everything looks right. Send 3 photos to an allowed group and run this again.');
  console.log('');
})();
