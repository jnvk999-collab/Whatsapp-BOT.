/**
 * Collects photos and PDFs per chat and merges them into one A4 PDF with a
 * cover page.
 *
 * WhatsApp delivers a burst of files as separate messages, so we buffer them
 * per sender and flush when the burst goes quiet (MERGE_WAIT_SECONDS) or when
 * the sender says "pdf". JPEG/PNG become one page each; PDFs are appended
 * page by page; anything else is listed as skipped on the cover.
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 24;

// Helvetica only knows Latin characters; keep the cover page from crashing on Telugu/Hindi names.
const latin = s => String(s || '').replace(/[^\x20-\x7E -ÿ]/g, '?');

function drawCover(pdf, font, bold, info, items, skipped) {
  const page = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - 80;
  const line = (text, size = 11, f = font, color = rgb(0.1, 0.1, 0.1)) => {
    page.drawText(latin(text), { x: 50, y, size, font: f, color });
    y -= size + 8;
  };
  line(info.title || 'Documents received on WhatsApp', 20, bold, rgb(0.15, 0.25, 0.56));
  y -= 6;
  page.drawLine({ start: { x: 50, y: y + 6 }, end: { x: A4.w - 50, y: y + 6 }, thickness: 1, color: rgb(0.7, 0.75, 0.85) });
  y -= 10;
  if (info.vehicle)  line(`Vehicle:   ${info.vehicle}`, 14, bold);
  if (info.from)     line(`From:      ${info.from}`);
  if (info.number)   line(`Number:    ${info.number}`);
  if (info.group)    line(`Group:     ${info.group}`);
  if (info.received) line(`Received:  ${info.received}`);
  if (info.agent)    line(`Agent:     ${info.agent}`);
  y -= 8;
  line(`Contents (${items.length} item${items.length === 1 ? '' : 's'}):`, 12, bold);
  items.forEach((it, i) => line(`${String(i + 1).padStart(2, ' ')}. ${it.kind}  ${it.name}${it.pages > 1 ? `  (${it.pages} pages)` : ''}${it.caption ? `  - "${it.caption}"` : ''}`, 10));
  if (skipped.length) {
    y -= 6;
    line(`Skipped (not an image or PDF): ${skipped.join(', ')}`, 10, font, rgb(0.6, 0.2, 0.2));
  }
  page.drawText(latin(`Generated ${new Date().toLocaleString('en-IN')}`), { x: 50, y: 30, size: 8, font, color: rgb(0.5, 0.5, 0.5) });
}

/**
 * @param {Array<string|{path:string, caption?:string}>} files
 * @param {{label?:string, title?:string, cover?:object}} opts
 *   cover: { title, from, number, group, received, agent } -> draws a cover page
 */
async function mergeFilesToPdf(files, opts = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const skipped = [];
  const items = [];
  const pagesToAdd = [];   // deferred so the cover can go first

  for (const f of files) {
    const file = typeof f === 'string' ? f : f.path;
    const caption = typeof f === 'string' ? '' : (f.caption || '');
    const name = path.basename(file);
    const bytes = fs.readFileSync(file);
    const isPdf = /\.pdf$/i.test(file) || bytes.slice(0, 5).toString() === '%PDF-';
    if (isPdf) {
      try {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const copied = await pdf.copyPages(src, src.getPageIndices());
        pagesToAdd.push({ kind: 'pdf', pages: copied });
        items.push({ kind: 'PDF', name, pages: copied.length, caption });
      } catch (e) { skipped.push(name); }
      continue;
    }
    let img;
    try {
      if (/\.png$/i.test(file) || bytes.slice(0, 8).toString('hex') === '89504e470d0a1a0a') img = await pdf.embedPng(bytes);
      else img = await pdf.embedJpg(bytes);
    } catch (e) {
      // Some cameras and apps write JPEGs the PDF library refuses ("SOI not
      // found"). Re-save the picture once and try again, rather than quietly
      // leaving it out of the PDF.
      try {
        const sharp = require('sharp');
        const redone = await sharp(bytes).rotate().jpeg({ quality: 88 }).toBuffer();
        img = await pdf.embedJpg(redone);
        console.log(`[pdf] ${name} needed re-saving before it could be added`);
      } catch (e2) { skipped.push(name); continue; }
    }
    pagesToAdd.push({ kind: 'image', img });
    items.push({ kind: 'Photo', name, pages: 1, caption });
  }

  const label = latin(opts.label || '');
  if (opts.cover) drawCover(pdf, font, bold, opts.cover, items, skipped);

  let n = 0;
  const total = pagesToAdd.reduce((s, p) => s + (p.kind === 'pdf' ? p.pages.length : 1), 0);
  for (const p of pagesToAdd) {
    if (p.kind === 'pdf') { for (const pg of p.pages) { pdf.addPage(pg); n++; } continue; }
    const page = pdf.addPage([A4.w, A4.h]);
    const maxW = A4.w - 2 * MARGIN, maxH = A4.h - 2 * MARGIN - 14;
    const s = Math.min(maxW / p.img.width, maxH / p.img.height);
    const w = p.img.width * s, h = p.img.height * s;
    page.drawImage(p.img, { x: (A4.w - w) / 2, y: (A4.h - h) / 2 + 7, width: w, height: h });
    n++;
    page.drawText(`${label}  -  ${n}/${total}`.trim(), { x: MARGIN, y: 8, size: 8, font, color: rgb(0.45, 0.45, 0.45) });
  }
  if (opts.title) pdf.setTitle(latin(opts.title));
  return { bytes: await pdf.save(), pages: n, items, skipped };
}

/**
 * Per-chat buffer with a quiet-period timer.
 * Files carry the time they were sent (`sentAt`). If a new file was sent more
 * than the wait period after the previous one, the previous batch is closed
 * first, so photos received while the bot was offline are grouped the way
 * they were sent, not all lumped together on catch-up.
 */
class PhotoBatcher {
  constructor({ waitSeconds = 45, onFlush }) {
    this.wait = waitSeconds * 1000;
    this.onFlush = onFlush;
    this.buffers = new Map();   // chatId -> { files:[], timer, lastSentAt }
  }
  async add(chatId, file) {
    const sentAt = file.sentAt ? +file.sentAt : Date.now();
    let b = this.buffers.get(chatId);
    if (b && b.lastSentAt && sentAt - b.lastSentAt > this.wait) { await this.flush(chatId); b = null; }
    if (!b) { b = { files: [], timer: null, lastSentAt: 0 }; this.buffers.set(chatId, b); }
    b.files.push(file);
    b.lastSentAt = Math.max(b.lastSentAt, sentAt);
    if (b.timer) clearTimeout(b.timer);
    // Old messages (a catch-up after being offline) do not need the full wait,
    // but the window must still outlast the time it takes to download and save
    // the NEXT photo, or a burst is split into single files and each one is then
    // dropped for being below the minimum. 30s, measured from now, not from when
    // the photo was sent.
    const age = Date.now() - sentAt;
    b.timer = setTimeout(() => this.flush(chatId), age > this.wait ? Math.min(30000, this.wait) : this.wait);
    return b.files.length;
  }
  async flush(chatId) {
    const b = this.buffers.get(chatId);
    if (!b || !b.files.length) return null;
    this.buffers.delete(chatId);
    if (b.timer) clearTimeout(b.timer);
    return this.onFlush(chatId, b.files);
  }
  pending(chatId) { const b = this.buffers.get(chatId); return b ? b.files.length : 0; }
  async flushAll() { for (const id of [...this.buffers.keys()]) { try { await this.flush(id); } catch {} } }
}

module.exports = { mergeFilesToPdf, mergeImagesToPdf: mergeFilesToPdf, PhotoBatcher };
