/**
 * Finds an Indian vehicle registration number in photos using local OCR
 * (tesseract.js, runs on this computer, no internet after the first run when
 * it downloads its English data once). Returns e.g. "AP26AB1234" or null.
 */
const path = require('path');
const fs = require('fs');

// AP26 AB 1234 · TS09EA5678 · KA01 M 1234 · DL 1C AB 1234 · 22BH1234AA (Bharat series)
const REG_RE = /\b([A-Z]{2})[\s\-.]*(\d{1,2})[\s\-.]*([A-Z]{1,3})[\s\-.]*(\d{4})\b|\b(\d{2})[\s\-.]*(BH)[\s\-.]*(\d{4})[\s\-.]*([A-Z]{1,2})\b/g;
const STATE_CODES = new Set(('AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS UK UP WB').split(' '));

// Common OCR confusions inside the digit groups
const fixDigits = s => s.replace(/O/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
const fixLetters = s => s.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B').replace(/2/g, 'Z');

// Partial fallback: series letters + last four digits (e.g. "AB 1234" -> AB1234),
// or a state-code prefix with unreadable middle and readable last four ("AP26 ?? 1234" -> 1234).
const PARTIAL_RE = /\b([A-Z]{1,3})[\s\-.]*(\d{4})\b/g;
const TAIL_RE = /\b[A-Z]{2}[\s\-.]*\d{2}[\s\-.]*\S{0,4}[\s\-.]*(\d{4})\b/g;
const NOT_SERIES = new Set(['NO', 'RC', 'CC', 'KG', 'KW', 'DT', 'RTO', 'MFG', 'DOB', 'PIN', 'REG', 'REGN']);
function extractPartials(text) {
  const found = new Map();
  const t = text.toUpperCase();
  let m;
  while ((m = PARTIAL_RE.exec(t))) {
    const series = fixLetters(m[1]); const digits = fixDigits(m[2]);
    if (NOT_SERIES.has(series) || /^(19|20)\d\d$/.test(digits)) continue;   // skip years
    const key = series + digits;
    found.set(key, (found.get(key) || 0) + 1);
  }
  while ((m = TAIL_RE.exec(t))) {
    const digits = fixDigits(m[1]);
    if (/^(19|20)\d\d$/.test(digits)) continue;
    found.set(digits, (found.get(digits) || 0) + 1);
  }
  return found;
}

function extractNumbers(text) {
  const found = new Map();
  const t = text.toUpperCase();
  let m;
  while ((m = REG_RE.exec(t))) {
    let key;
    if (m[6] === 'BH') key = `${fixDigits(m[5])}BH${fixDigits(m[7])}${fixLetters(m[8])}`;
    else {
      const st = fixLetters(m[1]);
      if (!STATE_CODES.has(st)) continue;
      key = `${st}${fixDigits(m[2]).padStart(2, '0')}${fixLetters(m[3])}${fixDigits(m[4])}`;
    }
    found.set(key, (found.get(key) || 0) + 1);
  }
  return found;
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' timed out after ' + Math.round(ms / 1000) + 's')), ms); }),
  ]);
}

let workerPromise = null;
let tmpSeq = 0;
// Fast mode: two looks at a photo instead of four, and shorter timeouts. For
// the backfill, where thousands of photos make a seventy-second read per photo
// impossible. The picture itself is prepared exactly as before, so a number
// that could be read still is.
let fastMode = false;
function setFast(v) { fastMode = !!v; }
let poolSize = 1, pool = [], poolIdx = 0;
/** Read this many photos at the same time, one reader each. */
function setPool(n) { poolSize = Math.max(1, Math.min(8, parseInt(n, 10) || 1)); }      // keeps two photos in the same millisecond from sharing a temp name
async function getWorker() {
  if (poolSize > 1) {
    while (pool.length < poolSize) pool.push(newWorker());
    return pool[poolIdx++ % pool.length];
  }
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    const cache = path.resolve(__dirname, '..', '.tessdata');
    fs.mkdirSync(cache, { recursive: true });
    const firstTime = !fs.readdirSync(cache).some(f => f.startsWith('eng'));
    if (firstTime) console.log('[ocr] first run: downloading English reading data (about 4 MB)...');
    const p = createWorker('eng', 1, {
      cachePath: cache, logger: () => {},
      errorHandler: (e) => {
        const msg = (e && e.message) || String(e || '');
        // tesseract calls this for an unreadable image too, not just a broken
        // worker. Dropping the worker then leaked its memory (~57 MB a time).
        if (/attempting to read image|Image format|Error in pixReadMem/i.test(msg)) {
          console.error('[ocr] could not read that image: ' + msg);
          return;
        }
        console.error('[ocr] worker error: ' + msg);
        const dying = workerPromise;
        workerPromise = null;
        Promise.resolve(dying).then(w => w && w.terminate && w.terminate()).catch(() => {});
      },
    });
    workerPromise = withTimeout(p, 120000, 'OCR start-up').then(async w => {
      if (firstTime) console.log('[ocr] reading data ready');
      if (fastMode) {
        try {
          await w.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -',
            tessedit_pageseg_mode: '11',          // sparse text: much quicker than a full page
          });
        } catch {}
      }
      return w;
    }).catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

/** Call at startup so a download problem shows up immediately, not on the first PDF. */
async function warmUp() {
  try { await getWorker(); console.log('[ocr] vehicle-number reader ready'); }
  catch (e) { console.error('[ocr] reader not available: ' + e.message + ' (PDFs will be named by sender until this works)'); }
}

// Recognise with a timeout so a stuck worker cannot hold the merge forever.
function recognize(worker, file, ms = 30000) {
  return Promise.race([
    worker.recognize(file),
    new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timeout')), ms)),
  ]);
}

// Clean-up variants of a photo for OCR: EXIF-straightened, grayscale, enlarged,
// normalised, sharpened; plus 90/270 rotations for sideways photos.
async function variants(file) {
  let sharp; try { sharp = require('sharp'); } catch { return [file]; }
  const out = [];
  try {
    const base = sharp(file).rotate().grayscale().normalise();
    const meta = await sharp(file).rotate().metadata();
    const width = fastMode
      ? Math.min(Math.max(meta.width || 0, 900), 1100)
      : Math.min(Math.max(meta.width || 0, 1200), 1600);   // big enough to read, small enough to be quick
    const tmp = path.join(require('os').tmpdir(), 'ocr-' + process.pid + '-' + (++tmpSeq) + '-' + Date.now());
    const clean = tmp + '-a.png';
    await base.clone().resize({ width, withoutEnlargement: false }).sharpen().toFile(clean);
    out.push(clean);
    if (fastMode) return out;          // one look only
    const thresh = tmp + '-b.png';
    await base.clone().resize({ width }).threshold(150).toFile(thresh);
    out.push(thresh);
    for (const angle of [90, 270]) {
      const r = tmp + '-r' + angle + '.png';
      await base.clone().resize({ width }).sharpen().rotate(angle).toFile(r);
      out.push(r);
    }
  } catch (e) { /* fall back to the original */ }
  return out.length ? out : [file];
}

/**
 * Read ONE photo. Returns { tally: Map(fullNumber->count), partial: Map(partial->count) }.
 * Called as soon as a photo arrives so the work overlaps the 45 s collection wait.
 */
async function readOne(file, opts = {}) {
  const tally = new Map(), partial = new Map();
  let fullText = '';
  if (!/\.(jpe?g|png)$/i.test(file)) return { tally, partial, text: '' };
  try { if (fs.statSync(file).size < 1500) return { tally, partial, text: '' }; } catch { return { tally, partial, text: '' }; }
  const started = Date.now();
  const deadline = started + (opts.budgetMs || (fastMode ? 12000 : 60000));
  const worker = await getWorker();
  const imgs = await variants(file);
  for (const img of imgs) {
    try {
      const { data } = await recognize(worker, img, fastMode ? 9000 : 40000);
      const text = data.text || '';
      if (text.length > fullText.length) fullText = text;
      for (const [k, v] of extractNumbers(text)) tally.set(k, (tally.get(k) || 0) + v);
      for (const [k, v] of extractPartials(text)) partial.set(k, (partial.get(k) || 0) + v);
    } catch (e) {
      console.error(`[ocr] ${path.basename(file)}: ${e.message}`);
      if (/timed? ?out/.test(e.message)) break;          // keep the worker; just move on
    } finally { if (img !== file) { try { fs.unlinkSync(img); } catch {} } }
    if (tally.size || Date.now() > deadline) break;
  }
  // remove the temp variants we did not get to
  for (const img of imgs) if (img !== file) { try { fs.unlinkSync(img); } catch {} }
  console.log(`[ocr] ${path.basename(file)}: ${tally.size ? 'found ' + [...tally.keys()].join('/') : partial.size ? 'partial ' + [...partial.keys()].slice(0, 3).join('/') : 'nothing'} (${Math.round((Date.now() - started) / 1000)}s)`);
  return { tally, partial, text: fullText };
}

/** Combine per-photo results into a decision: { number, partial }. */
function decide(results) {
  const tally = new Map(), partial = new Map();
  for (const r of results) {
    if (!r) continue;
    for (const [k, v] of r.tally) tally.set(k, (tally.get(k) || 0) + v);
    for (const [k, v] of r.partial) partial.set(k, (partial.get(k) || 0) + v);
  }
  const best = m => { let b = null, n = 0; for (const [k, v] of m) if (v > n) { b = k; n = v; } return b; };
  const number = best(tally);
  let part = null;
  if (!number && partial.size) {
    const scored = [...partial].map(([k, v]) => {
      const digits = k.slice(-4);
      let support = 0;
      for (const [k2, v2] of partial) if (k2 !== k && k2.slice(-4) === digits) support += v2;
      return [k, v + support, /^[A-Z]/.test(k) ? 1 : 0];
    }).sort((a, b) => b[1] - a[1] || b[2] - a[2]);
    if (scored.length === 1 || scored[0][1] > scored[1][1]) part = scored[0][0];
  }
  return { number, partial: part, candidates: { ...Object.fromEntries(tally), ...Object.fromEntries(partial) } };
}

/** Convenience: read several photos now (used by the test). */
async function findVehicleNumber(imageFiles, opts = {}) {
  const files = imageFiles.filter(f => /\.(jpe?g|png)$/i.test(f)).slice(0, opts.maxImages || 8);
  const results = [];
  for (const f of files) results.push(await readOne(f, opts));
  return decide(results);
}

/** One more reader for the pool, built like the single one. */
function newWorker() {
  const { createWorker } = require('tesseract.js');
  const cache = path.resolve(__dirname, '..', '.tessdata');
  fs.mkdirSync(cache, { recursive: true });
  return withTimeout(createWorker('eng', 1, { cachePath: cache, logger: () => {}, errorHandler: () => {} }), 120000, 'OCR start-up');
}

async function close() {
  if (workerPromise) { try { (await workerPromise).terminate(); } catch {} workerPromise = null; }
  const old = pool; pool = []; poolIdx = 0;
  for (const w of old) { try { (await w).terminate(); } catch {} }
}

module.exports = { readOne, decide, findVehicleNumber, extractNumbers, extractPartials, warmUp, close, setFast, setPool };
