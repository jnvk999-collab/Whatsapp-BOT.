/**
 * WhatsApp photo-merger for the OIC Premium Calculator.
 *
 *   photos in  -> saved under inbox/<contact>/<date>/, merged into one A4 PDF,
 *                 sent to YOUR OWN chat (PDF_TO=me), the sender, or both
 *   "quote ..." -> optional (AUTO_QUOTE=1): priced by the real calculator
 *
 * Transport: Baileys (direct WhatsApp connection, no browser). Link once by
 * scanning the QR; the login is kept in ./baileys_auth.
 */
try { require('dotenv').config(); } catch {}
const path = require('path');
const fs = require('fs');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion,
  DisconnectReason, downloadMediaMessage, jidNormalizedUser,
} = require('@whiskeysockets/baileys');

// The WhatsApp library's signal layer prints raw session objects with console.log.
// Keep them out of the log: they are noise for a human reader.
for (const level of ['log', 'info', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    const first = args[0];
    if (typeof first === 'string' && /^(Closing (open )?session|Session error|SessionEntry|Removing old closed session)/.test(first)) return;
    if (args.some(a => a && typeof a === 'object' && !(a instanceof Error) && ('indexInfo' in a || '_chains' in a || 'pendingPreKey' in a || 'currentRatchet' in a))) return;
    orig(...args);
  };
}

const { mergeFilesToPdf, PhotoBatcher } = require('./lib/pdfMerge');
const org = require('./lib/organise');
const mailer = require('./lib/mailer');
const routes = require('./lib/routes');
const ignore = require('./lib/ignore');
const reminders = require('./lib/reminders');
const register = require('./lib/register');
const commands = require('./lib/commands');
const dispatch = require('./lib/dispatch');
const mailwatch = require('./lib/mailwatch');
const renewals = require('./lib/renewals');
const requests = require('./lib/requests');
const policyLib = require('./lib/policy');
const vehicle = require('./lib/vehicle');

const CFG = {
  agentName: process.env.AGENT_NAME || '',
  mergeWaitSeconds: parseInt(process.env.MERGE_WAIT_SECONDS || '45', 10),
  replyInGroups: process.env.REPLY_IN_GROUPS === '1',
  allowGroups: (process.env.ALLOW_GROUPS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  allowList: (process.env.ALLOW_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean),
  autoReplyQuotes: process.env.AUTO_QUOTE === '1',
  autoMergePdf: process.env.AUTO_PDF !== '0',
  pdfTo: (process.env.PDF_TO || 'me').toLowerCase(),
  // Read the vehicle number from the photos (local OCR, free) and use it in the file name.
  ocrVehicle: process.env.OCR_VEHICLE !== '0',
  // Send policy PDFs back to the requester: watch these folders for new PDFs.
  watchDownloads: process.env.WATCH_DOWNLOADS === '1',
  dispatchAuto: process.env.DISPATCH_AUTO === '1',
  // Renewal reminder: every day at RENEWAL_HOUR (24h), policies expiring within RENEWAL_DAYS.
  renewalDays: parseInt(process.env.RENEWAL_DAYS || '2', 10),
  renewalMilestones: (process.env.RENEWAL_MILESTONES || '7,2,0').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)),
  renewalHour: parseInt(process.env.RENEWAL_HOUR || '8', 10),
  // Only make a PDF when a set has at least this many photos (vehicle inspection sets).
  // Single greeting images / forwards are filed in the inbox but produce nothing.
  minPhotos: parseInt(process.env.MIN_PHOTOS || '3', 10),
};
const prettyReg = r => r ? r.replace(/^([A-Z]{2}\d{2})([A-Z]{1,3})(\d{4})$/, '$1 $2 $3').replace(/^(\d{2}BH)(\d{4})([A-Z]{1,2})$/, '$1 $2 $3') : '';

const AUTH_DIR = path.resolve(__dirname, 'baileys_auth');
const QR_PNG = path.resolve(__dirname, 'qr.png');
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

let sock = null;
let myJid = null;

// Remember which messages we already handled, so a reconnect never makes a second PDF.
const SEEN_FILE = path.join(org.ROOT, 'processed.json');
let seen = [];
try { seen = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch {}
const seenSet = new Set(seen);
function markSeen(id) {
  if (!id || seenSet.has(id)) return;
  seenSet.add(id); seen.push(id);
  if (seen.length > 5000) { const drop = seen.splice(0, seen.length - 5000); drop.forEach(d => seenSet.delete(d)); }
  try { fs.mkdirSync(org.ROOT, { recursive: true }); fs.writeFileSync(SEEN_FILE, JSON.stringify(seen)); } catch {}
}
const groupNames = new Map();          // jid -> group subject

// ── helpers ────────────────────────────────────────────────────────────────
const number = jid => (jid || '').split('@')[0].split(':')[0];

async function groupName(jid) {
  if (groupNames.has(jid)) return groupNames.get(jid);
  try { const md = await sock.groupMetadata(jid); groupNames.set(jid, md.subject || ''); return md.subject || ''; }
  catch { return ''; }
}

async function contactLabel(m) {
  const jid = m.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const who = m.key.fromMe ? myJid : (isGroup ? m.key.participant : jid);
  const num = number(who);
  let label = m.key.fromMe ? `${CFG.agentName || 'Me'} (${num})` : (m.pushName ? `${m.pushName} (${num})` : num);
  if (isGroup) label = ((await groupName(jid)) || 'group') + ' - ' + label;
  return label;
}

async function allowed(m) {
  const jid = m.key.remoteJid || '';
  if (m.key.fromMe) {
    // Your own messages (typed on the phone) count too, but only photos/PDFs,
    // and never the files the bot itself sent.
    if (sentByBot.has(m.key.id)) return false;
    if (!mediaOf(m)) return false;
  }
  if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) return false;
  const isGroup = jid.endsWith('@g.us');
  if (isGroup) {
    if (!CFG.replyInGroups) return false;
    const gname = await groupName(jid);
    if (CFG.allowGroups.length && !CFG.allowGroups.includes(gname.toLowerCase())) return false;
    if (!ignore.groupAllowed(gname)) { if (mediaOf(m)) console.log(`[ignore] group "${gname}" not in allowed-groups.txt`); return false; }
  }
  const sender = m.key.fromMe ? number(myJid) : number(isGroup ? m.key.participant : jid);
  if (CFG.allowList.length && !m.key.fromMe && !CFG.allowList.includes(sender)) return false;
  const why = ignore.isIgnored({ group: isGroup ? await groupName(jid) : '', sender: m.key.fromMe ? '' : sender });
  if (why) { if (mediaOf(m)) console.log(`[ignore] ${why}`); return false; }
  return true;
}

function textOf(m) {
  const msg = m.message || {};
  return (msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption
    || msg.documentMessage?.caption || '').trim();
}

function mediaOf(m) {
  const msg = m.message || {};
  const img = msg.imageMessage; if (img) return { kind: 'image', mimetype: img.mimetype || 'image/jpeg' };
  const doc = msg.documentMessage || msg.documentWithCaptionMessage?.message?.documentMessage;
  if (doc) return { kind: 'document', mimetype: doc.mimetype || 'application/octet-stream', name: doc.fileName };
  return null;
}

// ids of messages the bot itself sent, so it never reacts to its own PDFs/notes
const sentByBot = new Set();
function remember(sent) { const id = sent && sent.key && sent.key.id; if (id) { sentByBot.add(id); if (sentByBot.size > 2000) sentByBot.delete(sentByBot.values().next().value); } return sent; }
async function sendText(jid, text) { return remember(await sock.sendMessage(jid, { text })); }
async function sendPdf(jid, file, caption) {
  return remember(await sock.sendMessage(jid, { document: fs.readFileSync(file), mimetype: 'application/pdf', fileName: path.basename(file), caption }));
}
async function notifyOwner(text) { try { if (myJid) await sendText(myJid, '🤖 ' + text); } catch (e) { console.error('[notify] ' + e.message); } }

// ── photo batching → merged PDF ────────────────────────────────────────────
const batcher = new PhotoBatcher({
  waitSeconds: CFG.mergeWaitSeconds,
  onFlush: async (chatId, files) => {
    const first = files[0];
    const label = first.label;
    const photoCount = files.filter(f => /\.(jpe?g|png)$/i.test(f.path)).length;
    if (photoCount < CFG.minPhotos) {
      console.log(`[skip] ${label}: only ${photoCount} photo${photoCount === 1 ? '' : 's'} (need ${CFG.minPhotos}), no PDF made`);
      org.log({ type: 'skipped-small-set', contact: label, photos: photoCount, files: files.map(f => path.basename(f.path)) });
      return;
    }
    try {
      const stamp = first.sentAt ? new Date(first.sentAt) : new Date();   // file under the day the photos were sent
      const date = stamp.toLocaleDateString('en-CA');                       // YYYY-MM-DD
      const hhmm = stamp.toTimeString().slice(0, 5).replace(':', '');
      let reg = null, part = null;
      if (CFG.ocrVehicle) {
        // results were being read as photos arrived; give stragglers at most 30 s more
        const settled = await Promise.race([
          Promise.all(files.map(f => f.ocr || null)),
          new Promise(res => setTimeout(() => res(null), 30000)),
        ]);
        if (settled) { const d = vehicle.decide(settled); reg = d.number; part = d.partial; }
        else console.log('[ocr] not finished in time, naming by sender');
      }
      console.log(`[pdf] ${label}: merging ${files.length} file(s)...`);
      const who = org.safeName(first.name || number(first.sender)).replace(/\s+/g, '_');
      // full number -> AP26AB1234_date ; only last digits readable -> 1234_date_time ; nothing -> Name_date_time
      const baseName = reg ? `${reg}_${date}` : part ? `${part}_${date}_${hhmm}` : `${who}_${date}_${hhmm}`;
      const vehLabel = reg ? prettyReg(reg) : part ? `...${part} (partial)` : '';
      const { bytes, pages, items, skipped } = await mergeFilesToPdf(
        files.map(f => ({ path: f.path, caption: f.caption })),
        {
          label: vehLabel || (first.name || number(first.sender)),
          title: `${vehLabel ? vehLabel + ' - ' : ''}${first.name || number(first.sender)} - ${date}`,
          cover: {
            title: 'Documents received on WhatsApp', vehicle: vehLabel,
            from: first.name || '', number: number(first.sender), group: first.group || '',
            received: first.receivedAt.toLocaleString('en-IN') + (Date.now() - first.receivedAt > 10 * 60000 ? `  (processed ${new Date().toLocaleString('en-IN')})` : ''), agent: CFG.agentName,
          },
        });
      let fname = `${baseName}.pdf`;
      if (reg && org.archiveExists(fname, stamp)) fname = `${baseName}_${hhmm}.pdf`;   // same vehicle twice a day
      const out = org.saveOutput(label, fname, Buffer.from(bytes), { pages, source: files.length, vehicle: reg });
      const archived = org.archiveMerged(fname, Buffer.from(bytes), stamp);
      const photos = items.filter(i => i.kind === 'Photo').length, pdfs = items.length - photos;
      let caption = `${vehLabel ? vehLabel + ' - ' : ''}${label}: ${photos} photo${photos === 1 ? '' : 's'}${pdfs ? ` + ${pdfs} PDF${pdfs === 1 ? '' : 's'}` : ''} merged (${pages} page${pages === 1 ? '' : 's'}).`;
      if (skipped.length) caption += ` Skipped ${skipped.length} unsupported file(s).`;
      if (CFG.pdfTo === 'me' || CFG.pdfTo === 'both') await sendPdf(myJid, out, caption);
      if (CFG.pdfTo === 'sender' || CFG.pdfTo === 'both') await sendPdf(chatId, out, `Merged into one PDF (${pages} page${pages === 1 ? '' : 's'}).`);
      console.log(`[pdf] ${label}: ${pages} pages${vehLabel ? ', vehicle ' + vehLabel : ', no vehicle number found'} -> ${archived}`);
      const emailed = [];
      const regRow = {
        date, time: stamp.toTimeString().slice(0, 5), vehicle: vehLabel || '', sender: first.name || '', number: number(first.sender),
        group: first.group || '', photos, pdfs, pages, file: archived, emailed, processedAt: new Date().toISOString(),
        chat: chatId, senderJid: first.sender || '',
      };
      if (mailer.enabled()) {
        try {
          const to = routes.recipientsFor({ group: first.group, sender: number(first.sender) }, mailer.defaultTo());
          await mailer.sendPdf({
            to, file: out, filename: path.basename(out),
            subject: `${vehLabel ? vehLabel + ' - ' : ''}${first.name || number(first.sender)} - ${date} - ${pages} page${pages === 1 ? '' : 's'}${first.group ? ` (${first.group})` : ''}`,
            text: caption + '\n\n' + items.map((it, i) => `${i + 1}. ${it.kind} ${it.name}${it.caption ? ' - ' + it.caption : ''}`).join('\n'),
          });
          console.log(`[mail] sent ${path.basename(out)} to ${to.join(', ')}`);
          emailed.push(...to);
        } catch (e) {
          console.error('[mail] failed: ' + e.message);
          await notifyOwner(`PDF was sent here but the email failed: ${e.message}`);
        }
      }
      await register.add(regRow);
    } catch (e) {
      console.error('[pdf] merge failed: ' + e.message);
      await notifyOwner(`Could not merge files from ${label}. They are saved in the inbox folder.`);
    }
  },
});

// ── optional quotes ────────────────────────────────────────────────────────
async function handleQuote(m, text, label) {
  const calc = require('./lib/calculator');
  const { parseQuote } = require('./lib/intents');
  const { quoteText } = require('./lib/reply');
  const jid = m.key.remoteJid;
  const { input, missing } = parseQuote(text);
  if (missing.length) {
    org.log({ type: 'quote-incomplete', contact: label, text, missing });
    return notifyOwner(`Quote request from ${label} needs your reply:\n"${text}"\n(missing: ${missing.join(', ')})`);
  }
  const res = await calc.motorQuote(input);
  if (!res.ok) {
    org.log({ type: 'quote-error', contact: label, text, errors: res.errors });
    return notifyOwner(`Could not auto-quote for ${label}: "${text}"\n${res.errors.join('; ')}`);
  }
  const pdfPath = org.saveOutput(label, res.filename, Buffer.from(res.pdfBase64, 'base64'), { total: res.summary.total, text });
  await sendText(jid, quoteText(res.summary, CFG.agentName));
  await sendPdf(jid, pdfPath, '');
  org.log({ type: 'quote', contact: label, text, input, total: res.summary.total, file: path.basename(pdfPath) });
  console.log(`[quote] ${label}: "${text}" -> ₹${res.summary.total}`);
}

// ── message handling ───────────────────────────────────────────────────────
async function onMessage(m) {
  if (!m.message) return;
  if (m.key.id && seenSet.has(m.key.id)) return;          // already handled before a restart/reconnect
  // A PDF you forward into your own chat from the phone -> offer to send it to the requester
  if (m.key.fromMe && myJid && m.key.remoteJid === myJid && !sentByBot.has(m.key.id)) {
    const med = mediaOf(m);
    if (med && med.mimetype === 'application/pdf') {
      markSeen(m.key.id);
      try {
        const buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        const dir = path.join(__dirname, 'outbox'); fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, (med.name || `from-phone-${Date.now()}.pdf`).replace(/[^\w\-. ]+/g, '_'));
        fs.writeFileSync(file, buf);
        await offerDispatch(file, { source: 'chat' });
      } catch (e) { await sendText(myJid, 'Could not read that PDF: ' + e.message); }
      return;
    }
  }
  // Commands typed by you in your own chat ("message yourself")
  if (m.key.fromMe && myJid && m.key.remoteJid === myJid && !mediaOf(m) && !sentByBot.has(m.key.id)) {
    const t = textOf(m);
    if (t) {
      markSeen(m.key.id);
      try {
        const d = dispatch.reply(t, { resolveGroup: (name) => {
          const n = name.replace(/\s+/g, ' ').trim().toLowerCase();
          for (const [jid, subject] of groupNames) if ((subject || '').replace(/\s+/g, ' ').trim().toLowerCase() === n) return jid;
          for (const [jid, subject] of groupNames) if ((subject || '').toLowerCase().includes(n)) return jid;
          return null;
        } });
        if (d) {
          if (d.text) await sendText(myJid, d.text);
          if (d.send) {
            await sendPdf(d.send.jid, d.send.file, d.send.caption);
            await sendText(myJid, `✅ Sent ${path.basename(d.send.file)}.`);
            org.log({ type: 'dispatched', file: path.basename(d.send.file), to: d.send.jid });
            console.log(`[dispatch] sent ${path.basename(d.send.file)} to ${d.send.jid}`);
          }
          return;
        }
        const due = t.match(/^(due|renewals?|expir\w*)\s*(\d+)?$/i);
        if (due) {
          const days = due[2] ? parseInt(due[2], 10) : CFG.renewalDays;
          const r = await renewals.due(days, { includePast: 3 });
          await sendText(myJid, renewals.format(r.list, days) + (r.file ? '' : '\n\n(No renewals.xlsx found in the bot folder; showing scanned policies only.)'));
          console.log(`[renewals] ${t}: ${r.list.length} due`);
          return;
        }
        if (/^reminders?$/i.test(t)) {
          const d = reminders.describe();
          await sendText(myJid, (d.lines.length ? '*Daily reminders* (edit reminders.txt)\n' + d.lines.join('\n') : 'No reminders set. Add lines to reminders.txt like:\n10:00-10:15  Mon-Sat  Mark attendance')
            + (d.errors.length ? '\n\n⚠️ ' + d.errors.join('\n⚠️ ') : ''));
          return;
        }
        const res = await commands.handle(t, { mailer });
        if (res) {
          if (res.text) await sendText(myJid, res.text);
          for (const f of res.files || []) await sendPdf(myJid, f, path.basename(f));
          console.log(`[cmd] ${t}`);
        }
      } catch (e) { await sendText(myJid, 'Command failed: ' + e.message); }
      return;
    }
  }
  if (!(await allowed(m))) return;
  const jid = m.key.remoteJid;
  const label = await contactLabel(m);
  const text = textOf(m);
  const sentAt = m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000) : new Date();
  const ageMin = Math.round((Date.now() - sentAt) / 60000);
  if (ageMin > 2) console.log(`[offline] catching up: message from ${label} sent ${ageMin} min ago (${sentAt.toLocaleString('en-IN')})`);
  markSeen(m.key.id);
  try {
    const media = mediaOf(m);
    if (media) {
      let buf = null;
      try { buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }); }
      catch (e) { console.error(`[media] could not download from ${label}: ${e.message}`); }
      if (!buf) { org.log({ type: 'media-failed', contact: label, caption: text }); return; }
      const file = org.saveMedia(label, { data: buf.toString('base64'), mimetype: media.mimetype }, { caption: text, from: jid });
      const mergeable = /^image\/(jpeg|png)$/i.test(media.mimetype) || media.mimetype === 'application/pdf';
      if (CFG.autoMergePdf && mergeable) {
        const isGroup = jid.endsWith('@g.us');
        // start reading the vehicle number right away, while we wait for the rest of the photos
        const ocr = (CFG.ocrVehicle && /^image\//.test(media.mimetype))
          ? vehicle.readOne(file).catch(e => { console.error('[ocr] ' + e.message); return null; })
          : Promise.resolve(null);
        // payment screenshot -> policy copy request
        if (!m.key.fromMe) ocr.then(r => r && r.text && handlePolicyRequest(jid, isGroup ? m.key.participant : jid, label, r.text, text)).catch(e => console.error('[request] ' + e.message));
        const n = await batcher.add(jid, {
          path: file, label, caption: text, receivedAt: sentAt, sentAt, processedAt: new Date(), ocr,
          name: m.key.fromMe ? (CFG.agentName || 'Me') : (m.pushName || ''), sender: m.key.fromMe ? myJid : (isGroup ? m.key.participant : jid),
          group: isGroup ? await groupName(jid) : '',
        });
        if (n === 1) console.log(`[files] ${label}: collecting, PDF in ${CFG.mergeWaitSeconds}s`);
        if (n === 1 && CFG.pdfTo !== 'me') await sendText(jid, `Got it. I will merge the photos into one PDF in ${CFG.mergeWaitSeconds}s (send *pdf* to do it now).`);
      }
      if (CFG.autoReplyQuotes && text && require('./lib/intents').isQuoteRequest(text)) await handleQuote(m, text, label);
      return;
    }
    if (/^(pdf|merge|done)$/i.test(text)) {
      if (batcher.pending(jid)) return batcher.flush(jid);
      if (CFG.pdfTo !== 'me') return sendText(jid, 'No photos waiting. Send the photos first, then *pdf*.');
      return;
    }
    if (CFG.autoReplyQuotes && /^(help|menu)$/i.test(text)) return sendText(jid, require('./lib/reply').HELP);
    if (CFG.autoReplyQuotes && text && require('./lib/intents').isQuoteRequest(text)) return handleQuote(m, text, label);
    org.log({ type: 'text', contact: label, text });
  } catch (e) {
    console.error(`[handler] ${label}: ${e.message}`);
  }
}

// ── "please provide policy copy" requests (payment screenshots) ────────────
async function handlePolicyRequest(chatJid, senderJid, label, ocrText, caption) {
  const pay = requests.parsePayment(ocrText);
  if (!pay.isPayment) return;
  console.log(`[request] ${label}: payment screenshot, proposal ${pay.proposalNo}, amount ₹${pay.amount || '?'}`);
  const pol = requests.findPolicy(pay.proposalNo);
  const who = `${label}`;
  if (!pol) {
    requests.park({ chat: chatJid, sender: senderJid, label, proposalNo: pay.proposalNo, amount: pay.amount, txnId: pay.txnId, caption });
    await notifyOwner(`📥 Policy copy requested by ${who}\nProposal ${pay.proposalNo}, paid ₹${pay.amount ? pay.amount.toLocaleString('en-IN') : '?'}\nPolicy not received yet – I will send it to them automatically when it arrives by mail.`);
    return;
  }
  const ok = requests.amountOk(pay.amount, pol.premium);
  if (ok === false) {
    await notifyOwner(`⚠️ ${who} paid ₹${pay.amount.toLocaleString('en-IN')} for proposal ${pay.proposalNo}, but the policy premium is ₹${Number(pol.premium).toLocaleString('en-IN')} (${pol.policyNo}). NOT sent. Forward the PDF here and reply *to <number>* if you want it sent anyway.`);
    return;
  }
  await sendPdf(chatJid, pol.file, `Policy ${pol.policyNo}${pol.vehicle ? ' - ' + dispatch.pretty(pol.vehicle) : ''}${pol.insured ? ' - ' + pol.insured : ''}`);
  await notifyOwner(`✅ Sent policy ${pol.policyNo}${pol.vehicle ? ' (' + dispatch.pretty(pol.vehicle) + ')' : ''} to ${who}. Paid ₹${pay.amount ? pay.amount.toLocaleString('en-IN') : '?'}${pol.premium ? ', premium ₹' + Number(pol.premium).toLocaleString('en-IN') : ''}${ok === null ? ' (amount not checkable)' : ' ✔'}`);
  org.log({ type: 'policy-sent', to: chatJid, policy: pol.policyNo, proposal: pay.proposalNo, amount: pay.amount });
  console.log(`[request] sent ${pol.policyNo} to ${label}`);
}

/** A new policy PDF has arrived (mail / downloads): record it and fulfil parked requests. */
async function onNewPolicy(file, info, source) {
  requests.recordPolicy(file, info, { source });
  const waiting = requests.takeMatching(info);
  for (const r of waiting) {
    const ok = requests.amountOk(r.amount, info.premium);
    if (ok === false) { await notifyOwner(`⚠️ Policy ${info.policyNo} arrived for ${r.label}'s request, but they paid ₹${r.amount} and the premium is ₹${info.premium}. NOT sent.`); continue; }
    await sendPdf(r.chat, file, `Policy ${info.policyNo}${info.vehicle ? ' - ' + dispatch.pretty(info.vehicle) : ''}${info.insured ? ' - ' + info.insured : ''}`);
    await notifyOwner(`✅ Policy ${info.policyNo} arrived and was sent to ${r.label} (requested ${r.parkedAt.slice(0, 16).replace('T', ' ')}).`);
    console.log(`[request] fulfilled parked request for ${r.label}: ${info.policyNo}`);
  }
  return waiting.length;
}

// ── policy PDF dispatch ────────────────────────────────────────────────────
async function offerDispatch(file, meta = {}) {
  // a PDF the bot itself produced (merged set) is never a policy to dispatch
  const base = path.basename(file).replace(/_\d+\.pdf$/i, '.pdf');
  if (register.readAll().some(r => r.file && path.basename(r.file) === base) || /^\d{13}_/.test(path.basename(file))) {
    console.log(`[dispatch] ${path.basename(file)} is one of our own merged PDFs, ignored`);
    return;
  }
  const ins = await dispatch.inspect(file);
  const vehicle = ins.vehicle;
  const auto = meta.source === 'downloads' || meta.source === 'mail';
  if (meta.from) console.log(`[dispatch] mail from ${meta.from}: ${path.basename(file)} -> ${vehicle || 'no vehicle number'}${ins.isPolicy ? ' (policy)' : ' (not a policy)'}`);
  if (ins.isPolicy) {
    const fulfilled = await onNewPolicy(file, { ...ins.info, vehicle: ins.info.vehicle || vehicle }, meta.source || 'chat');
    if (fulfilled) return;                      // someone was waiting for exactly this policy: done
  }
  // From Downloads or Gmail: only genuine policy documents. Forwarded by you: always.
  if (auto && !ins.isPolicy) {
    console.log(`[dispatch] ${path.basename(file)}: ${ins.looksLikeQuote ? 'a quote' : `not a policy document (${ins.textLength} characters of text, policy no ${ins.info && ins.info.policyNo ? ins.info.policyNo : 'not found'})`}, ignored`);
    return;
  }
  const prop = dispatch.propose(file, vehicle);
  const p = dispatch.pending.get(prop.token);
  if (CFG.dispatchAuto && p && p.options.length) {
    const o = p.options[0];
    dispatch.pending.delete(prop.token);
    await sendPdf(o.jid, file, `${dispatch.pretty(vehicle)} - ${path.basename(file)}`);
    await sendText(myJid, `✅ Auto-sent ${path.basename(file)} (${dispatch.pretty(vehicle)}${ins.info.insured ? ', ' + ins.info.insured : ''}) to ${o.label}.`);
    console.log(`[dispatch] auto-sent ${path.basename(file)} to ${o.jid}`);
    return;
  }
  // ask, with the PDF attached so you can see it and forward it by hand if you prefer
  await sendPdf(myJid, file, prop.text);
  console.log(`[dispatch] proposed ${path.basename(file)} (${vehicle || 'no vehicle'})`);
}

function startDispatchWatch() {
  const folders = [path.join(__dirname, 'outbox')];
  fs.mkdirSync(folders[0], { recursive: true });
  if (CFG.watchDownloads) {
    const dl = process.env.DOWNLOADS_DIR || path.join(require('os').homedir(), 'Downloads');
    if (fs.existsSync(dl)) folders.push(dl);
  }
  dispatch.watch(folders, async (file) => { if (myJid) await offerDispatch(file, { source: /outbox/i.test(file) ? 'outbox' : 'downloads' }); });
  console.log('[dispatch] watching for policy PDFs in: ' + folders.join(' ; '));
  mailwatch.start(async (file, meta) => { if (myJid) await offerDispatch(file, { ...meta, source: 'mail' }); }, console.log);
}

// ── automatic renewal reminders (7 days before, 2 days before, on the day; each once) ──
let lastRenewalRun = '';
setInterval(async () => {
  if (!myJid) return;
  const now = new Date();
  const day = renewals.today(now);
  if (now.getHours() < CFG.renewalHour || lastRenewalRun === day) return;
  lastRenewalRun = day;
  try {
    const r = await renewals.milestoneReminders(CFG.renewalMilestones);
    for (const b of r.batches) {
      await sendText(myJid, renewals.formatMilestone(b.milestone, b.list));
      console.log(`[renewals] ${b.milestone}-day reminder: ${b.list.length} polic${b.list.length === 1 ? 'y' : 'ies'}`);
    }
    if (!r.batches.length) console.log(`[renewals] checked ${r.total} policies, nothing due today`);
  } catch (e) { console.error('[renewals] ' + e.message); }
}, 60 * 1000);

// ── daily reminders to your own chat (reminders.txt: "10:00-10:15  Mon-Sat  Mark attendance") ──
try { if (reminders.ensureFile()) console.log('[reminders] created reminders.txt with the attendance reminders'); } catch (e) { console.error('[reminders] ' + e.message); }
setInterval(async () => {
  if (!myJid) return;
  try {
    for (const r of reminders.due()) {
      await sendText(myJid, r.text);
      reminders.markSent(r);
      console.log(`[reminders] sent: ${r.text}`);
    }
  } catch (e) { console.error('[reminders] ' + e.message); }
}, 30 * 1000);

// ── tiny private web page (for cloud servers with no screen) ───────────────
// STATUS_PORT + STATUS_TOKEN in .env  ->  http://<server-ip>:<port>/<token>/
// shows whether the bot is connected, the last log lines, and the QR when needed.
function startStatusPage() {
  const port = parseInt(process.env.STATUS_PORT || '0', 10);
  const token = process.env.STATUS_TOKEN || '';
  if (!port || !token) return;
  const http = require('http');
  http.createServer((req, res) => {
    const url = req.url || '';
    if (!url.startsWith('/' + token)) { res.writeHead(404); return res.end('not found'); }
    const sub = url.slice(token.length + 1);
    if (sub === '/qr.png') {
      if (!fs.existsSync(QR_PNG)) { res.writeHead(404); return res.end('no QR right now'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return fs.createReadStream(QR_PNG).pipe(res);
    }
    let lines = [];
    try {
      const dir = path.join(__dirname, 'logs');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort() : [];
      if (files.length) lines = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8').trim().split('\n').slice(-40);
    } catch {}
    const linked = !!myJid, qr = fs.existsSync(QR_PNG);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><meta http-equiv="refresh" content="10"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OIC WhatsApp bot</title><body style="font-family:system-ui;max-width:720px;margin:24px auto;padding:0 12px">
<h2>OIC WhatsApp bot</h2>
<p><b>Status:</b> ${linked ? '✅ connected as ' + number(myJid) : (qr ? '📱 waiting for QR scan' : '⏳ starting / reconnecting')}</p>
${qr ? '<p>Open WhatsApp on your phone &gt; Linked devices &gt; Link a device, and scan:</p><img src="' + token + '/qr.png?' + Date.now() + '" style="width:320px;border:8px solid #fff">' : ''}
<h3>Last log lines</h3><pre style="background:#111;color:#ddd;padding:12px;overflow:auto;font-size:12px">${lines.map(l => l.replace(/</g, '&lt;')).join('\n')}</pre>
<p style="color:#888;font-size:12px">Refreshes every 10 s. Keep this link private: anyone with it can link your WhatsApp.</p></body>`);
  }).listen(port, () => console.log(`[web] status page on port ${port} (path /${token.slice(0, 4)}…/)`));
}
startStatusPage();

// ── connection ─────────────────────────────────────────────────────────────
// One socket at a time. Every reconnect closes the old one and drops its
// listeners first, otherwise dead sockets pile up, each asking for another
// reconnect, and WhatsApp starts dropping all of them (error 428/440).
let connecting = false;          // a start() is already in flight
let reconnects = 0;              // consecutive failures, for the backoff
let lastOpenAt = Date.now();     // when we were last actually connected

async function start() {
  if (connecting) return;
  connecting = true;
  const mySock = {};             // identity of this attempt
  try {
    if (sock) { try { sock.ev.removeAllListeners(); } catch {} try { sock.end(undefined); } catch {} sock = null; }
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false });
    sock.__id = mySock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        QRCode.toFile(QR_PNG, qr, { width: 400 }).catch(() => {});
        console.log('\n==============================================');
        console.log('Open WhatsApp on your phone > Linked devices > Link a device');
        console.log('and scan the QR below, or open this image: ' + QR_PNG);
        console.log('==============================================\n');
        qrcodeTerminal.generate(qr, { small: true });
      }
      if (u.receivedPendingNotifications) console.log('[whatsapp] caught up with everything received while offline');
      if (!sock || sock.__id !== mySock) return;      // an old socket talking; ignore it
      if (connection === 'open') {
        reconnects = 0; lastOpenAt = Date.now();
        try { fs.unlinkSync(QR_PNG); } catch {}
        myJid = jidNormalizedUser(sock.user.id);
        if (CFG.ocrVehicle) vehicle.warmUp();
        if (!global.__dispatchStarted) { global.__dispatchStarted = true; startDispatchWatch(); }
        if (mailer.enabled()) mailer.verify().then(() => console.log('[mail] email login OK, PDFs will also be emailed to ' + process.env.EMAIL_TO)).catch(e => console.error('[mail] email login FAILED: ' + e.message));
        console.log(`Ready as ${number(myJid)}. Inbox: ${org.ROOT}  Merged PDFs: ${org.MERGED_ROOT}  min photos: ${CFG.minPhotos}  merge wait: ${CFG.mergeWaitSeconds}s  PDF to: ${CFG.pdfTo}  groups: ${CFG.replyInGroups ? (CFG.allowGroups.join(', ') || 'all') : 'off'}`);
        if (CFG.replyInGroups) {
          try {
            const groups = Object.values(await sock.groupFetchAllParticipating());
            groups.forEach(g => groupNames.set(g.id, g.subject));
            const list = groups.map(g => g.subject).sort((a, b) => a.localeCompare(b));
            fs.writeFileSync(path.join(__dirname, 'groups.txt'),
              '# All groups this number is in (written at every start).\n' +
              '# To handle ONLY some groups: create allowed-groups.txt and put one group name per line.\n' +
              '# To skip some groups: put their names in ignore-list.txt.\n\n' + list.join('\n') + '\n');
            const allow = ignore.allowedGroups();
            console.log(`[groups] ${list.length} groups written to groups.txt` + (allow ? `; handling only the ${allow.size} in allowed-groups.txt` : '; handling all (create allowed-groups.txt to limit)'));
          } catch (e) { console.log('[groups] could not list groups: ' + e.message); }
        }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.error('Logged out from the phone. Delete the baileys_auth folder and run node bot.js again to re-link.');
          process.exit(1);
        }
        console.log(`[whatsapp] connection closed (${code || 'unknown'})`);
        scheduleReconnect();
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) { try { await onMessage(m); } catch (e) { console.error('[upsert] ' + e.message); } }
    });

  } catch (e) {
    console.error('[whatsapp] could not start: ' + e.message);
    scheduleReconnect();
  } finally { connecting = false; }
}

/** Reconnect with a growing wait, so a dead network does not spin the CPU. */
function scheduleReconnect() {
  reconnects++;
  const wait = Math.min(3000 * Math.pow(1.7, Math.min(reconnects, 8)), 120000);
  console.log(`[whatsapp] reconnecting in ${Math.round(wait / 1000)}s (attempt ${reconnects})`);
  setTimeout(() => start().catch(e => console.error('[whatsapp] ' + e.message)), wait);
}

// Watchdog: if we have not been connected for 15 minutes, stop the process.
// run.js starts a clean one straight away - no typing needed.
setInterval(() => {
  if (stopping) return;
  if (fs.existsSync(QR_PNG)) { lastOpenAt = Date.now(); return; }   // waiting for you to scan; not a fault
  const downFor = Date.now() - lastOpenAt;
  if (downFor > 15 * 60 * 1000) {
    console.error(`[watchdog] no WhatsApp connection for ${Math.round(downFor / 60000)} minutes, restarting the bot`);
    process.exit(1);
  }
}, 60 * 1000);

// A bad photo or a library hiccup must never take the bot down.
process.on('uncaughtException', e => console.error('[fatal-caught] ' + (e && e.stack || e)));
process.on('unhandledRejection', e => console.error('[rejection] ' + (e && e.stack || e)));
let stopping = false;
async function gracefulStop(reason) {
  if (stopping) process.exit(0);
  stopping = true;
  const waiting = [...batcher.buffers.values()].reduce((n, b) => n + b.files.length, 0);
  if (waiting) { console.log(`\n[${reason}] finishing ${waiting} pending file(s) before stopping...`); await batcher.flushAll(); }
  try { await require('./lib/calculator').close(); } catch {}
  try { await vehicle.close(); } catch {}
  try { sock && sock.end && sock.end(undefined); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => gracefulStop('Ctrl+C'));
process.on('SIGTERM', () => gracefulStop('stop'));
process.on('message', m => { if (m === 'shutdown') gracefulStop('update'); });
start().catch(e => { console.error('Fatal: ' + e.message); process.exit(1); });
