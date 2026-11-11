param(
  [string]$From = '',                                  # the address "node migrate.js send" printed
  [string]$Dest = "$env:USERPROFILE\Desktop\OIC-WhatsApp-Bot"
)

# Sets up the OIC WhatsApp bot on a new Windows PC in one go: installs Node.js
# if it is missing, downloads the bot, pulls your settings and PDFs from the old
# computer, installs everything and starts it.
#
# Run it with the line that "node migrate.js send" printed on the old computer.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Branch = 'claude/whatsapp-photo-pdf-automation-mgr9gu'
$Zip = 'https://codeload.github.com/jnvk999-collab/PREMIUM-CALCULATOR/zip/refs/heads/' + $Branch

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }

Write-Host 'OIC WhatsApp bot - setting up this computer' -ForegroundColor Green
Write-Host '==========================================='

# 1. Node.js
Step 1 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '    not installed; trying winget...'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Get-Command node -ErrorAction SilentlyContinue
  }
}
if (-not $node) {
  Write-Host '    Could not install Node.js automatically.' -ForegroundColor Yellow
  Write-Host '    Install it from https://nodejs.org (the LTS button), then run this again.'
  exit 1
}
Write-Host ('    ' + (node -v))

# 2. the bot itself
Step 2 'Downloading the bot'
$tmp = Join-Path $env:TEMP ('oic-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$zipFile = Join-Path $tmp 'bot.zip'
Invoke-WebRequest -Uri $Zip -OutFile $zipFile
Expand-Archive -LiteralPath $zipFile -DestinationPath $tmp -Force
$botSrc = Get-ChildItem -Path $tmp -Recurse -Directory -Filter 'whatsapp-bot' | Select-Object -First 1
if (-not $botSrc) { Write-Host '    The download did not contain a whatsapp-bot folder.' -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Path $Dest -Force | Out-Null
Copy-Item -Path (Join-Path $botSrc.FullName '*') -Destination $Dest -Recurse -Force
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Set-Location $Dest
Write-Host ('    installed in ' + $Dest)

# 3. your own files from the old computer
if ($From) {
  Step 3 'Copying your settings and PDFs from the old computer'
  node migrate.js receive $From
  if ($LASTEXITCODE -ne 0) {
    Write-Host '    That did not finish. Check "node migrate.js send" is still running on the old PC,' -ForegroundColor Yellow
    Write-Host '    then run:  node migrate.js receive ' + $From
  }
} else {
  Step 3 'Skipping the copy (no address given)'
  Write-Host '    On the old computer run "node migrate.js send", then here run:'
  Write-Host '      node migrate.js receive <the address it prints>'
}

# 4. packages
Step 4 'Installing packages (a few minutes)'
cmd /c 'npm install --no-audit --no-fund'

# 5. the better number reader
Step 5 'Installing the vehicle-number reader (about 150 MB, once)'
node ocr-upgrade.js
if ($LASTEXITCODE -ne 0) { Write-Host '    Skipped; the built-in reader will be used. You can run node ocr-upgrade.js later.' -ForegroundColor Yellow }

# 6. check and start
Step 6 'Checking everything'
node doctor.js

Step 7 'Starting the bot and setting it to start with Windows'
node start.js
node install-autostart.js

Write-Host "`nDone." -ForegroundColor Green
Write-Host "The bot folder is $Dest"
Write-Host ''
Write-Host 'Now on the OLD computer:' -ForegroundColor Cyan
Write-Host '  1. Press Ctrl+C to stop "node migrate.js send".'
Write-Host '  2. Run: node stop.js'
Write-Host '  3. On your phone: WhatsApp > Settings > Linked devices > remove the old computer.'
Write-Host ''
Write-Host 'If anything looks wrong here, run: node doctor.js'
