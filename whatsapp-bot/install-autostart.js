/**
 * Makes the bot start automatically when you log in to Windows.
 *   node install-autostart.js          -> install
 *   node install-autostart.js remove   -> remove
 *
 * It tries Task Scheduler first. On a computer where that needs administrator
 * rights it falls back to a shortcut in your Startup folder, which needs none
 * and starts the bot at login just the same.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TASK = 'OIC_WhatsApp_Bot';
if (process.platform !== 'win32') {
  console.log('This installer is for Windows. On Mac/Linux use pm2: npx pm2 start run.js --name oic-bot');
  process.exit(0);
}
const remove = process.argv[2] === 'remove';
const startJs = path.join(__dirname, 'start.js');
const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const vbs = path.join(startupDir, 'OIC WhatsApp Bot.vbs');

function viaTaskScheduler() {
  const args = remove
    ? ['/Delete', '/TN', TASK, '/F']
    : ['/Create', '/F', '/TN', TASK, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', `"${process.execPath}" "${startJs}"`];
  const r = spawnSync('schtasks.exe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0;
}

/** A tiny script in the Startup folder; wscript runs it with no window. */
function viaStartupFolder() {
  try {
    if (remove) { if (fs.existsSync(vbs)) fs.unlinkSync(vbs); return true; }
    if (!startupDir || !fs.existsSync(startupDir)) return false;
    // In VBScript a quote inside a string is written as two quotes.
    const inner = t => '""' + t + '""';
    const command = '"' + inner(process.execPath) + ' ' + inner(startJs) + '"';
    fs.writeFileSync(vbs, [
      'Set WshShell = CreateObject("WScript.Shell")',
      'WshShell.CurrentDirectory = "' + __dirname + '"',
      'WshShell.Run ' + command + ', 0, False',
      '',
    ].join('\r\n'));
    return fs.existsSync(vbs);
  } catch { return false; }
}

if (remove) {
  const a = viaTaskScheduler(), b = viaStartupFolder();
  console.log(a || b ? 'Autostart removed.' : 'Nothing to remove.');
  process.exit(0);
}

if (viaTaskScheduler()) {
  try { if (fs.existsSync(vbs)) fs.unlinkSync(vbs); } catch {}      // don't start it twice
  console.log(`Done. "${TASK}" will start the bot at every login.`);
  console.log('To start it now: node start.js');
} else if (viaStartupFolder()) {
  console.log('Task Scheduler needed administrator rights, so I used your Startup folder instead.');
  console.log('Same result: the bot starts when you log in, with no window.');
  console.log('  ' + vbs);
  console.log('To start it now: node start.js');
} else {
  console.log('Could not set up automatic starting.');
  console.log('Either right-click the terminal, choose "Run as administrator" and run this again,');
  console.log('or make a shortcut to start.js by hand in this folder:');
  console.log('  ' + startupDir);
  process.exit(1);
}
