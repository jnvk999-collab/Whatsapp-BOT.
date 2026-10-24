/**
 * Copy WhatsApp photos off an Android phone without Explorer freezing.
 *
 *   node copy-from-phone.js                 (everything from 1 November last year)
 *   node copy-from-phone.js --since 2026-01
 *   node copy-from-phone.js --dest "C:\Users\dell\Desktop\WhatsApp Images"
 *   node copy-from-phone.js --list          (just show what it can see on the phone)
 *   node copy-from-phone.js --max 300       (copy 300 more photos, then stop)
 *   node copy-from-phone.js --path "Internal shared storage/WhatsApp/Media/WhatsApp Images"
 *
 * Explorer reads the whole folder and builds a preview of every photo before it
 * shows you anything, which is what makes it hang on a phone holding thousands
 * of them. This copies one file at a time, skips what is already copied, and
 * keeps printing, so you can stop it with Ctrl+C and run it again any time.
 *
 * The phone must be unlocked and plugged in with "File transfer" chosen on it.
 * Windows only: it uses the same phone connection Explorer uses.
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
const MAX = parseInt(flag('max', '0'), 10) || 0;

if (process.platform !== 'win32') {
  console.error('This one only works on Windows, because it uses the same phone connection Explorer uses.');
  console.error('On a Mac, use Android File Transfer and drag the folder across.');
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });

// Folders to try on the phone, newest Android layout first.
const FORCED = flag('path', '');
const PATHS = FORCED ? [FORCED.split(/[\\/]+/).filter(Boolean)] : [
  ['Internal storage', 'Android', 'media', 'com.whatsapp', 'WhatsApp', 'Media', 'WhatsApp Images'],
  ['Internal shared storage', 'Android', 'media', 'com.whatsapp', 'WhatsApp', 'Media', 'WhatsApp Images'],
  ['Phone', 'Android', 'media', 'com.whatsapp', 'WhatsApp', 'Media', 'WhatsApp Images'],
  ['Internal storage', 'WhatsApp', 'Media', 'WhatsApp Images'],
  ['Internal shared storage', 'WhatsApp', 'Media', 'WhatsApp Images'],
  ['Phone', 'WhatsApp', 'Media', 'WhatsApp Images'],
];
// One statement per candidate. @(@('a','b')) would flatten a single candidate
// into loose strings; the leading comma keeps each one an array of segments.
const psList = PATHS.map(p => "$paths += ,@('" + p.map(x => x.replace(/'/g, "''")).join("','") + "')").join('\n  ');

const ps = `
$ErrorActionPreference = 'Stop'
$dest = '${DEST.replace(/'/g, "''")}'
$sinceNum = ${SINCE_NUM}
$maxFiles = ${MAX}
$listOnly = $${has('list') ? 'true' : 'false'}

$shell = New-Object -ComObject Shell.Application
trap {
  if ($_.Exception.Message -match 'not available|disconnected|RPC|0x800700|device') { Write-Output 'LOSTPHONE' }
  else { Write-Output ("ERROR " + $_.Exception.Message) }
  exit
}

function Find-Child($folder, $name) {
  foreach ($i in $folder.Items()) { if ($i.IsFolder -and $i.Name -eq $name) { return $i.GetFolder } }
  return $null
}
# Explorer hides known extensions, and FolderItem.Name follows that setting, so
# a photo can come back as "IMG-20251115-WA0012" with no .jpg on the end.
function Real-Name($item) {
  $n = ''
  try { $n = $item.ExtendedProperty('System.FileName') } catch { $n = '' }
  if (-not $n) { $n = $item.Name }
  return $n
}
function Is-Photo($name) {
  if ($name -match '\\.(jpg|jpeg|png)$') { return $true }
  if ($name -match '\\.[A-Za-z0-9]{2,4}$') { return $false }   # some other kind of file
  return ($name -match '^(IMG|PHOTO)[-_]')                     # extension hidden by Windows
}
# Does this folder hold actual photos? Look at a few entries only: asking a phone
# folder for its file count makes it list everything first, which looks frozen.
function Has-Photos($folder) {
  $n = 0
  foreach ($i in $folder.Items()) {
    $n++
    if ((-not $i.IsFolder) -and (Is-Photo (Real-Name $i))) { return $true }
    if ($n -ge 60) { break }
  }
  return $false
}

# every device that is not an ordinary drive: that is the phone
$root = $shell.NameSpace(17)
$devices = @()
foreach ($i in $root.Items()) { if ($i.IsFolder -and $i.Path -notmatch '^[A-Za-z]:' ) { $devices += $i } }
if ($devices.Count -eq 0) { Write-Output 'NOPHONE'; exit }
Write-Output ("PHONES " + (($devices | ForEach-Object { $_.Name }) -join ' | '))

$src = $null
$usedPath = ''
foreach ($dev in $devices) {
  $paths = @()
  ${psList}
  foreach ($p in $paths) {
    $cur = $dev.GetFolder
    $ok = $true
    foreach ($seg in $p) {
      $cur = Find-Child $cur $seg
      if ($cur -eq $null) { $ok = $false; break }
    }
    if (-not $ok) { continue }
    $hit = Has-Photos $cur
    Write-Output ("CANDIDATE " + $(if ($hit) { 'photos' } else { 'none' }) + " " + $dev.Name + '/' + ($p -join '/'))
    if ($hit -and $src -eq $null) { $src = $cur; $usedPath = ($dev.Name + '/' + ($p -join '/')) }
  }
}

# Nothing anywhere: show what the phone DOES have, so the folder can be named
if ($src -eq $null) {
  foreach ($dev in $devices) {
    foreach ($mediaPath in @(,@('Internal shared storage','Android','media','com.whatsapp','WhatsApp','Media')) +
                           @(,@('Internal storage','Android','media','com.whatsapp','WhatsApp','Media')) +
                           @(,@('Internal shared storage','WhatsApp','Media')) +
                           @(,@('Internal storage','WhatsApp','Media')) +
                           @(,@('Internal shared storage','Android','media')) +
                           @(,@('Internal storage','Android','media'))) {
      $cur = $dev.GetFolder
      $ok = $true
      foreach ($seg in $mediaPath) { $cur = Find-Child $cur $seg; if ($cur -eq $null) { $ok = $false; break } }
      if (-not $ok) { continue }
      Write-Output ("INSIDE " + $dev.Name + '/' + ($mediaPath -join '/'))
      foreach ($sub in $cur.Items()) {
        $note = ''
        if ($sub.IsFolder) { if (Has-Photos $sub.GetFolder) { $note = ' (has photos)' } else { $note = ' (no photos)' } }
        Write-Output ("   - " + $sub.Name + $note)
      }
    }
  }
  Write-Output 'NOFOLDER'
  exit
}
Write-Output ("FOUND " + $usedPath)

# Walk the folder and one level of subfolders (received photos sit at the top,
# the ones you sent are in Sent). Report as we go so it never looks frozen.
$queue = New-Object System.Collections.Queue
$queue.Enqueue($src)
$wanted = New-Object System.Collections.ArrayList
$seen = 0; $already = 0; $depth = 0; $samples = 0; $rejType = 0; $rejOld = 0
while ($queue.Count -gt 0) {
  $folder = $queue.Dequeue()
  $depth++
  foreach ($i in $folder.Items()) {
    $seen++
    if ($seen % 200 -eq 0) { Write-Output ("SCAN " + $seen + " " + $wanted.Count) }
    if ($i.IsFolder) { if ($depth -le 1) { $queue.Enqueue($i.GetFolder) }; continue }
    $nm = Real-Name $i
    # Show the first few so a filter that rejects everything is visible, not a mystery
    if ($samples -lt 12) {
      $samples++
      $d8 = [regex]::Match($nm, '(\\d{8})')
      Write-Output ("SAMPLE name=[" + $nm + "] shellName=[" + $i.Name + "] photo=" + (Is-Photo $nm) + " datefound=" + $(if ($d8.Success) { $d8.Groups[1].Value } else { 'none' }))
    }
    if (-not (Is-Photo $nm)) { $rejType++; continue }
    $m = [regex]::Match($nm, '(\\d{8})')
    if ($m.Success) { if ([int]$m.Groups[1].Value -lt $sinceNum) { $rejOld++; continue } }
    # count the cap against files that still need copying, so every run makes progress
    if (Test-Path -LiteralPath (Join-Path $dest $nm)) { $already++; continue }
    [void]$wanted.Add($i)
    if ($maxFiles -gt 0 -and $wanted.Count -ge $maxFiles) { Write-Output ("CAPPED " + $maxFiles); break }
  }
  if ($maxFiles -gt 0 -and $wanted.Count -ge $maxFiles) { break }
}
Write-Output ("TOTAL " + $seen)
Write-Output ("REJECT notphoto=" + $rejType + " tooold=" + $rejOld)
Write-Output ("HAVE " + $already)
Write-Output ("WANTED " + $wanted.Count)
if ($listOnly) { exit }

$destNs = $shell.NameSpace($dest)
$n = 0; $copied = 0; $failed = 0
foreach ($i in $wanted) {
  $n++
  $nm = Real-Name $i
  $target = Join-Path $dest $nm
  $srcSize = 0
  try { $srcSize = [int64]$i.ExtendedProperty('System.Size') } catch { $srcSize = 0 }
  # a half-copied file must not pass for a copied one, or it is skipped for ever
  if (Test-Path -LiteralPath $target) {
    $have = (Get-Item -LiteralPath $target).Length
    if ($srcSize -le 0 -or $have -eq $srcSize) { continue }
    Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
  }
  $done = $false
  for ($try = 1; $try -le 3 -and -not $done; $try++) {
    try {
      $destNs.CopyHere($i, 20)
      $waited = 0
      while ($waited -lt 900) {
        Start-Sleep -Milliseconds 100
        $waited++
        if (Test-Path -LiteralPath $target) {
          $have = (Get-Item -LiteralPath $target).Length
          if ($srcSize -le 0) { if ($have -gt 0) { Start-Sleep -Milliseconds 300; $done = $true; break } }
          elseif ($have -eq $srcSize) { $done = $true; break }
        }
      }
    } catch { Start-Sleep -Seconds 2 }
    if (-not $done -and (Test-Path -LiteralPath $target)) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }
  }
  if ($done) { $copied++ } else { $failed++; Write-Output ("FAIL " + $nm) }
  if (($copied + $failed) % 25 -eq 0) { Write-Output ("PROGRESS " + $n + "/" + $wanted.Count + " copied=" + $copied + " failed=" + $failed) }
}
Write-Output ("DONE copied=" + $copied + " already=" + $already + " failed=" + $failed)
`;

console.log(`Copying WhatsApp photos from ${SINCE} onwards`);
console.log(`into ${DEST}\n`);
console.log('The phone must be unlocked, plugged in, and set to "File transfer".');
console.log('You can stop this with Ctrl+C and run it again; it carries on where it stopped.\n');

const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.write(ps);
child.stdin.end();

let tail = '', samplesShown = false;
const show = (chunk) => {
  tail += chunk.toString();
  let i;
  while ((i = tail.indexOf('\n')) >= 0) {
    const line = tail.slice(0, i).trim();
    tail = tail.slice(i + 1);
    if (!line) continue;
    if (line.startsWith('NOPHONE')) console.log('No phone found. Unlock it, and on the phone choose "File transfer" for the USB connection, then run this again.');
    else if (line.startsWith('PHONES ')) console.log('Phone seen: ' + line.slice(7));
    else if (line.startsWith('CANDIDATE ')) { const r = line.slice(10); const j = r.indexOf(' '); console.log(`  ${(r.slice(0, j) === 'photos' ? 'has photos' : 'no photos ').padEnd(11)} ${r.slice(j + 1)}`); }
    else if (line.startsWith('INSIDE ')) console.log('\nWhat the phone has in ' + line.slice(7) + ':');
    else if (line.startsWith('   - ')) console.log(line);
    else if (line.startsWith('NOFOLDER')) console.log('\nNo WhatsApp photos found through this connection.\nSend me the list above and I will point it at the right folder with --path.\nIf there is no list at all, the phone is in "Charging only" mode: tap the USB notification on the phone and choose File transfer.');
    else if (line.startsWith('FOUND ')) console.log('Reading ' + line.slice(6) + '\n');
    else if (line.startsWith('SCAN ')) { const [, seen, want] = line.split(' '); process.stdout.write(`\r  reading the phone... ${seen} seen, ${want} to copy   `); }
    else if (line.startsWith('CAPPED ')) console.log(`\n  stopping the scan at ${line.slice(7)} new photos (--max)`);
    else if (line.startsWith('SAMPLE ')) { if (!samplesShown) { console.log('\n  a few of the file names on the phone:'); samplesShown = true; } console.log('    ' + line.slice(7)); }
    else if (line.startsWith('LOSTPHONE')) console.log('\nThe phone disconnected part-way. Unlock it, choose "File transfer" again, and run the same command: it carries on from where it stopped.');
    else if (line.startsWith('ERROR ')) console.log('\nThe phone connection gave an error: ' + line.slice(6) + '\nUnplug, plug back in, choose "File transfer", and run it again.');
    else if (line.startsWith('REJECT ')) { const m = line.match(/notphoto=(\d+) tooold=(\d+)/); if (m) console.log(`  ${m[1]} were not photos, ${m[2]} were older than ${SINCE}`); }
    else if (line.startsWith('TOTAL ')) console.log('\n' + line.slice(6) + ' file(s) read on the phone');
    else if (line.startsWith('HAVE ')) { if (+line.slice(5)) console.log(line.slice(5) + ' already copied before, skipping those'); }
    else if (line.startsWith('WANTED ')) console.log(line.slice(7) + ' photo(s) to copy from ' + SINCE + ' onwards\n');
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
