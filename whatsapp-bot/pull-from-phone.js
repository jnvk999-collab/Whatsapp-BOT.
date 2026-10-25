/**
 * Copy WhatsApp photos off an Android phone the reliable way:   node pull-from-phone.js
 *
 * Windows' own phone connection (the one Explorer uses) counts every file
 * before it copies anything, which on a folder of twenty thousand photos can
 * sit on "Calculating..." for hours. This uses Android's own transfer tool
 * instead, which streams the files straight across with no counting.
 *
 * You do this once on the phone:
 *   Settings > About device > tap "Build number" seven times (it says you are
 *   now a developer) > back > System > Developer options > turn on USB debugging.
 * Plug the phone in, run this, and tap "Allow" on the phone when it asks.
 *
 * The tool it needs is downloaded automatically from Google the first time
 * (about 10 MB) into platform-tools\ inside this folder.
 *
 *   node pull-from-phone.js                  copy to Desktop\WhatsApp Images
 *   node pull-from-phone.js --dest "D:\pics"
 *   node pull-from-phone.js --check          just say whether the phone is ready
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = n => argv.includes('--' + n);

const home = process.env.USERPROFILE || process.env.HOME || '.';
const DEST = path.resolve(flag('dest', path.join(home, 'Desktop', 'WhatsApp Images')));
const TOOLS = path.join(__dirname, 'platform-tools');
const ADB = path.join(TOOLS, process.platform === 'win32' ? 'adb.exe' : 'adb');
const ZIP_URL = process.platform === 'win32'
  ? 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'
  : 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip';

// Where WhatsApp keeps photos, newest Android layout first.
const SOURCES = [
  '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images',
  '/sdcard/WhatsApp/Media/WhatsApp Images',
  '/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images',
  '/storage/emulated/0/WhatsApp/Media/WhatsApp Images',
];

const adb = (args, opts = {}) => spawnSync(adbPath(), args, { encoding: 'utf8', ...opts });
function adbPath() {
  if (fs.existsSync(ADB)) return ADB;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['adb'], { encoding: 'utf8' });
  const found = (which.stdout || '').trim().split(/\r?\n/)[0];
  return found && fs.existsSync(found) ? found : ADB;
}

async function ensureAdb() {
  if (fs.existsSync(adbPath())) return true;
  console.log('Getting Android\'s transfer tool from Google (about 10 MB, once only)...');
  const zip = path.join(__dirname, 'platform-tools.zip');
  try {
    const res = await fetch(ZIP_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    console.error('Could not download it: ' + e.message);
    console.error('Download this in a browser, unzip it into this folder, then run me again:');
    console.error('  ' + ZIP_URL);
    return false;
  }
  const r = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${__dirname.replace(/'/g, "''")}' -Force`], { stdio: 'pipe' })
    : spawnSync('unzip', ['-o', '-q', zip, '-d', __dirname], { stdio: 'pipe' });
  try { fs.unlinkSync(zip); } catch {}
  if (!fs.existsSync(adbPath())) { console.error('Could not unpack it. Unzip platform-tools.zip into this folder by hand.'); return false; }
  console.log('Ready.\n');
  return true;
}

function phoneState() {
  const out = adb(['devices']).stdout || '';
  const lines = out.trim().split(/\r?\n/).slice(1).filter(Boolean);
  if (!lines.length) return 'none';
  if (lines.some(l => /\bunauthorized\b/.test(l))) return 'unauthorized';
  if (lines.some(l => /\bdevice$/.test(l.trim()))) return 'ready';
  if (lines.some(l => /\boffline\b/.test(l))) return 'offline';
  return 'unknown';
}

(async () => {
  if (!(await ensureAdb())) process.exit(1);
  adb(['start-server']);

  let state = phoneState();
  if (state === 'none') {
    console.log('No phone found. On the phone:');
    console.log('  1. Settings > About device > tap "Build number" seven times.');
    console.log('  2. Settings > System > Developer options > turn on "USB debugging".');
    console.log('  3. Plug the cable in and run this again.');
    process.exit(1);
  }
  if (state === 'unauthorized') {
    console.log('The phone is asking you to trust this computer.');
    console.log('Look at the phone screen and tap "Allow" (tick "Always allow" first).');
    for (let i = 0; i < 60 && state !== 'ready'; i++) {
      await new Promise(r => setTimeout(r, 2000));
      state = phoneState();
      process.stdout.write('\r  waiting for you to tap Allow... ' + (i * 2) + 's   ');
    }
    console.log('');
  }
  if (state !== 'ready') { console.log('Phone is ' + state + '. Unplug, plug back in, and run this again.'); process.exit(1); }

  const model = (adb(['shell', 'getprop', 'ro.product.model']).stdout || '').trim();
  console.log('Phone connected' + (model ? ': ' + model : '') + '\n');

  let src = null, count = 0;
  for (const s of SOURCES) {
    const r = adb(['shell', `ls "${s}" 2>/dev/null | wc -l`]);
    const n = parseInt((r.stdout || '').trim(), 10);
    if (n > 0) { console.log(`  ${n} file(s) in ${s}`); if (n > count) { count = n; src = s; } }
  }
  if (!src) {
    console.log('No WhatsApp Images folder found on the phone. What it does have:');
    const r = adb(['shell', 'ls /sdcard/Android/media/com.whatsapp/WhatsApp/Media /sdcard/WhatsApp/Media 2>/dev/null']);
    console.log((r.stdout || '(nothing)').trim());
    process.exit(1);
  }
  if (has('check')) { console.log(`\nReady. Run it again without --check to copy ${count} file(s) into ${DEST}`); process.exit(0); }

  fs.mkdirSync(DEST, { recursive: true });
  console.log(`\nCopying ${count} file(s) into ${DEST}`);
  console.log('This streams straight off the phone. Leave it running.\n');

  const started = Date.now();
  const child = spawn(adbPath(), ['pull', '-a', src + '/.', DEST], { stdio: ['ignore', 'pipe', 'pipe'] });
  let lastLine = '';
  const onData = d => {
    const t = d.toString();
    lastLine = t.trim().split(/\r?\n/).pop() || lastLine;
    const m = t.match(/\[\s*(\d+)%\]/g);
    if (m) process.stdout.write(`\r  ${m[m.length - 1].replace(/[\[\]\s]/g, '')} done, ${Math.round((Date.now() - started) / 60000)} min elapsed     `);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    let have = 0;
    try { have = fs.readdirSync(DEST).filter(f => !f.startsWith('.')).length; } catch {}
    console.log(`\n\n${have} file(s) are now in ${DEST}`);
    if (lastLine) console.log(lastLine);
    if (have) {
      console.log('\nNow make the PDFs:');
      console.log('  node backfill.js --since 2025-11-01 --dry');
    } else if (code) {
      console.log('\nNothing came across. Run the same command again; it picks up where it stopped.');
    }
  });
})().catch(e => { console.error('Failed: ' + e.message); process.exit(1); });
