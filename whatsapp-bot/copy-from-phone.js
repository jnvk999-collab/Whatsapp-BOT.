/**
 * Copy WhatsApp photos off an Android phone without Explorer freezing.
 *
 *   node copy-from-phone.js                 (everything from 1 November last year)
 *   node copy-from-phone.js --since 2026-01
 *   node copy-from-phone.js --dest "C:\Users\dell\Desktop\WhatsApp Images"
 *   node copy-from-phone.js --list          (just show what it can see on the phone)
 *
 * Explorer tries to read the whole folder at once and build previews, which is
 * what makes it hang on a phone with thousands of photos. This copies one file
 * at a time, skips the ones already copied, and prints progress, so you can
 * stop it with Ctrl+C and run it again whenever you like.
 *
 * The phone must be plugged in with "File transfer" chosen on its screen.
 * Windows only (it uses the same connection Explorer uses).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = n => argv.includes('--' + n);

const home = process.env.USERPROFILE || process.env.HOME || '.';
const DEST = path.resolve(flag('dest', path.join(home, 'Desktop', 'WhatsApp Images')));
const lastNov = () => { const n = new Date(); const y = n.getMonth() >= 10 ? n.getFullYear() : n.getFullYear() - 1; return `${y}-11`; };
const SINCE = (flag('since', lastNov()) + '-01').slice(0, 10);
const SINCE_NUM = parseInt(SINCE.replace(/-/g, '').slice(0, 8), 10);   // 20251101

if (process.platform !== 'win32') {
  console.error('This one only works on Windows, because it uses the same phone connection Explorer uses.');
  console.error('On a Mac, use Android File Transfer and drag the folder across.');
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });

// Folders to try on the phone, newest Android layout first.
const PATHS = [
  ['Internal storage', 'Android', 'media', 'com.whatsapp', 'WhatsApp', 'Media', 'WhatsApp Images'],
  ['Internal shared storage', 'Android', 'media', 'com.whatsapp', 'WhatsApp', 'Media', 'WhatsApp Images'],
  ['Phone', 'Android', 'media', 'com.whatsapp', 'WhatsApp', 'Media', 'WhatsApp Images'],
  ['Internal storage', 'WhatsApp', 'Media', 'WhatsApp Images'],
  ['Internal shared storage', 'WhatsApp', 'Media', 'WhatsApp Images'],
  ['Phone', 'WhatsApp', 'Media', 'WhatsApp Images'],
];
const psList = PATHS.map(p => "@('" + p.join("','") + "')").join(',');

const ps = `
$ErrorActionPreference = 'Stop'
$dest = '${DEST.replace(/'/g, "''")}'
$sinceNum = ${SINCE_NUM}
$listOnly = $${has('list') ? 'true' : 'false'}

$shell = New-Object -ComObject Shell.Application
function Find-Child($folder, $name) {
  foreach ($i in $folder.Items()) { if ($i.IsFolder -and $i.Name -eq $name) { return $i.GetFolder } }
  return $null
}

# every device that is not an ordinary drive: that is the phone
$root = $shell.NameSpace(17)
$devices = @()
foreach ($i in $root.Items()) { if ($i.IsFolder -and $i.Path -notmatch '^[A-Za-z]:' ) { $devices += $i } }
if ($devices.Count -eq 0) {
  Write-Output 'NOPHONE'
  exit
}
Write-Output ("PHONES " + (($devices | ForEach-Object { $_.Name }) -join ' | '))

$src = $null
$usedPath = ''
foreach ($dev in $devices) {
  $paths = @(${psList})
  foreach ($p in $paths) {
    $cur = $dev.GetFolder
    $ok = $true
    foreach ($seg in $p) {
      $cur = Find-Child $cur $seg
      if ($cur -eq $null) { $ok = $false; break }
    }
    if ($ok) { $src = $cur; $usedPath = ($dev.Name + '/' + ($p -join '/')); break }
  }
  if ($src -ne $null) { break }
}
if ($src -eq $null) { Write-Output 'NOFOLDER'; exit }
Write-Output ("FOUND " + $usedPath)

# One pass over the folder. Growing an array with += copies it every time, which
# is what makes this crawl on a phone holding thousands of photos.
$all = $src.Items()
Write-Output ("TOTAL " + $all.Count)

$wanted = New-Object System.Collections.ArrayList
foreach ($i in $all) {
  if ($i.IsFolder) { continue }
  if ($i.Name -notmatch '\\.(jpg|jpeg|png)$') { continue }
  $m = [regex]::Match($i.Name, '(\\d{8})')
  if ($m.Success) { if ([int]$m.Groups[1].Value -lt $sinceNum) { continue } }
  [void]$wanted.Add($i)
}
Write-Output ("WANTED " + $wanted.Count)
if ($listOnly) { exit }

$destNs = $shell.NameSpace($dest)
$n = 0; $copied = 0; $skipped = 0; $failed = 0
foreach ($i in $wanted) {
  $n++
  $target = Join-Path $dest $i.Name
  if (Test-Path -LiteralPath $target) { $skipped++; if ($skipped % 200 -eq 0) { Write-Output ("SKIP " + $skipped) }; continue }
  $done = $false
  for ($try = 1; $try -le 3 -and -not $done; $try++) {
    try {
      $destNs.CopyHere($i, 20)
      $waited = 0
      while (-not (Test-Path -LiteralPath $target) -and $waited -lt 600) { Start-Sleep -Milliseconds 100; $waited++ }
      if (Test-Path -LiteralPath $target) { $done = $true }
    } catch { Start-Sleep -Seconds 2 }
  }
  if ($done) { $copied++ } else { $failed++; Write-Output ("FAIL " + $i.Name) }
  if (($copied + $failed) % 25 -eq 0) { Write-Output ("PROGRESS " + $n + "/" + $wanted.Count + " copied=" + $copied + " failed=" + $failed) }
}
Write-Output ("DONE copied=" + $copied + " already=" + $skipped + " failed=" + $failed)
`;

console.log(`Copying WhatsApp photos from ${SINCE} onwards`);
console.log(`into ${DEST}\n`);
console.log('The phone must be unlocked, plugged in, and set to "File transfer".');
console.log('You can stop this with Ctrl+C and run it again; it carries on where it stopped.\n');

const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.write(ps);
child.stdin.end();

let tail = '';
const show = (chunk) => {
  tail += chunk.toString();
  let i;
  while ((i = tail.indexOf('\n')) >= 0) {
    const line = tail.slice(0, i).trim();
    tail = tail.slice(i + 1);
    if (!line) continue;
    if (line.startsWith('NOPHONE')) console.log('No phone found. Unlock it, and on the phone choose "File transfer" for the USB connection, then run this again.');
    else if (line.startsWith('PHONES ')) console.log('Phone seen: ' + line.slice(7));
    else if (line.startsWith('NOFOLDER')) console.log('The phone is connected but I could not find the WhatsApp Images folder on it.\nOpen the phone in Explorer and tell me the path you see.');
    else if (line.startsWith('FOUND ')) console.log('Reading ' + line.slice(6) + '\n');
    else if (line.startsWith('TOTAL ')) console.log(line.slice(6) + ' file(s) on the phone');
    else if (line.startsWith('WANTED ')) console.log(line.slice(7) + ' of them are photos from ' + SINCE + ' onwards\n');
    else if (line.startsWith('SKIP ')) console.log('  ' + line.slice(5) + ' already copied, skipping...');
    else if (line.startsWith('PROGRESS ')) console.log('  ' + line.slice(9));
    else if (line.startsWith('FAIL ')) console.log('  could not copy ' + line.slice(5) + ' (it will be tried again next run)');
    else if (line.startsWith('DONE ')) {
      console.log('\n' + line.slice(5).replace('copied=', 'copied ').replace('already=', ', already there ').replace('failed=', ', failed '));
      console.log(`\nThe photos are in ${DEST}`);
      console.log('Now make the PDFs with:   node backfill.js --since ' + SINCE + ' --dry');
    } else console.log(line);
  }
};
child.stdout.on('data', show);
child.stderr.on('data', d => console.error('powershell: ' + d.toString().trim().split('\n')[0]));
child.on('exit', c => { if (c) console.error('\nStopped with code ' + c + '. Run it again and it will carry on.'); });
