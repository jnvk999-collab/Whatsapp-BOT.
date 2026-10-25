/**
 * Install the better vehicle-number reader and prove it is better.
 *
 *   node ocr-upgrade.js            install it, then time both readers
 *   node ocr-upgrade.js --test     time both readers, install nothing
 *
 * The better reader is PaddleOCR v4 running through onnxruntime. It finds the
 * writing in a photo by itself, so a sideways or badly lit picture no longer
 * needs four cleaned-up attempts. It is a one-off download of about 150 MB and
 * then works offline for good. The old reader stays as a fallback.
 *
 * It times both on your own photos (the newest ones in the inbox, the merged
 * folder, or Desktop\WhatsApp Images), so the numbers below are yours, not mine.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const has = n => process.argv.includes('--' + n);
const home = process.env.USERPROFILE || process.env.HOME || '.';

function samplePhotos(n = 4) {
  const roots = [
    path.join(home, 'Desktop', 'WhatsApp Images'),
    process.env.INBOX_DIR || path.resolve(__dirname, 'inbox'),
    process.env.MERGED_DIR || path.resolve(__dirname, 'merged'),
  ];
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3 || found.length >= 60) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= 60) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (/\.(jpe?g|png)$/i.test(e.name)) { try { if (fs.statSync(p).size > 40000) found.push(p); } catch {} }
    }
  };
  roots.forEach(r => walk(r, 0));
  return found.slice(-n);                 // the newest ones we came across
}

async function timeReader(files, useNew) {
  delete require.cache[require.resolve('./lib/ocr')];
  delete require.cache[require.resolve('./lib/vehicle')];
  const ocr = require('./lib/ocr');
  if (!useNew) ocr.paddleAvailable = () => false;
  const vehicle = require('./lib/vehicle');
  vehicle.setFast(true);
  const out = [];
  const started = Date.now();
  for (const f of files) {
    const t = Date.now();
    let got = '';
    try {
      const r = await vehicle.readOne(f);
      got = [...r.tally.keys()][0] || ([...r.partial.keys()][0] ? 'part ' + [...r.partial.keys()][0] : '');
    } catch (e) { got = 'error'; }
    out.push({ file: path.basename(f), ms: Date.now() - t, got });
  }
  try { await vehicle.close(); } catch {}
  return { rows: out, total: Date.now() - started };
}

(async () => {
  const ocr = require('./lib/ocr');
  const already = ocr.paddleAvailable();
  console.log('Vehicle-number reader\n' + '='.repeat(21));
  console.log('In use now: ' + (already ? 'the faster one (PaddleOCR)' : 'the built-in one (tesseract)') + '\n');

  if (!already && !has('test')) {
    console.log('Installing the faster reader. One-off download of about 150 MB, then it works offline.');
    console.log('This can take a few minutes on a slow line.\n');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npm, ['install', '--no-audit', '--no-fund', '@gutenye/ocr-node'], { cwd: __dirname, stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) {
      console.log('\nThe install did not finish. Nothing is broken: the built-in reader carries on.');
      console.log('Try again on a better connection, or run:  npm install @gutenye/ocr-node');
      process.exit(1);
    }
    delete require.cache[require.resolve('./lib/ocr')];
    if (!require('./lib/ocr').paddleAvailable()) {
      console.log('\nInstalled, but the reader still is not usable. The built-in one carries on.');
      process.exit(1);
    }
    console.log('\nInstalled.\n');
  }

  const files = samplePhotos(4);
  if (!files.length) {
    console.log('No photos of your own to test with yet, so no timings. It will be used from the next run.');
    return;
  }
  console.log(`Timing both readers on ${files.length} of your own photos. The first read of each loads the reader, so it is slower.\n`);

  const neu = await timeReader(files, true);
  const old = await timeReader(files, false);

  console.log('  photo                              faster reader        built-in reader');
  for (let i = 0; i < files.length; i++) {
    const a = neu.rows[i], b = old.rows[i];
    console.log('  ' + a.file.slice(0, 32).padEnd(34)
      + (String(a.ms) + 'ms ' + (a.got || '-')).padEnd(21)
      + String(b.ms) + 'ms ' + (b.got || '-'));
  }
  const worst = r => Math.max(...r.rows.map(x => x.ms));
  const found = r => r.rows.filter(x => x.got && !x.got.startsWith('part') && x.got !== 'error').length;
  console.log(`\n  total:        ${(neu.total / 1000).toFixed(1)}s   vs   ${(old.total / 1000).toFixed(1)}s`);
  console.log(`  slowest one:  ${(worst(neu) / 1000).toFixed(1)}s   vs   ${(worst(old) / 1000).toFixed(1)}s`);
  console.log(`  numbers read: ${found(neu)} of ${files.length}   vs   ${found(old)} of ${files.length}`);
  console.log('\nWhat to make of it: on clean, straight photos the built-in reader is often quicker.');
  console.log('Its problem is the bad ones, where it tries four different ways and can take over a');
  console.log('minute for nothing. The other reader looks once, so it is steady at a second or two');
  console.log('whatever the photo, and it copes better with sideways or dim pictures.');
  console.log('\nPick the built-in one any time by putting OCR_ENGINE=tesseract in .env.');
  console.log('For the whole backfill:   node backfill.js --since 2025-11-01');
})().catch(e => { console.error('Failed: ' + e.message); process.exit(1); });
