/**
 * Move the bot to another computer over your own network (Tailscale, or any
 * network where the two machines can see each other). No pen drive, no zip.
 *
 * On the OLD computer:
 *     node stop.js
 *     node migrate.js send
 *   It prints one line to run on the new computer. Leave it running.
 *
 * On the NEW computer, in its whatsapp-bot folder:
 *     node migrate.js receive http://100.x.y.z:8099/<code>
 *
 * It pulls settings, the WhatsApp login, your lists, the renewal sheet, the
 * merged PDFs and the register, straight across. Stop it at any time with
 * Ctrl+C and run the same line again: files already there are skipped, so it
 * carries on rather than starting over.
 *
 * The address carries a one-time code and the server only answers to it, but
 * it does serve your settings and WhatsApp login, so stop it (Ctrl+C) when the
 * copy is done rather than leaving it running.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const HERE = __dirname;
const MODE = (process.argv[2] || '').toLowerCase();
const PORT = parseInt(process.env.MIGRATE_PORT || '8099', 10);

// the things that exist only on the old computer
const ITEMS = ['.env', 'baileys_auth', 'allowed-groups.txt', 'ignore-list.txt', 'email-routes.txt',
  'reminders.txt', 'renewals.xlsx', 'groups-cache.json', 'inbox/processed.json', 'merged', 'outbox', '.version'];

const mb = b => (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB';

function listFiles(rel, out = []) {
  const full = path.join(HERE, rel);
  let st;
  try { st = fs.statSync(full); } catch { return out; }
  if (st.isFile()) { out.push({ rel: rel.split(path.sep).join('/'), size: st.size }); return out; }
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    if (e.name === 'logs' || e.name === 'node_modules') continue;
    listFiles(path.join(rel, e.name), out);
  }
  return out;
}

/** Addresses the other computer can reach, Tailscale's 100.x first. */
function addresses() {
  const out = [];
  for (const [, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push(a.address);
    }
  }
  return out.sort((x, y) => (y.startsWith('100.') ? 1 : 0) - (x.startsWith('100.') ? 1 : 0));
}

// ── send ───────────────────────────────────────────────────────────────────
function send() {
  const code = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  const files = [];
  for (const it of ITEMS) listFiles(it, files);
  const total = files.reduce((n, f) => n + f.size, 0);

  const srv = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '').split('?')[0]);
    if (!url.startsWith('/' + code)) { res.writeHead(404); return res.end('no'); }
    const sub = url.slice(code.length + 1);
    if (sub === '/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(files));
    }
    if (sub.startsWith('/file/')) {
      const rel = sub.slice(6);
      const full = path.resolve(HERE, rel);
      if (!full.startsWith(HERE) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('no'); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(full).size });
      return fs.createReadStream(full).pipe(res);
    }
    res.writeHead(404); res.end('no');
  });

  srv.listen(PORT, () => {
    const ips = addresses();
    console.log('Ready to send ' + files.length + ' file(s), ' + mb(total) + '\n');
    console.log('On the NEW computer, in its whatsapp-bot folder, run:\n');
    for (const ip of ips.slice(0, 3)) console.log(`   node migrate.js receive http://${ip}:${PORT}/${code}`);
    if (!ips.length) console.log('   (no network address found: is Tailscale running?)');
    console.log('\nThe first line is usually the Tailscale one (it starts with 100.).');
    if (ips.length) {
      const raw = 'https://raw.githubusercontent.com/jnvk999-collab/PREMIUM-CALCULATOR/claude/whatsapp-photo-pdf-automation-mgr9gu/whatsapp-bot/new-pc-setup.ps1';
      console.log('\nOr, on a NEW computer with nothing set up yet, paste this one line into');
      console.log('PowerShell there instead. It installs Node.js, downloads the bot, copies');
      console.log('everything across, installs it and starts it:\n');
      console.log(`   & ([scriptblock]::Create((irm ${raw}))) -From 'http://${ips[0]}:${PORT}/${code}'`);
    }
    console.log('Leave this running until the other computer says it is done, then press Ctrl+C.');
  });
  srv.on('error', e => {
    console.error('Could not listen on port ' + PORT + ': ' + e.message);
    console.error('Another copy may already be running. Close it, or set MIGRATE_PORT to another number.');
    process.exit(1);
  });
}

// ── receive ────────────────────────────────────────────────────────────────
async function receive(base) {
  base = base.replace(/\/+$/, '');
  console.log('Fetching from ' + base + '\n');
  let files;
  try {
    const r = await fetch(base + '/list');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    files = await r.json();
  } catch (e) {
    console.error('Could not reach the other computer: ' + e.message);
    console.error('Check that "node migrate.js send" is still running there, and that the');
    console.error('address was copied exactly, code and all.');
    process.exit(1);
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  console.log(files.length + ' file(s), ' + mb(total) + '\n');

  // 21,000 files one after another is a lot of waiting on round trips, so
  // fetch several at once. Files already here at the right size are skipped,
  // which is what makes a stopped copy carry on instead of starting over.
  const LANES = parseInt(process.env.MIGRATE_LANES || '6', 10);
  let done = 0, had = 0, got = 0, failed = 0, bytes = 0;
  const started = Date.now();
  let next = 0;

  const show = () => {
    const pct = total ? Math.floor(bytes * 100 / total) : 0;
    const mins = (Date.now() - started) / 60000;
    const rate = mins > 0.05 ? `  ${(bytes / 1048576 / (mins * 60)).toFixed(1)} MB/s` : '';
    process.stdout.write(`\r  ${done} of ${files.length} files   ${mb(bytes)} of ${mb(total)} (${pct}%)${rate}` + (failed ? `   failed ${failed}` : '') + '    ');
  };

  async function lane() {
    while (next < files.length) {
      const f = files[next++];
      const dest = path.resolve(HERE, f.rel);
      if (!dest.startsWith(HERE)) { failed++; done++; continue; }
      try {
        if (fs.existsSync(dest) && fs.statSync(dest).size === f.size) { had++; bytes += f.size; done++; show(); continue; }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const r = await fetch(base + '/file/' + f.rel.split('/').map(encodeURIComponent).join('/'));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
        got++; bytes += f.size;
      } catch (e) {
        failed++;
        if (failed <= 5) console.log('\n  could not get ' + f.rel + ': ' + e.message);
      }
      done++;
      if (done % 10 === 0 || done === files.length) show();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(12, LANES)) }, lane));
  show();

  const mins = Math.round((Date.now() - started) / 60000);
  console.log('\n\nDone in ' + (mins || '<1') + ' min. ' + got + ' file(s) copied, ' + had + ' were already here' + (failed ? ', ' + failed + ' failed' : '') + '.');
  if (failed) console.log('Run the same line again to pick up the ones that failed.');
  console.log('\nNow, on this computer:');
  console.log('   npm install');
  console.log('   node ocr-upgrade.js');
  console.log('   node doctor.js');
  console.log('   node start.js');
  console.log('   node install-autostart.js');
  console.log('\nThen on the OLD computer press Ctrl+C to stop the sender, run node stop.js,');
  console.log('and remove it from WhatsApp > Settings > Linked devices.');
}

if (MODE === 'send') send();
else if (MODE === 'receive' && process.argv[3]) receive(process.argv[3]).catch(e => { console.error(e.message); process.exit(1); });
else {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
  process.exit(1);
}
