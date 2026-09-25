/**
 * Dispatch: send a policy/quote PDF back to whoever sent that vehicle's photos.
 *
 * Sources of PDFs:
 *   - a folder watched on this computer (outbox/ inside the bot folder, and
 *     your Downloads folder when WATCH_DOWNLOADS=1)
 *   - a PDF you forward into your own WhatsApp chat from the phone
 *
 * Flow: read the vehicle number from the PDF text (or file name) -> look up
 * the register -> propose the recipient(s) in your own chat -> you reply
 * 1 / 2 / no. With DISPATCH_AUTO=1 it sends to the private sender without asking.
 */
const fs = require('fs');
const path = require('path');
const register = require('./register');
const { extractNumbers } = require('./vehicle');
const policy = require('./policy');

const pending = new Map();      // token -> { file, vehicle, row, options:[{label,jid}], createdAt }
let seq = 0;

/** Is this PDF an actual policy document (not a quote / RC / anything else)? */
async function inspect(file) {
  let text = '';
  try { text = await policy.textOf(file, 3); } catch {}
  const info = policy.parse(text);
  const name = path.basename(file);
  const looksLikeQuote = /quote|quotation|proposal form|premium calc/i.test(name) || /\bQUOTATION\b|\bQuote\b.*\bIndicative\b|Indicative quote/i.test(text);
  // a scanned policy has no readable text, so trust a file name that says so
  const nameSaysPolicy = /policy[ _-]*(document|copy|schedule|certificate)|^policy[ _-]/i.test(name);
  const isPolicy = !looksLikeQuote && (
    !!(info.policyNo && (info.to || /period of insurance|policy period|certificate of insurance|policy schedule/i.test(text)))
    || (nameSaysPolicy && text.replace(/\s/g, '').length < 200)   // name says policy and nothing readable inside
  );
  const found = extractNumbers(text + ' ' + name.replace(/[_\-.]/g, ' '));
  let best = null, n = 0; for (const [k, v] of found) if (v > n) { best = k; n = v; }
  return { vehicle: best, isPolicy, info, looksLikeQuote, textLength: text.replace(/\s/g, '').length };
}

async function vehicleFromPdf(file) {
  let text = '';
  try {
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
    for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      text += content.items.map(it => it.str).join(' ') + '\n';
    }
  } catch (e) { console.error('[dispatch] could not read text from ' + path.basename(file) + ': ' + e.message); }
  const found = extractNumbers(text + ' ' + path.basename(file).replace(/[_\-.]/g, ' '));
  let best = null, n = 0;
  for (const [k, v] of found) if (v > n) { best = k; n = v; }
  return best;
}

/** Build the proposal for one PDF. Returns { text, token } or { text } when nothing to do. */
function propose(file, vehicle, opts = {}) {
  const rows = vehicle ? register.search(vehicle) : [];
  if (!vehicle) return { text: `📄 ${path.basename(file)}: no vehicle number readable. Reply *to 8670* (vehicle last digits), *to 9876543210* (phone number) or *to <group name>*, or *no*.`, token: park(file, null, null, []) };
  if (!rows.length) return { text: `📄 ${path.basename(file)}: ${pretty(vehicle)} is not in the register yet. Reply *to 9876543210* (phone number) or *to <group name>* to send it, or *no*.`, token: park(file, vehicle, null, []) };
  const row = rows.find(r => r.chat) || rows[0];   // prefer an entry that knows where it came from
  const options = [];
  if (row.chat && row.chat.endsWith('@g.us')) {
    if (row.senderJid) options.push({ label: `${row.sender || row.number} privately`, jid: row.senderJid });
    options.push({ label: `group "${row.group}"`, jid: row.chat });
  } else if (row.chat) {
    options.push({ label: `${row.sender || row.number}`, jid: row.chat });
  }
  if (!options.length) return { text: `📄 ${path.basename(file)}: ${pretty(vehicle)} found (${row.sender}) but no chat saved for it (older entry). Reply *no*.`, token: park(file, vehicle, row, []) };
  const token = park(file, vehicle, row, options);
  const lines = [`📄 *${path.basename(file)}*  ->  ${pretty(vehicle)} (photos from ${row.sender || row.number} on ${row.date})`, 'Send to:'];
  options.forEach((o, i) => lines.push(`  *${i + 1}*  ${o.label}`));
  lines.push('Reply with the number, or *no*.');
  return { text: lines.join('\n'), token };
}

function park(file, vehicle, row, options) {
  const token = String(++seq);
  pending.set(token, { file, vehicle, row, options, createdAt: Date.now() });
  // keep only the latest few
  for (const k of [...pending.keys()].slice(0, -5)) pending.delete(k);
  return token;
}
function latest() { const k = [...pending.keys()].pop(); return k ? pending.get(k) : null; }
function clearLatest() { const k = [...pending.keys()].pop(); if (k) pending.delete(k); }

const pretty = r => r ? r.replace(/^([A-Z]{2}\d{2})([A-Z]{1,3})(\d{4})$/, '$1 $2 $3') : '';

/**
 * Handle a reply typed in the owner's chat. Returns {text, send?:{jid,file,caption}} or null if not a dispatch reply.
 */
function reply(text, { resolveGroup } = {}) {
  const t = String(text || '').trim().toLowerCase();
  const p = latest();
  if (!p) return null;
  if (/^(no|cancel|skip|ignore)$/.test(t)) { clearLatest(); return { text: 'Ignored.' }; }
  const pick = t.match(/^(\d)$/);
  if (pick && p.options[parseInt(pick[1], 10) - 1]) {
    const o = p.options[parseInt(pick[1], 10) - 1];
    clearLatest();
    return { text: `Sending ${path.basename(p.file)} to ${o.label}...`, send: { jid: o.jid, file: p.file, caption: p.vehicle ? `${pretty(p.vehicle)} - ${path.basename(p.file)}` : path.basename(p.file) } };
  }
  const to = t.match(/^to\s+(.+)$/);
  if (to) {
    const target = to[1].trim();
    const cap = p.vehicle ? `${pretty(p.vehicle)} - ${path.basename(p.file)}` : path.basename(p.file);
    // a phone number -> send directly
    const digits = target.replace(/[\s\-+()]/g, '');
    if (/^\d{10,15}$/.test(digits)) {
      const jid = (digits.length === 10 ? '91' + digits : digits) + '@s.whatsapp.net';
      clearLatest();
      return { text: `Sending ${path.basename(p.file)} to ${digits}...`, send: { jid, file: p.file, caption: cap } };
    }
    // a group name -> send to that group
    const gjid = resolveGroup ? resolveGroup(target) : null;
    if (gjid) {
      clearLatest();
      return { text: `Sending ${path.basename(p.file)} to group "${target}"...`, send: { jid: gjid, file: p.file, caption: cap } };
    }
    const rows = register.search(target);
    if (!rows.length) return { text: `No set, number or group found for "${target}". Try *to 9876543210* (phone number) or *to <group name>*.` };
    const prop = propose(p.file, rows[0].vehicle ? rows[0].vehicle.replace(/\s+/g, '') : to[1].toUpperCase());
    clearLatest(); pending.set(prop.token, pending.get(prop.token));
    return { text: prop.text };
  }
  return null;
}

/** Watch folders for new PDFs (polling, no native deps). onNew(file) is called once per new PDF. */
function watch(folders, onNew, intervalMs = 5000) {
  const seen = new Map();
  const startedAt = Date.now();
  const scan = () => {
    for (const dir of folders) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!/\.pdf$/i.test(n)) continue;
        const f = path.join(dir, n);
        let st; try { st = fs.statSync(f); } catch { continue; }
        if (st.mtimeMs < startedAt - 60000) { seen.set(f, st.size); continue; }   // existed before start
        const prev = seen.get(f);
        if (prev === undefined) { seen.set(f, st.size); continue; }               // first sight: wait for the download to finish
        if (prev === -1) continue;                                                // already handled
        if (prev !== st.size) { seen.set(f, st.size); continue; }                 // still growing
        seen.set(f, -1);
        onNew(f).catch(e => console.error('[dispatch] ' + e.message));
      }
    }
  };
  setInterval(scan, intervalMs);
  scan();
}

module.exports = { vehicleFromPdf, inspect, propose, reply, watch, pending, pretty };
