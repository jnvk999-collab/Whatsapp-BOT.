/**
 * Pack everything this computer holds that the next one cannot download:
 *
 *   node pack.js                 make the zip on the Desktop
 *   node pack.js --no-merged     leave the merged PDFs out (much smaller)
 *   node pack.js --no-login      leave the WhatsApp login out (scan a QR instead)
 *   node pack.js --dest "D:\"    put the zip somewhere else
 *
 * The code itself is NOT packed: the new computer downloads that from GitHub,
 * always the newest version. What travels is the things that exist only here:
 * your settings, your WhatsApp login, your group and routing lists, your
 * renewal sheet, the merged PDFs and the register behind them.
 *
 * The zip contains your Gmail app password and your WhatsApp login, so treat it
 * like a key: hand it over on a pen drive rather than by email, and delete it
 * from both computers once the new one works.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const HERE = __dirname;
const home = process.env.USERPROFILE || process.env.HOME || '.';
const deskOrHome = fs.existsSync(path.join(home, 'Desktop')) ? path.join(home, 'Desktop') : home;
const stamp = new Date().toISOString().slice(0, 10);
const OUT = path.resolve(flag('dest', deskOrHome), `oic-bot-migration-${stamp}.zip`);

// what to take, and why it cannot simply be downloaded again
const ITEMS = [
  { p: '.env', why: 'your settings, email address and app password', secret: true },
  { p: 'baileys_auth', why: 'the WhatsApp login, so the new PC needs no QR scan', secret: true, skip: has('no-login') },
  { p: 'allowed-groups.txt', why: 'the groups the bot handles' },
  { p: 'ignore-list.txt', why: 'the groups and numbers it skips' },
  { p: 'email-routes.txt', why: 'who gets a copy of which group by email' },
  { p: 'reminders.txt', why: 'your daily reminders' },
  { p: 'renewals.xlsx', why: 'the renewal sheet' },
  { p: 'groups-cache.json', why: 'group names it has learned' },
  { p: 'inbox/processed.json', why: 'which WhatsApp messages are already done' },
  { p: 'merged', why: 'the merged PDFs, the register and the policy list', skip: has('no-merged') },
  { p: 'outbox', why: 'PDFs waiting to be sent' },
  { p: '.version', why: 'which version this computer was on' },
];

const sizeOf = (p) => {
  let n = 0;
  const st = fs.statSync(p);
  if (st.isFile()) return st.size;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    try { n += sizeOf(path.join(p, e.name)); } catch {}
  }
  return n;
};
const mb = b => (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB';

const copyInto = (from, to) => {
  const st = fs.statSync(from);
  if (st.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); return; }
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) copyInto(path.join(from, e.name), path.join(to, e.name));
};

(async () => {
  console.log('Packing this bot for another computer\n' + '='.repeat(37) + '\n');

  const take = [], missing = [];
  let total = 0;
  for (const it of ITEMS) {
    const full = path.join(HERE, it.p);
    if (it.skip) { console.log(`  left out   ${it.p}  (you asked)`); continue; }
    if (!fs.existsSync(full)) { missing.push(it); continue; }
    const s = sizeOf(full);
    total += s;
    take.push({ ...it, full, size: s });
    console.log(`  packing    ${it.p.padEnd(22)} ${mb(s).padStart(9)}   ${it.why}`);
  }
  for (const it of missing) console.log(`  not here   ${it.p.padEnd(22)}           ${it.why}`);

  if (!take.length) { console.log('\nNothing to pack. Are you in the whatsapp-bot folder?'); process.exit(1); }
  console.log(`\n  total ${mb(total)}`);
  if (total > 500 * 1048576) console.log('  That is large because of the merged PDFs. Use --no-merged and copy that folder separately if you prefer.');

  // stage, so the zip keeps the same folder shape the bot expects
  const stage = path.join(require('os').tmpdir(), 'oic-pack-' + process.pid);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const it of take) copyInto(it.full, path.join(stage, it.p));

  // a note to whoever opens the zip
  fs.writeFileSync(path.join(stage, 'READ-ME-FIRST.txt'), [
    'OIC WhatsApp bot — everything from the old computer',
    'Packed ' + new Date().toLocaleString('en-IN'),
    '',
    'This holds settings, the WhatsApp login and your PDFs. It does NOT hold the',
    'program: the new computer downloads that from GitHub, newest version.',
    '',
    'On the new computer:',
    '  1. Install Node.js from nodejs.org (the LTS button).',
    '  2. Download the bot:',
    '     https://github.com/jnvk999-collab/PREMIUM-CALCULATOR/archive/refs/heads/claude/whatsapp-photo-pdf-automation-mgr9gu.zip',
    '     Unzip it. The folder you want inside is whatsapp-bot.',
    '  3. Unzip THIS file into that same whatsapp-bot folder, keeping the folder names.',
    '  4. Open cmd in that folder and run, one at a time:',
    '       npm install',
    '       node ocr-upgrade.js',
    '       node doctor.js',
    '       node start.js',
    '       node install-autostart.js',
    '',
    'Keep this zip private: it contains your email app password and WhatsApp login.',
    'Delete it from both computers once the new one works.',
  ].join('\n'));

  console.log('\n  making the zip...');
  fs.rmSync(OUT, { force: true });
  let r;
  if (process.platform === 'win32') {
    // tar ships with Windows 10 and later and takes "." so files whose names
    // begin with a dot, .env above all, are not quietly left out.
    r = spawnSync('tar.exe', ['-a', '-c', '-f', OUT, '-C', stage, '.'], { stdio: 'pipe' });
    if (r.status !== 0 || !fs.existsSync(OUT)) {
      r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -Force -DestinationPath '${OUT.replace(/'/g, "''")}'`], { stdio: 'pipe' });
    }
  } else {
    r = spawnSync('sh', ['-c', `cd "${stage}" && zip -qr "${OUT}" .`], { stdio: 'pipe' });
  }
  if (r.status !== 0 || !fs.existsSync(OUT)) {
    console.log('\nCould not make the zip automatically. Everything is gathered here:');
    console.log('  ' + stage);
    console.log('Right-click that folder in Windows, Send to, Compressed (zipped) folder, and copy that.');
    process.exit(1);
  }
  fs.rmSync(stage, { recursive: true, force: true });

  console.log(`\nDone.  ${OUT}  (${mb(fs.statSync(OUT).size)})\n`);
  console.log('Copy it to the new computer on a pen drive. Inside it is READ-ME-FIRST.txt');
  console.log('with the steps, and MIGRATION.md in the bot folder has the long version.');
  console.log('\nIt contains your Gmail app password and WhatsApp login, so do not email it,');
  console.log('and delete it from both computers once the new one is working.');
})().catch(e => { console.error('Packing failed: ' + e.message); process.exit(1); });
