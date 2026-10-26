/**
 * Renewal reminders from your own Excel sheet (renewals.xlsx in the bot folder)
 * and from the policies the bot has scanned (merged/policies.jsonl).
 *
 * Excel: any sheet; the header row is found automatically; columns are matched
 * by name (case-insensitive, partial):
 *   expiry:  expiry | expiry date | end date | to date | valid till | due
 *   name:    name | insured | customer
 *   vehicle: vehicle | reg | registration
 *   policy:  policy
 *   phone:   mobile | phone | contact | cell
 */
const fs = require('fs');
const path = require('path');
const org = require('./organise');

const DIR = path.resolve(__dirname, '..');
const COLS = {
  expiry: /^to\b|expiry ?date|end ?date|to ?date|valid ?till|upto|renewal ?date|^expir/i,
  start: /^from\b|start ?date|from ?date/i,
  name: /insured|customer|client|party|name/i,
  vehicle: /vehicle|registration|reg ?no|veh ?no/i,
  policy: /policy ?(no|number)|^policy$/i,
  phone: /mobile|phone|contact|cell|mob/i,
  premium: /premium|amount/i,
  agent: /^agent/i,
  type: /policy ?type|product/i,
  status: /status/i,
};
const SKIP = /days|urgency/i;   // e.g. "DAYS TO EXPIRY" is not the expiry column

function excelDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400 * 1000)); return d.toISOString().slice(0, 10); }
  if (typeof v === 'object' && v.result !== undefined) return excelDate(v.result);
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function findFile() {
  try {
    const names = fs.readdirSync(DIR).filter(f => /^renewals?(\.xlsx|\.xlsm|\.csv)(\.txt)?$/i.test(f) || /^renewal/i.test(f) && /\.xlsx$/i.test(f));
    if (names.length) return path.join(DIR, names[0]);
  } catch {}
  return null;
}

async function loadExcel() {
  const file = findFile();
  if (!file) return { rows: [], file: null };
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(file)) await wb.csv.readFile(file); else await wb.xlsx.readFile(file);
  const rows = [];
  wb.eachSheet(ws => {
    let header = null, map = null;
    ws.eachRow((row, i) => {
      const vals = row.values.slice(1).map(v => (v && typeof v === 'object' && 'richText' in v) ? v.richText.map(r => r.text).join('') : (v && typeof v === 'object' && 'result' in v) ? v.result : v);
      if (!header) {
        const hits = {};
        vals.forEach((v, idx) => {
          const h = String(v || '').replace(/[^\w\s()\/-]/g, '').trim();   // drop emoji like 📞
          if (!h || SKIP.test(h)) return;
          for (const [k, re] of Object.entries(COLS)) if (hits[k] === undefined && re.test(h)) { hits[k] = idx; break; }
        });
        if (hits.expiry !== undefined && (hits.phone !== undefined || hits.name !== undefined || hits.vehicle !== undefined)) { header = i; map = hits; }
        return;
      }
      const expiry = excelDate(vals[map.expiry]);
      if (!expiry) return;
      const cell = k => map[k] === undefined ? '' : vals[map[k]];
      const str = k => { const v = cell(k); return (v == null || typeof v === 'object') ? '' : String(v).trim(); };
      rows.push({
        expiry, start: excelDate(cell('start')), name: str('name'), vehicle: str('vehicle').toUpperCase(),
        policy: str('policy'), phone: str('phone').replace(/\D/g, '').replace(/^(91)?0?(\d{10})$/, '$2'), premium: typeof cell('premium') === 'number' ? cell('premium') : undefined,
        agent: str('agent'), type: str('type'), status: str('status'),
        sheet: ws.name, row: i, source: 'excel',
      });
    });
  });
  return { rows, file };
}

function loadScanned() {
  const f = path.join(org.MERGED_ROOT, 'policies.jsonl');
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(p => p.to)
      .map(p => ({ expiry: p.to, name: p.insured || '', vehicle: (p.vehicle || '').toUpperCase(), policy: p.policyNo || '', phone: p.mobile || '', premium: p.premium, file: p.file, source: 'gmail' }));
  } catch { return []; }
}

const today = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

/** Policies expiring between today and today+days (inclusive), Excel first, scanned ones merged (no duplicates by vehicle/policy). */
async function due(days = 2, { includePast = 0 } = {}) {
  const { rows, file } = await loadExcel();
  const scanned = loadScanned();
  // fill blanks in the Excel rows from scanned policy PDFs (matched by policy number)
  const byPolicy = new Map(scanned.map(p => [p.policy.replace(/\s+/g, ''), p]));
  for (const r of rows) {
    const p = byPolicy.get((r.policy || '').replace(/\s+/g, ''));
    if (!p) continue;
    if (!r.phone && p.phone) r.phone = p.phone;
    if (!r.vehicle && p.vehicle) r.vehicle = p.vehicle;
    if (!r.name && p.name) r.name = p.name;
    r.file = p.file;
  }
  const all = [...rows, ...scanned];
  const seen = new Set(), out = [];
  const from = addDays(today(), -includePast), to = addDays(today(), days);
  for (const r of all.sort((a, b) => a.expiry.localeCompare(b.expiry))) {
    if (r.expiry < from || r.expiry > to) continue;
    const key = (r.vehicle || '') + '|' + (r.policy || '') + '|' + (r.phone || '');
    if (seen.has(key)) continue; seen.add(key);
    out.push(r);
  }
  return { list: out, file, total: all.length };
}

const pretty = v => (v || '').replace(/^([A-Z]{2}\d{2})([A-Z]{1,3})(\d{4})$/, '$1 $2 $3');
function format(list, days) {
  if (!list.length) return `✅ No policies expiring in the next ${days} day${days === 1 ? '' : 's'}.`;
  const t = today();
  const lines = [`🔔 *Renewals due in the next ${days} day${days === 1 ? '' : 's'}* (${list.length})`];
  for (const r of list) {
    const d = Math.round((new Date(r.expiry) - new Date(t)) / 86400000);
    const when = d < 0 ? `expired ${-d}d ago` : d === 0 ? 'expires TODAY' : d === 1 ? 'expires tomorrow' : `expires in ${d} days`;
    lines.push(`• *${r.name || pretty(r.vehicle) || r.policy}* – ${when} (${r.expiry.split('-').reverse().join('/')})` +
      (r.vehicle || r.policy ? `\n   ${r.vehicle ? '🚗 ' + pretty(r.vehicle) + '  ' : ''}${r.policy ? '📄 ' + r.policy : ''}` : '') +
      (r.type || r.premium || r.agent ? `\n   ${[r.type, r.premium ? '₹' + Number(r.premium).toLocaleString('en-IN') : '', r.agent ? 'agent ' + r.agent : ''].filter(Boolean).join(' · ')}` : '') +
      (r.phone ? `\n   📞 ${r.phone}  wa.me/91${r.phone.slice(-10)}` : '\n   📞 no number in sheet'));
  }
  return lines.join('\n');
}


/**
 * Milestone reminders: each policy gets one message at each milestone
 * (default 7 and 2 days before expiry, and on the expiry day), never twice.
 * If the bot was off on the exact day, the reminder goes out on the next run.
 */
const SENT_FILE = () => path.join(org.MERGED_ROOT, 'renewal-reminders.json');
function loadSent() { try { return JSON.parse(fs.readFileSync(SENT_FILE(), 'utf8')); } catch { return {}; } }
function saveSent(o) { try { fs.mkdirSync(org.MERGED_ROOT, { recursive: true }); fs.writeFileSync(SENT_FILE(), JSON.stringify(o)); } catch {} }

async function milestoneReminders(milestones = [10, 7, 3, 1]) {
  const { rows, file } = await loadExcel();
  const scanned = loadScanned();
  const byPolicy = new Map(scanned.map(p => [p.policy.replace(/\s+/g, ''), p]));
  for (const r of rows) { const p = byPolicy.get((r.policy || '').replace(/\s+/g, '')); if (p) { r.phone = r.phone || p.phone; r.vehicle = r.vehicle || p.vehicle; r.name = r.name || p.name; r.file = p.file; } }
  const all = [...rows, ...scanned];
  const sent = loadSent();
  const t = today();
  const out = [];   // { milestone, list }
  const seen = new Set();
  for (const m of [...milestones].sort((a, b) => b - a)) {
    const list = [];
    for (const r of all) {
      const key = ((r.policy || '') + '|' + (r.vehicle || '') + '|' + r.expiry).toUpperCase();
      if (seen.has(key + '|' + m)) continue;
      const daysLeft = Math.round((new Date(r.expiry + 'T00:00:00') - new Date(t + 'T00:00:00')) / 86400000);
      if (daysLeft < 0 || daysLeft > m) continue;                  // not yet at this milestone, or already expired
      const tag = key + '|' + m;
      if (sent[tag]) continue;
      // a bigger milestone already covered it today? (e.g. 7-day and 2-day both due on the same run) -> send only the nearest
      const nearer = milestones.filter(x => x < m && daysLeft <= x);
      if (nearer.length) { sent[tag] = t; continue; }
      seen.add(tag);
      list.push({ ...r, daysLeft });
      sent[tag] = t;
    }
    if (list.length) out.push({ milestone: m, list });
  }
  saveSent(sent);
  return { batches: out, file, total: all.length };
}

function formatMilestone(m, list) {
  const head = m === 0 ? '🚨 *Expiring TODAY*' : m <= 2 ? `🚨 *Expiring within ${m} days*` : `⏰ *Renewal reminder: ${m} days*`;
  const lines = [`${head} (${list.length})`];
  for (const r of list) {
    const when = r.daysLeft === 0 ? 'expires TODAY' : r.daysLeft === 1 ? 'expires tomorrow' : `expires in ${r.daysLeft} days`;
    lines.push(`• *${r.name || pretty(r.vehicle) || r.policy}* – ${when} (${r.expiry.split('-').reverse().join('/')})` +
      (r.vehicle || r.policy ? `\n   ${r.vehicle ? '🚗 ' + pretty(r.vehicle) + '  ' : ''}${r.policy ? '📄 ' + r.policy : ''}` : '') +
      (r.type || r.premium || r.agent ? `\n   ${[r.type, r.premium ? '₹' + Number(r.premium).toLocaleString('en-IN') : '', r.agent ? 'agent ' + r.agent : ''].filter(Boolean).join(' · ')}` : '') +
      (r.phone ? `\n   📞 ${r.phone}  wa.me/91${r.phone.slice(-10)}` : '\n   📞 no number in sheet'));
  }
  return lines.join('\n');
}

module.exports = { due, format, loadExcel, loadScanned, findFile, today, milestoneReminders, formatMilestone };
