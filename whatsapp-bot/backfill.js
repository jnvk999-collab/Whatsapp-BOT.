/**
 * Make merged PDFs from photos you already have, going back as far as you like.
 *
 *   node backfill.js <folder> [more folders...] [options]
 *
 * ANDROID, the way that keeps the sender's name:
 *   1. Copy the photos off the phone once (cable > File transfer):
 *        Internal storage\Android\media\com.whatsapp\WhatsApp\Media\WhatsApp Images
 *      (on older phones: Internal storage\WhatsApp\Media\WhatsApp Images)
 *   2. In WhatsApp, for each chat: contact name > Export chat > WITHOUT media.
 *      That is only a small text file, so you can mail yourself many at once.
 *      Save all those .txt files into one folder.
 *   3. Point this at both:
 *        node backfill.js "C:\old\WhatsApp Images" "C:\old\chats" --since 2025-11-01
 *      The text files say who sent which photo and when; the photos come from
 *      the media folder. PDFs are named <VEHICLE>_<Sender>_<date>.pdf and filed
 *      under merged\<year>\<year-month>\<date>\.
 *
 * iPhone, or if you prefer one step: export each chat WITH media, unzip, and
 * pass the unzipped folders. Photos with no chat file are still merged; they are
 * grouped by date and named by vehicle number.
 *
 * Options
 *   --since 2025-11-01   only photos from this date on (default: 1 November last year)
 *   --until 2026-10-24   only photos up to this date
 *   --gap 30             minutes of quiet that ends one set (default 30)
 *   --min 3              photos needed before a PDF is made (default: MIN_PHOTOS or 3)
 *   --only-numbers       skip group chats, keep one-to-one chats only
 *   --maxset 20          most photos in one PDF (a bigger run is split)
 *   --ocr-photos 4       how many photos of a set to try reading
 *   --ocr-parallel 3     how many photos to read at the same time
 *   --ocr-full           read every photo every way (slow, slightly better)
 *   --no-ocr             skip reading vehicle numbers (much faster)
 *   --rename             keep the PDFs, just read the numbers again for the ones
 *                        named only by date, and rename those
 *   --redo               delete the PDFs an earlier backfill made, then build again
 *   --undo               delete them and stop
 *   --dry                list what would be made, write nothing
 *
 * Nothing is emailed or sent on WhatsApp. Names and numbers in ignore-list.txt
 * are skipped. Re-running continues where it stopped.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const org = require('./lib/organise');
const register = require('./lib/register');
const ignore = require('./lib/ignore');
const vehicle = require('./lib/vehicle');
const { mergeFilesToPdf } = require('./lib/pdfMerge');
const { spawnSync } = require('child_process');

const IMAGE = /\.(jpe?g|png)$/i;
const DONE_FILE = path.join(org.MERGED_ROOT, 'backfill-done.json');
const INVISIBLE = /[\u200e\u200f\u202a-\u202e]/g;

// ── arguments ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const VALUE_FLAGS = ['since', 'until', 'gap', 'min'];
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = name => argv.includes('--' + name);
const folders = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && VALUE_FLAGS.includes(argv[i - 1].slice(2))));
const lastNovember = () => { const n = new Date(); const y = n.getMonth() >= 10 ? n.getFullYear() : n.getFullYear() - 1; return new Date(y, 10, 1); };
const SINCE = flag('since') ? new Date(flag('since') + 'T00:00:00') : lastNovember();
const UNTIL = flag('until') ? new Date(flag('until') + 'T23:59:59') : new Date();
const GAP = parseFloat(flag('gap', '30')) * 60000;
const MIN = parseInt(flag('min', process.env.MIN_PHOTOS || '3'), 10);
const OCR = !has('no-ocr');
const OCR_PHOTOS = parseInt(flag('ocr-photos', '4'), 10);          // how many photos of a set to try
const OCR_PARALLEL = parseInt(flag('ocr-parallel', String(Math.max(2, Math.min(4, (require('os').cpus() || []).length - 1)))), 10);
const MAX_SET = parseInt(flag('maxset', '20'), 10);                // a PDF of 113 photos is several customers
const FULL_OCR = has('ocr-full');
const RENAME = has('rename');
let renamed = 0, renameTried = 0;
const renamedRows = [];
const DRY = has('dry');
const ONLY_NUMBERS = has('only-numbers');

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clean = s => String(s || '').replace(INVISIBLE, '').trim();

// ── finding the photos ─────────────────────────────────────────────────────
// Every image under every folder you passed: lower-case file name -> full path.
// This is what lets a chat exported WITHOUT media find its photos inside the one
// big folder copied off the phone.
const photoIndex = new Map();
const chatFiles = [];
const scanned = new Set();
function scan(dir, depth = 0) {
  if (depth > 5) return;
  // a folder can be reached twice (a zip unpacked inside a folder we also scan)
  const key = path.resolve(dir).toLowerCase();
  if (scanned.has(key)) return;
  scanned.add(key);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scan(p, depth + 1); continue; }
    if (IMAGE.test(e.name)) { if (!photoIndex.has(e.name.toLowerCase())) photoIndex.set(e.name.toLowerCase(), p); continue; }
    if (/\.txt$/i.test(e.name) && !chatFiles.some(c => path.basename(c).toLowerCase() === e.name.toLowerCase())) chatFiles.push(p);
  }
}

/** IMG-20251115-WA0012.jpg / 00000012-PHOTO-2025-11-15-10-23-45.jpg */
function dateFromName(name) {
  let m = name.match(/\bPHOTO-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/i);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  m = name.match(/\b(?:IMG|PHOTO|VID)[-_](\d{4})(\d{2})(\d{2})\b/i);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  m = name.match(/\b(\d{4})(\d{2})(\d{2})\b/);
  if (m && +m[1] > 2015 && +m[1] < 2100) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  return null;
}

/** "15/11/25, 10:23 am" | "15/11/2025, 10:23:45" | "11/15/25, 10:23 AM" */
function parseStamp(d, t) {
  const [a, b, cRaw] = d.split(/[\/.-]/).map(x => parseInt(x, 10));
  const year = cRaw < 100 ? 2000 + cRaw : cRaw;
  let day = a, month = b;                       // day first, the Indian format
  if (b > 12 && a <= 12) { day = b; month = a; } // unless only the second can be a day
  const tm = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
  if (!tm) return null;
  let hh = +tm[1];
  const ampm = (tm[4] || '').toLowerCase().replace(/\./g, '');
  if (ampm === 'pm' && hh < 12) hh += 12;
  if (ampm === 'am' && hh === 12) hh = 0;
  const dt = new Date(year, month - 1, day, hh, +tm[2], +(tm[3] || 0));
  return isNaN(+dt) ? null : dt;
}

const claimed = new Set();     // photos a chat export has accounted for
const LINE = /^\[?(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}),\s*([\d:]{4,8}\s*(?:[ap]\.?m\.?)?)\]?\s*[-\u2013]?\s*([^:]{1,60}):\s*(.*)$/i;

/** Read one exported chat (.txt), with or without its media alongside. */
function readChat(txtPath) {
  const body = fs.readFileSync(txtPath, 'utf8').replace(INVISIBLE, '');
  const title = clean(path.basename(txtPath).replace(/\.txt$/i, '').replace(/^WhatsApp Chat (with )?/i, ''));
  const items = [], senders = new Set();
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) continue;
    const at = parseStamp(m[1], m[2]);
    if (!at) continue;
    const who = clean(m[3]);
    senders.add(who);
    const att = m[4].match(/<attached:\s*([^>]+)>/i) || m[4].match(/([^\s<>]+\.(?:jpe?g|png))\s*\(file attached\)/i);
    if (!att) continue;
    const want = path.basename(clean(att[1])).toLowerCase();
    let file = photoIndex.get(want);
    if (!file) { const k = [...photoIndex.keys()].find(k => k.endsWith(want)); if (k) file = photoIndex.get(k); }
    if (!file) continue;                        // named in the chat, but not copied over
    claimed.add(file);
    items.push({ at, sender: who, chat: title, file });
  }
  // In a one-to-one chat every line is from the other person (the chat title) or
  // from you, so at most one sender differs from the title. More than that, or a
  // "created group"/"added"/"left" line, means it is a group.
  const norm = x => clean(x).toLowerCase();
  const others = [...senders].filter(x => norm(x) !== norm(title));
  const systemLine = /\b(created (this )?group|added you|was added|added \+?\d|left\b|changed the subject|removed)\b/i.test(body);
  const isGroup = others.length > 1 || systemLine;
  return { items, title, isGroup, senders: [...senders] };
}

/** Photos no chat file accounted for: still usable, just without a sender. */
function unclaimedPhotos() {
  const out = [];
  for (const file of photoIndex.values()) {
    if (claimed.has(file)) continue;
    let at = dateFromName(path.basename(file));
    try {
      const mt = fs.statSync(file).mtime;
      // The name gives the day; it carries no clock time, so everything would
      // land at noon and a whole day would clump together. Borrow the time of
      // day from the file itself when it agrees about the date.
      if (!at) at = mt;
      else if (isoDate(mt) === isoDate(at)) at = mt;
    } catch {}
    if (!at) continue;
    out.push({ at, sender: '', chat: '', file });
  }
  return out;
}

// ── grouping ───────────────────────────────────────────────────────────────
function intoSets(items) {
  items.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
  const sets = [];
  const open = new Map();                       // one open set per chat+sender
  for (const it of items) {
    const key = (it.chat || '') + '|' + (it.sender || '');
    const cur = open.get(key);
    // Photos straight off the phone carry no sender, so a whole day in one chat
    // would otherwise become a single PDF of a hundred photos from a dozen
    // customers. Those get a tighter gap and a size cap.
    const gap = it.sender ? GAP : Math.min(GAP, 10 * 60000);
    const sameRun = cur
      && cur.files.length < MAX_SET
      && isoDate(cur.files[cur.files.length - 1].at) === isoDate(it.at)
      && it.at - cur.files[cur.files.length - 1].at <= gap;
    if (sameRun) { cur.files.push(it); continue; }
    const fresh = { at: it.at, sender: it.sender, chat: it.chat, files: [it] };
    sets.push(fresh);
    open.set(key, fresh);
  }
  return sets;
}

const digitsOf = s => {
  const d = String(s || '').replace(/[^\d]/g, '');
  return d.length >= 8 ? d : '';
};
const safe = s => String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

// ── finding the folders by itself ──────────────────────────────────────────
// With no folders given, look where the files normally end up: Desktop,
// Downloads, Documents, this folder, and one level inside each of those.
const WA_PHOTO = /^(IMG|VID|PHOTO)[-_]\d{8}[-_]WA\d+/i;
function looksLikePhotoFolder(dir) {
  try { return fs.readdirSync(dir).some(f => WA_PHOTO.test(f) || /^\d{8}-PHOTO-/i.test(f)); } catch { return false; }
}
function looksLikeChatExport(file) {
  try { return LINE.test(fs.readFileSync(file, 'utf8').replace(INVISIBLE, '').split(/\r?\n/).slice(0, 40).find(l => LINE.test(l)) || ''); } catch { return false; }
}
/** Google Drive for Desktop mounts as a drive letter holding "My Drive". */
function driveForDesktopRoots() {
  const out = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  for (const d of ['Google Drive', 'My Drive', 'Google Drive/My Drive']) out.push(path.join(home, d));
  for (const letter of 'GHIJKLDEF') {
    out.push(`${letter}:\\My Drive`);
    out.push(`${letter}:\\Shared drives`);
  }
  return out.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

function autoFind() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const roots = [__dirname, ...['Desktop', 'Downloads', 'Documents', 'OneDrive/Desktop', 'OneDrive/Documents']
    .map(d => path.join(home, d)), ...driveForDesktopRoots()]
    .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  const found = new Set();
  const look = (dir, depth) => {
    if (depth > 3 || found.size > 40) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.isFile() && (WA_PHOTO.test(e.name) || /^\d{8}-PHOTO-/i.test(e.name)))) { found.add(dir); return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!/^(node_modules|\.|inbox|merged|logs|baileys_auth)/i.test(e.name)) look(path.join(dir, e.name), depth + 1); continue; }
      if (/\.txt$/i.test(e.name) && /chat/i.test(e.name) && looksLikeChatExport(path.join(dir, e.name))) found.add(dir);
      if (/\.zip$/i.test(e.name) && /whatsapp|chat/i.test(e.name)) found.add(dir);
    }
  };
  roots.forEach(r => look(r, 0));
  return [...found];
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  if (!folders.length) {
    console.log('No folder given, so I will look for the photos and chat exports myself.');
    console.log('(Run "node backfill.js --help" to see all the options.)\n');
    const guessed = autoFind();
    if (!guessed.length) {
      console.log('Nothing found. Put the photos and the exported chats on the Desktop, in Downloads or in Documents, then run this again. What to copy:\n');
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
      process.exit(1);
    }
    guessed.forEach(g => console.log('  using ' + g));
    console.log('');
    folders.push(...guessed);
  }
  if (has('help')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
    process.exit(0);
  }
  if (OCR) {
    vehicle.setFast(!FULL_OCR);
    vehicle.setPool(OCR_PARALLEL);
    if (!FULL_OCR) console.log(`Reading vehicle numbers ${OCR_PARALLEL} photos at a time, up to ${OCR_PHOTOS} per set, stopping at the first number found.`);
  }
  let done = {};
  try { done = JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')); } catch {}

  // --redo / --undo: remove what an earlier backfill made, so it can be rebuilt.
  // Only what THIS tool created is touched: the list of files it wrote, and the
  // register rows it marked as its own. PDFs from the live bot are left alone.
  if (has('redo') || has('undo')) {
    const files = Object.values(done).filter(f => typeof f === 'string');
    let gone = 0;
    for (const f of files) { try { if (fs.existsSync(f)) { fs.unlinkSync(f); gone++; } } catch {} }
    let rows = [], kept = [], months = new Set();
    try { rows = register.readAll(); } catch {}
    for (const r of rows) { if (r && r.source === 'backfill') months.add(String(r.date || '').slice(0, 7)); else kept.push(r); }
    if (rows.length !== kept.length) {
      try {
        fs.writeFileSync(register.JSONL(), kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
        for (const ym of months) { if (ym) await register.rebuildMonth(ym).catch(() => {}); }
      } catch (e) { console.log('  could not tidy the register: ' + e.message); }
    }
    try { fs.unlinkSync(DONE_FILE); } catch {}
    done = {};
    // drop any now-empty day folders left behind
    const prune = (dir, depth) => {
      if (depth > 3) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) if (e.isDirectory()) prune(path.join(dir, e.name), depth + 1);
      try { if (!fs.readdirSync(dir).length && dir !== org.MERGED_ROOT) fs.rmdirSync(dir); } catch {}
    };
    prune(org.MERGED_ROOT, 0);
    console.log(`Removed ${gone} PDF(s) made by an earlier backfill and ${rows.length - kept.length} register row(s).`);
    if (has('undo')) { console.log('Nothing else done (--undo).'); return; }
    console.log('');
  }

  // Unpack any WhatsApp export zips so nobody has to right-click anything.
  const unpacked = [];
  for (const f of [...folders]) {
    const p = path.resolve(f);
    const zips = /\.zip$/i.test(p) ? [p]
      : (fs.existsSync(p) && fs.statSync(p).isDirectory()
        ? fs.readdirSync(p).filter(n => /\.zip$/i.test(n)).map(n => path.join(p, n))
        : []);
    for (const zip of zips) {
      const out = zip.replace(/\.zip$/i, '');
      if (fs.existsSync(out) && fs.readdirSync(out).length) { unpacked.push(out); continue; }
      process.stdout.write(`unpacking ${path.basename(zip)} ... `);
      const r = process.platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${out.replace(/'/g, "''")}' -Force`], { stdio: 'pipe' })
        : spawnSync('unzip', ['-o', '-q', zip, '-d', out], { stdio: 'pipe' });
      if (r.status === 0 && fs.existsSync(out)) { console.log('done'); unpacked.push(out); }
      else console.log('could not unpack it; right-click the zip in Windows and choose "Extract All"');
    }
  }
  folders.push(...unpacked);

  for (const f of folders) {
    const dir = path.resolve(f);
    if (!fs.existsSync(dir) || /\.zip$/i.test(dir)) continue;
    scan(dir);
  }
  console.log(`${photoIndex.size} photo(s) and ${chatFiles.length} exported chat(s) found`);

  const all = [];
  let groupsSkipped = 0, ignored = 0;
  for (const txt of chatFiles) {
    let c;
    try { c = readChat(txt); } catch (e) { console.log(`  could not read ${path.basename(txt)}: ${e.message}`); continue; }
    if (!c.items.length) continue;
    // skipped chats stay "claimed" so their photos are left out altogether,
    // rather than coming back in as loose photos with no sender
    if (ONLY_NUMBERS && c.isGroup) { groupsSkipped++; continue; }
    const why = ignore.isIgnored({ group: c.title, sender: digitsOf(c.title) });
    if (why) { ignored += c.items.length; console.log(`  ${c.title}: skipped, ${why}`); continue; }
    console.log(`  ${c.title}: ${c.items.length} photo(s)${c.isGroup ? '  (group)' : ''}`);
    all.push(...c.items);
  }
  const loose = unclaimedPhotos();
  if (loose.length) console.log(`  ${loose.length} photo(s) with no chat file: grouped by date, named by vehicle number`);
  all.push(...loose);
  if (groupsSkipped) console.log(`  ${groupsSkipped} group chat(s) skipped (--only-numbers)`);
  if (ignored) console.log(`  ${ignored} photo(s) skipped by ignore-list.txt`);

  const kept = all
    .filter(i => i.at >= SINCE && i.at <= UNTIL)
    .filter(i => !ignore.isIgnored({ group: i.sender, sender: digitsOf(i.sender) }));
  console.log(`\n${kept.length} photo(s) between ${isoDate(SINCE)} and ${isoDate(UNTIL)}`);

  const allSets = intoSets(kept);
  const sets = allSets.filter(s => s.files.length >= MIN);
  console.log(`${sets.length} set(s) of ${MIN}+ photos` + (allSets.length - sets.length ? `, ${allSets.length - sets.length} smaller set(s) left alone` : '') + (DRY ? '   [dry run, nothing written]' : '') + '\n');

  let made = 0, already = 0, failed = 0;
  for (const [i, s] of sets.entries()) {
    const date = isoDate(s.at);
    const key = `${date}|${s.chat || ''}|${s.sender || 'phone'}|${path.basename(s.files[0].file)}|${s.files.length}`;

    // --rename: the PDFs are already built. Look again only at the ones whose
    // name has no vehicle number in it, read them with the current reader, and
    // rename the file and its register row. No merging, no rebuilding.
    if (RENAME) {
      const existing = done[key];
      if (!existing || !fs.existsSync(existing)) { continue; }
      if (!/^[A-Z]{2}[0-9]/.test(path.basename(existing))) {
        renameTried++;
        let found = null;
        for (let k = 0; k < Math.min(s.files.length, OCR_PHOTOS) && !found; k += OCR_PARALLEL) {
          const chunk = s.files.slice(k, k + OCR_PARALLEL);
          const got = await Promise.all(chunk.map(f => vehicle.readOne(f.file).catch(() => null)));
          try { const d = vehicle.decide(got.filter(Boolean)); found = (d && d.number) || null; } catch {}
        }
        if (found) {
          const who2 = safe(s.sender || s.chat);
          const stem2 = [safe(found), who2, date].filter(Boolean).join('_');
          let nf = `${stem2}.pdf`;
          if (org.archiveExists(nf, s.at)) nf = `${stem2}_${pad(s.at.getHours())}${pad(s.at.getMinutes())}.pdf`;
          for (let k = 2; org.archiveExists(nf, s.at); k++) nf = `${stem2}_${pad(s.at.getHours())}${pad(s.at.getMinutes())}_${k}.pdf`;
          const target = path.join(path.dirname(existing), nf);
          try {
            fs.renameSync(existing, target);
            done[key] = target;
            fs.writeFileSync(DONE_FILE, JSON.stringify(done));
            renamedRows.push({ from: existing, to: target, vehicle: found, date });
            renamed++;
            console.log(`  ${path.basename(existing)}  ->  ${nf}`);
          } catch (e) { console.log(`  could not rename ${path.basename(existing)}: ${e.message}`); }
        }
      }
      continue;
    }
    if (done[key]) { already++; continue; }
    const whoFor = s.sender || s.chat || 'from the phone';
    const head = `[${i + 1}/${sets.length}] ${date} ${whoFor} - ${s.files.length} photos`;

    let veh = null;
    if (OCR) {
      // Read a few photos at once and stop the moment one gives a full number.
      // Reading every photo of every set is what made this take all night.
      const reads = [];
      const candidates = s.files.slice(0, OCR_PHOTOS);
      for (let k = 0; k < candidates.length; k += OCR_PARALLEL) {
        const chunk = candidates.slice(k, k + OCR_PARALLEL);
        const got = await Promise.all(chunk.map(f => vehicle.readOne(f.file).catch(() => null)));
        reads.push(...got.filter(Boolean));
        if (got.some(r => r && r.tally && r.tally.size)) break;
      }
      try { const d = vehicle.decide(reads); veh = (d && (d.number || d.partial)) || null; } catch {}
    }
    const hhmm = `${pad(s.at.getHours())}${pad(s.at.getMinutes())}`;
    const who = safe(s.sender || s.chat);
    const stem = [veh && safe(veh), who || (veh ? '' : 'Photos'), date].filter(Boolean).join('_');
    let fname = `${stem}.pdf`;
    if (org.archiveExists(fname, s.at)) fname = `${stem}_${hhmm}.pdf`;
    for (let k = 2; org.archiveExists(fname, s.at); k++) fname = `${stem}_${hhmm}_${k}.pdf`;

    if (DRY) { console.log(`${head}  ->  ${fname}${veh ? '' : '   (no vehicle number read)'}`); made++; continue; }
    try {
      const { bytes, pages } = await mergeFilesToPdf(s.files.map(f => f.file), {
        label: whoFor,
        title: `${veh ? veh + ' - ' : ''}${whoFor} ${date}`.trim(),
        cover: {
          vehicle: veh || '', from: s.sender || '', number: digitsOf(s.chat) || digitsOf(s.sender) || '',
          group: s.chat && s.chat !== s.sender ? s.chat : '', received: s.at.toLocaleString('en-IN'),
          agent: process.env.AGENT_NAME || '',
        },
      });
      const archived = org.archiveMerged(fname, Buffer.from(bytes), s.at);
      await register.add({
        date, time: `${pad(s.at.getHours())}:${pad(s.at.getMinutes())}`, vehicle: veh || '',
        sender: s.sender || '', number: digitsOf(s.chat) || digitsOf(s.sender) || '', group: '',
        photos: s.files.length, pdfs: 0, pages, file: archived, emailed: [],
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

  if (RENAME) {
    if (renamedRows.length) {
      try {
        const rows = register.readAll();
        const byFile = new Map(renamedRows.map(r => [r.from, r]));
        const months = new Set();
        let touched = 0;
        for (const row of rows) {
          const hit = byFile.get(row.file);
          if (!hit) continue;
          row.file = hit.to; row.vehicle = hit.vehicle; months.add(String(row.date).slice(0, 7)); touched++;
        }
        if (touched) {
          fs.writeFileSync(register.JSONL(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
          for (const ym of months) await register.rebuildMonth(ym).catch(() => {});
          console.log(`\nThe register was updated for ${touched} of them.`);
        }
      } catch (e) { console.log('Could not update the register: ' + e.message); }
    }
    console.log(`\nDone. ${renameTried} PDF(s) had no vehicle number; ${renamed} now do.`);
    console.log(`The other ${renameTried - renamed} stay as they are: nothing readable in those photos.`);
    return;
  }

  console.log(`\nDone. ${made} PDF(s) made, ${already} already there, ${failed} failed.`);
  console.log(`They are in ${org.MERGED_ROOT}, filed by year, month and day, with a row each in the monthly Excel register.`);
})().catch(e => { console.error('Backfill failed: ' + e.message); process.exit(1); });
