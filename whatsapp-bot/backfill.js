/**
 * Make merged PDFs from photos you already have, going back as far as you like.
 *
 *   node backfill.js <folder> [more folders...] [options]
 *
 * It accepts either kind of folder:
 *
 *   1. A WhatsApp "Export chat" folder (Chat > More > Export chat > Include media,
 *      then unzip it on the computer). These carry the date, the sender and the
 *      photos, so sets are grouped exactly as they were sent.
 *   2. A plain folder of WhatsApp photos copied off the phone, e.g.
 *      Internal storage\Android\media\com.whatsapp\WhatsApp\Media\WhatsApp Images.
 *      The date comes from the file name (IMG-20251115-WA0012.jpg); the sender
 *      is not recorded in these files, so PDFs are named by vehicle number.
 *
 * Options
 *   --since 2025-11-01   only photos from this date on (default: 1 November last year)
 *   --until 2026-10-24   only photos up to this date
 *   --gap 30             minutes of quiet that ends one set (default 30)
 *   --min 3              photos needed before a PDF is made (default: MIN_PHOTOS or 3)
 *   --no-ocr             skip reading vehicle numbers (much faster)
 *   --dry                list what would be made, write nothing
 *
 * PDFs land in the same place as the live ones: merged\<year>\<year-month>\<date>\,
 * and the monthly Excel register is updated. Nothing is emailed or sent on WhatsApp.
 * Numbers and names in ignore-list.txt are skipped. Re-running continues where it
 * stopped; sets already made are not made twice.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const org = require('./lib/organise');
const register = require('./lib/register');
const ignore = require('./lib/ignore');
const vehicle = require('./lib/vehicle');
const { mergeFilesToPdf } = require('./lib/pdfMerge');

const IMAGE = /\.(jpe?g|png)$/i;
const DONE_FILE = path.join(org.MERGED_ROOT, 'backfill-done.json');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ── arguments ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = name => argv.includes('--' + name);
const folders = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['no-ocr', 'dry'].includes(argv[i - 1].slice(2))));
const lastNovember = () => { const n = new Date(); const y = n.getMonth() >= 10 ? n.getFullYear() : n.getFullYear() - 1; return new Date(y, 10, 1); };
const SINCE = flag('since') ? new Date(flag('since') + 'T00:00:00') : lastNovember();
const UNTIL = flag('until') ? new Date(flag('until') + 'T23:59:59') : new Date();
const GAP = parseFloat(flag('gap', '30')) * 60000;
const MIN = parseInt(flag('min', process.env.MIN_PHOTOS || '3'), 10);
const OCR = !has('no-ocr');
const DRY = has('dry');

// ── reading a folder ───────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** IMG-20251115-WA0012.jpg / VID-.. / 00000012-PHOTO-2025-11-15-10-23-45.jpg */
function dateFromName(name) {
  let m = name.match(/\b(?:IMG|PHOTO|VID)[-_](\d{4})(\d{2})(\d{2})\b/i);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  m = name.match(/\bPHOTO-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/i);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  m = name.match(/\b(\d{4})(\d{2})(\d{2})\b/);
  if (m && +m[1] > 2015 && +m[1] < 2100) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  return null;
}

/** "15/11/25, 10:23 am" | "15/11/2025, 10:23:45" | "11/15/25, 10:23 AM" */
function parseStamp(d, t) {
  const [a, b, cRaw] = d.split(/[\/.-]/).map(x => parseInt(x, 10));
  let year = cRaw < 100 ? 2000 + cRaw : cRaw;
  // day first unless the first number cannot be a day
  let day = a, month = b;
  if (a > 12 && b <= 12) { day = a; month = b; }
  else if (b > 12 && a <= 12) { day = b; month = a; }
  const tm = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
  if (!tm) return null;
  let hh = +tm[1];
  const ampm = (tm[4] || '').toLowerCase().replace(/\./g, '');
  if (ampm === 'pm' && hh < 12) hh += 12;
  if (ampm === 'am' && hh === 12) hh = 0;
  const dt = new Date(year, month - 1, day, hh, +tm[2], +(tm[3] || 0));
  return isNaN(+dt) ? null : dt;
}

/** Read a WhatsApp chat export: returns [{ at, sender, file }] for its photos. */
function readExport(dir) {
  const txt = fs.readdirSync(dir).find(f => /\.txt$/i.test(f));
  if (!txt) return null;
  const body = fs.readFileSync(path.join(dir, txt), 'utf8').replace(/[‎‏]/g, '');
  const files = new Map(fs.readdirSync(dir).map(f => [f.toLowerCase(), f]));
  const out = [];
  // [15/11/2025, 10:23:45] Name: <attached: xxx.jpg>      (iPhone)
  // 15/11/25, 10:23 am - Name: IMG-...jpg (file attached) (Android)
  const line = /^\[?(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}),\s*([\d:]{4,8}\s*(?:[ap]\.?m\.?)?)\]?\s*[-–]?\s*([^:]{1,60}):\s*(.*)$/i;
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.match(line);
    if (!m) continue;
    const at = parseStamp(m[1], m[2]);
    if (!at) continue;
    const rest = m[4];
    const att = rest.match(/<attached:\s*([^>]+)>/i) || rest.match(/([^\s<>]+\.(?:jpe?g|png))\s*\(file attached\)/i);
    if (!att) continue;
    const want = att[1].trim().toLowerCase();
    const real = files.get(want) || [...files.keys()].find(k => k.endsWith(want));
    if (!real) continue;
    out.push({ at, sender: m[3].trim(), file: path.join(dir, files.get(real) || real) });
  }
  return out.length ? out : null;
}

/** Read a plain folder of WhatsApp photos. */
function readPlain(dir) {
  const out = [];
  (function walk(d, depth) {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(Sent|Private)$/i.test(e.name) || true) walk(p, depth + 1); continue; }
      if (!IMAGE.test(e.name)) continue;
      const at = dateFromName(e.name) || fs.statSync(p).mtime;
      out.push({ at, sender: '', file: p });
    }
  })(dir, 0);
  return out;
}

// ── grouping ───────────────────────────────────────────────────────────────
function intoSets(items) {
  items.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
  const sets = [];
  let cur = null;
  for (const it of items) {
    const sameRun = cur
      && isoDate(cur.at) === isoDate(it.at)
      && (cur.sender || '') === (it.sender || '')
      && it.at - cur.files[cur.files.length - 1].at <= GAP;
    if (!sameRun) { cur = { at: it.at, sender: it.sender, files: [] }; sets.push(cur); }
    cur.files.push(it);
  }
  return sets;
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  if (!folders.length) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
    process.exit(1);
  }
  let done = {};
  try { done = JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')); } catch {}

  const all = [];
  for (const f of folders) {
    const dir = path.resolve(f);
    if (!fs.existsSync(dir)) { console.log(`skipped, not found: ${dir}`); continue; }
    if (/\.zip$/i.test(dir)) { console.log(`skipped: ${path.basename(dir)} is still a zip. Right-click it in Windows and choose "Extract All", then point me at the folder.`); continue; }
    const exp = readExport(dir);
    const items = exp || readPlain(dir);
    console.log(`${path.basename(dir)}: ${items.length} photo(s) ${exp ? 'from the chat export' : 'from file names'}`);
    all.push(...items);
  }

  const inRange = all.filter(i => i.at >= SINCE && i.at <= UNTIL);
  console.log(`\n${inRange.length} photo(s) between ${isoDate(SINCE)} and ${isoDate(UNTIL)} (of ${all.length} found)`);
  const kept = inRange.filter(i => {
    const why = ignore.isIgnored({ group: '', sender: (i.sender || '').replace(/\D/g, '') });
    if (why) return false;
    return true;
  });
  if (kept.length !== inRange.length) console.log(`${inRange.length - kept.length} skipped by ignore-list.txt`);

  const sets = intoSets(kept).filter(s => s.files.length >= MIN);
  const skippedSmall = intoSets(kept).length - sets.length;
  console.log(`${sets.length} set(s) of ${MIN}+ photos to turn into PDFs` + (skippedSmall ? `, ${skippedSmall} smaller set(s) left alone` : '') + (DRY ? '  [dry run]' : '') + '\n');

  let made = 0, already = 0, failed = 0;
  for (const [i, s] of sets.entries()) {
    const date = isoDate(s.at);
    const key = `${date}|${s.sender || 'phone'}|${s.files.length}|${path.basename(s.files[0].file)}`;
    if (done[key]) { already++; continue; }
    const head = `[${i + 1}/${sets.length}] ${date} ${s.sender || 'from the phone'} - ${s.files.length} photos`;

    let veh = null;
    if (OCR) {
      try {
        const reads = [];
        for (const f of s.files.slice(0, 6)) reads.push(await vehicle.readOne(f.file).catch(() => null));
        const d = vehicle.decide(reads.filter(Boolean));
        veh = (d && (d.number || d.partial)) || null;
      } catch {}
    }
    const hhmm = `${pad(s.at.getHours())}${pad(s.at.getMinutes())}`;
    let fname = `${(veh || s.sender || 'Photos').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_')}_${date}.pdf`;
    if (org.archiveExists(fname, s.at)) fname = fname.replace(/\.pdf$/, `_${hhmm}.pdf`);

    if (DRY) { console.log(`${head}  ->  ${fname}${veh ? '' : '  (no vehicle number)'}`); made++; continue; }
    try {
      const { bytes, pages, items } = await mergeFilesToPdf(s.files.map(f => f.file), {
        label: s.sender || 'WhatsApp photos',
        title: `${veh ? veh + ' - ' : ''}${s.sender || ''} ${date}`.trim(),
        cover: { vehicle: veh || '', from: s.sender || '', number: '', group: '', received: s.at.toLocaleString('en-IN'), agent: process.env.AGENT_NAME || '' },
      });
      const archived = org.archiveMerged(fname, Buffer.from(bytes), s.at);
      await register.add({
        date, time: `${pad(s.at.getHours())}:${pad(s.at.getMinutes())}`, vehicle: veh || '', sender: s.sender || '', number: '',
        group: '', photos: s.files.length, pdfs: 0, pages, file: archived, emailed: [],
        processedAt: new Date().toISOString(), chat: '', senderJid: '', source: 'backfill',
      });
      done[key] = archived;
      fs.writeFileSync(DONE_FILE, JSON.stringify(done));
      made++;
      console.log(`${head}  ->  ${path.basename(archived)}  (${pages} pages)`);
    } catch (e) {
      failed++;
      console.error(`${head}  FAILED: ${e.message}`);
    }
  }
  try { await vehicle.close(); } catch {}
  console.log(`\nDone. ${made} PDF(s) made, ${already} already there, ${failed} failed.`);
  console.log(`They are in ${org.MERGED_ROOT}, filed by year, month and day.`);
})().catch(e => { console.error('Backfill failed: ' + e.message); process.exit(1); });
