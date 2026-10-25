/**
 * Which reader does the actual looking at a photo.
 *
 *   paddle  - PaddleOCR v4 models run through onnxruntime (@gutenye/ocr-node).
 *             Far better on phone photos and about five times quicker. Needs
 *             one install: node ocr-upgrade.js
 *   tesseract - the built-in reader (tesseract.js). Always there, slower, and
 *             needs the picture cleaned up first to stand a chance.
 *
 * Nothing here knows about vehicle numbers: it returns text, and lib/vehicle.js
 * decides what the text means.
 */
const fs = require('fs');
const path = require('path');

let engine = null;        // 'paddle' | 'tesseract'
let paddle = null;        // the loaded reader
let paddleFailed = false;

function modelsDir() {
  try {
    const pkg = require.resolve('@gutenye/ocr-node');
    const root = pkg.slice(0, pkg.lastIndexOf('node_modules') + 'node_modules'.length);
    const dir = path.join(root, '@gutenye', 'ocr-models', 'assets');
    return fs.existsSync(dir) ? dir : null;
  } catch { return null; }
}

/** Is the better reader installed? */
function paddleAvailable() {
  const want = (process.env.OCR_ENGINE || 'auto').toLowerCase();
  if (want === 'tesseract') return false;          // forced in .env
  if (paddleFailed) return false;
  try { require.resolve('@gutenye/ocr-node'); } catch { return false; }
  return !!modelsDir();
}

async function loadPaddle() {
  if (paddle) return paddle;
  const A = modelsDir();
  const Ocr = (await import('@gutenye/ocr-node')).default;
  paddle = await Ocr.create({
    models: {
      detectionPath: path.join(A, 'ch_PP-OCRv4_det_infer.onnx'),
      recognitionPath: path.join(A, 'ch_PP-OCRv4_rec_infer.onnx'),
      dictionaryPath: path.join(A, 'ppocr_keys_v1.txt'),
    },
  });
  return paddle;
}

/**
 * Should the other reader go FIRST? Measured on real photos, the built-in one
 * is two to four times quicker when it succeeds, so it leads and this one is
 * the second opinion. OCR_ENGINE=paddle swaps that round.
 */
function paddleFirst() {
  return (process.env.OCR_ENGINE || 'auto').toLowerCase() === 'paddle' && paddleAvailable();
}

/** Which reader leads, without loading anything. */
function name() {
  if (paddleFirst()) return 'paddle';
  return paddleAvailable() ? 'tesseract (with paddle as second opinion)' : 'tesseract';
}

/**
 * Read a photo.
 * @returns {Promise<{text:string, engine:string}|null>} null if this reader cannot be used
 */
const MAX_WIDTH = parseInt(process.env.OCR_MAX_WIDTH || '1300', 10);

/** A phone photo is far bigger than the reader needs. Shrinking it first is
 *  the difference between one second and fifteen, with the same answer. */
async function shrink(file) {
  try {
    const sharp = require('sharp');
    const meta = await sharp(file).metadata();
    if ((meta.width || 0) <= MAX_WIDTH) return { file, tmp: null };
    const tmp = path.join(require('os').tmpdir(), 'ocr-in-' + process.pid + '-' + (++seq) + '.jpg');
    await sharp(file).rotate().resize({ width: MAX_WIDTH, withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(tmp);
    return { file: tmp, tmp };
  } catch { return { file, tmp: null }; }
}
let seq = 0;

async function readText(file, timeoutMs = 20000) {
  if (!paddleAvailable()) return null;
  let small = { file, tmp: null };
  try {
    const ocr = await loadPaddle();
    small = await shrink(file);
    const res = await Promise.race([
      ocr.detect(small.file),
      new Promise((_, rej) => setTimeout(() => rej(new Error('reader timed out')), timeoutMs)),
    ]);
    const lines = (res && res.texts) || [];
    engine = 'paddle';
    return { text: lines.map(t => t.text).join('\n'), engine: 'paddle' };
  } catch (e) {
    console.error('[ocr] the faster reader failed (' + e.message + '); using the built-in one from now on');
    paddleFailed = true;
    paddle = null;
    return null;
  } finally {
    if (small.tmp) { try { fs.unlinkSync(small.tmp); } catch {} }
  }
}

module.exports = { readText, paddleAvailable, paddleFirst, name };
