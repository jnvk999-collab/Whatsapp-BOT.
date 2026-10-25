# WhatsApp automation for the OIC Premium Calculator

Turns the calculator in the parent folder into a WhatsApp auto-responder.

| Someone sends… | The bot does… |
|---|---|
| Photos or PDFs (RC, Aadhaar, old policy, vehicle pics) | Saves them under `inbox/<contact>/<date>/`, waits for the burst to finish (45 s, or the word **pdf**), merges them into one A4 PDF named `<VEHICLE NUMBER>_<date>.pdf` (read from the photos by local OCR; falls back to `<Name>_<date>_<time>.pdf`) with a cover page (sender, number, group, time, list of contents) and sends it to your own chat |
| `quote bike 125cc 2021 idv 60000` | Parses the line, prices it with the **real calculator** (`../index.html` running in headless Chromium), replies with a premium breakdown **and** the calculator's own quote PDF |
| `quote car 1200cc reg 2019 idv 4.5 lakh zone A ncb 25 zero dep diesel for Ramesh Kumar` | Same, with name, NCB, zone, fuel and add-on picked up |
| `tp only activa 2018` | Third-party-only quote (no IDV needed) |
| `quote please` | Replies listing exactly what is missing (vehicle, CC, year, IDV) |
| `help` | Usage text |
| Anything else | Logged to `inbox/log.jsonl`, no reply, so you handle it yourself |

Every incoming file and every outgoing PDF is written to `inbox/`, so the inbox folder becomes your organised archive, one folder per contact per day, plus a one-line-per-event JSON log you can search.

## How it fits together

```
WhatsApp (your number, linked like WhatsApp Web)
        │  Baileys (direct connection, no browser)
        ▼
     bot.js ─── photo ───▶ lib/organise.js  (save)  ──▶ lib/pdfMerge.js (pdf-lib) ──▶ reply with PDF
        │
        └──── text ─────▶ lib/intents.js  (parse) ──▶ lib/calculator.js ──▶ lib/reply.js ──▶ reply + PDF
                                                          │
                                                headless Chromium running ../index.html
                                                calls calculate() + generatePDF() exactly
                                                like the built-in self-test does
```

**Which calculator does it price with?** In this order: the `CALCULATOR_HTML` setting in `.env` (a file path or a URL such as `https://nvkoicl.github.io/PREMIUM-CALCULATOR/`), otherwise `../index.html` if the bot folder sits inside a calculator folder, otherwise the published site above. Verified against build v82 of the published calculator: the smoke test passes with it unchanged.

The important design choice: **the bot does not re-implement any rating logic.** It opens `index.html` once in headless Chromium and drives it the same way the calculator's own 700-case regression suite does. When you upload a new `index.html` with new rates, the bot prices with the new rates on its next quote. The smoke test proves this by checking one of the calculator's golden cases (₹1,915) through the bot's driver.

## Running it in the cloud (laptop can be off)

On a fresh Ubuntu server (DigitalOcean, Hetzner, AWS Lightsail, any VPS), run as root:

```
curl -fsSL https://raw.githubusercontent.com/jnvk999-collab/PREMIUM-CALCULATOR/claude/whatsapp-photo-pdf-automation-mgr9gu/whatsapp-bot/cloud-setup.sh | sudo bash
```

It installs Node.js and the bot, asks for your name and email settings, installs a systemd service that keeps the bot running and auto-updating, and prints a private link `http://<ip>:8080/<token>/` where you scan the QR and watch the log. Keep that link secret.

## Running it for good (on a laptop)

```
node start.js      # runs in the background, no window
node status.js     # running? version? last log lines
node doctor.js     # why are photos not turning into PDFs? checks everything and says what to fix
node stop.js       # stops it (finishes pending photos first)
```

The background process (`run.js`) restarts the bot if it stops, checks GitHub every 30 minutes and installs updates by itself (finishing any pending photos first), and writes logs to `logs/`. On Windows, `node install-autostart.js` makes it start at every login. `node run.js` runs the same thing in the foreground if you want to watch it.

## Updating by hand

```
node update.js
```

pulls the latest bot files from GitHub into this folder, leaves `.env`, `inbox/` and the login alone, and runs `npm install` when needed. Then restart the bot.

## Setup (on the PC or small server that will stay on)

**Windows:** double-click `setup.bat` once (installs everything, runs the self-test, creates `.env`). Edit `.env` in Notepad. Then double-click `start.bat` and scan the QR (also saved as `qr.png` in this folder).

**Mac / Linux:** run `./setup.sh` once, edit `.env`, then `./start.sh`.

By hand, the same thing is:

```bash
cd whatsapp-bot
npm install
npx playwright install chromium           # only needed for AUTO_QUOTE=1 (one time)
cp .env.example .env                      # then edit AGENT_NAME etc.
npm test                                  # should end with ALL OK
npm start                                 # scan the QR with WhatsApp > Linked devices
```

Keep it running with `pm2 start bot.js --name oic-bot` or a systemd unit. The QR scan is needed once; the login is kept in `baileys_auth/`. If the phone logs the device out, delete that folder and scan again.

Settings (`.env`):

| Key | Meaning | Default |
|---|---|---|
| `AGENT_NAME` | Signature under every quote | empty |
| `MERGE_WAIT_SECONDS` | Quiet period before photos are merged | 45 |
| `REPLY_IN_GROUPS` | `1` to also respond inside groups | 0 |
| `ALLOW_GROUPS` | Group names to respond in (exact, comma-separated); empty = all groups. The bot prints your group names at startup | empty |
| `ALLOW_NUMBERS` | Comma-separated numbers to respond to; empty = everyone. In groups, checked against the message author | empty |
| `AUTO_PDF` | `0` to switch photo merging off | 1 |
| `MIN_PHOTOS` | Make a PDF only when a set has at least this many photos; smaller sets are filed but produce nothing | 3 |
| `PDF_TO` | Where the merged PDF goes: `me` (your own chat), `sender`, or `both` | me |
| `AUTO_QUOTE` | `1` to answer one-line quote requests automatically | 0 (off) |
| `INBOX_DIR` | Where incoming files are stored | `./inbox` |
| `MERGED_DIR` | Where merged PDFs are filed as `<year>/<year-month Month>/<date>/` | `./merged` |
| `OCR_VEHICLE` | Read the vehicle number from the photos (local OCR, free) and name the PDF `<VEHICLE>_<date>.pdf` | 1 |
| `EMAIL_TO` / `EMAIL_FROM` / `EMAIL_APP_PASSWORD` | Also email every merged PDF (Gmail App Password; see `.env.example`) | off |
| `groups.txt` | Written at every start: all groups this number is in | auto |
| `allowed-groups.txt` | If present, only these groups are handled (one name per line); individuals are always handled. Edits apply without restart | none |
| `ignore-list.txt` | Group names and numbers to ignore completely; see `ignore-list.example.txt`. Edits apply without restart | none |
| `email-routes.txt` | Extra (or only) email addresses per group or sender; see `email-routes.example.txt`. Edits apply without restart | none |

## Register and commands

Every merged set adds a row to `merged/register.jsonl` and rebuilds `merged/register/Intake_<YYYY-MM>.xlsx` (date, time, vehicle, sender, number, group, photos, PDFs, pages, file, emailed to, folder link). Open the Excel any time; if it is open while a set arrives, it is rewritten with the next one.

In your own WhatsApp chat ("message yourself") you can type: `help`, `today`, `yesterday`, `count`, `find 8670`, `send 8670`, `resend 8670 to name@gmail.com`.

## Sending policy PDFs back

Drop a policy PDF into `outbox/` (or into your Downloads folder with `WATCH_DOWNLOADS=1`), or forward it from your phone into your own WhatsApp chat. The bot reads the vehicle number from the PDF, finds who sent that vehicle's photos, and asks in your chat: reply `1` (private sender) or `2` (the group), or `no`. `DISPATCH_AUTO=1` sends to the private sender without asking. PDFs with no known vehicle are ignored.

With `MAIL_WATCH=1` the bot also polls your Gmail inbox (IMAP, same App Password) for new mails with PDF attachments, optionally filtered by `MAIL_WATCH_FROM` / `MAIL_WATCH_SUBJECT`, and dispatches those PDFs the same way.

## Policy copy requests

When someone sends a payment-confirmation screenshot (proposal number + amount), the bot reads it, finds the matching policy among the ones it knows (Gmail scan / mail-watch / Downloads), checks the paid amount against the premium, and sends the policy PDF to that chat. If the policy has not arrived yet, the request is parked and fulfilled automatically when the policy mail comes in. Amount mismatches are reported to you instead of sent.

## Daily reminders

`reminders.txt` (created on first start with the attendance reminders) sends fixed messages to your own chat every day. One per line: `start[-end]  [days]  message`, e.g. `10:00-10:15  Mon-Sat  ⏰ Mark attendance now - before 10:15 AM`. The message goes at the start time; if the laptop was off then, it goes as soon as the bot is up, unless the end time has passed. Edits apply within a minute, no restart. `reminders` in your own chat lists them.

## Reading vehicle numbers

Out of the box the bot reads numbers with tesseract.js, which is always available but tries a photo four different ways and can spend over a minute on a bad one. `node ocr-upgrade.js` installs PaddleOCR v4 running through onnxruntime (a one-off 150 MB download, offline afterwards), which looks once, stays around a second or two whatever the photo, and copes far better with sideways or dim pictures. The command then times both readers on your own photos so you can see the difference. `OCR_ENGINE=tesseract` in `.env` forces the built-in one back.

## Catching up on old photos

`node pull-from-phone.js` is the reliable way to get photos off an Android phone: it uses Android's own transfer tool (downloaded from Google on first run) instead of the Windows phone connection, which counts every file before copying and stalls on a folder of twenty thousand. Turn on USB debugging once (Settings > About device > tap Build number seven times > Developer options > USB debugging), plug in, run it, tap Allow on the phone. `--check` reports readiness without copying.

`node copy-from-phone.js` copies the WhatsApp photos off a plugged-in Android phone (Windows only) one file at a time, skipping ones already copied, which avoids the freeze Explorer hits on a folder with thousands of photos. `--since 2026-01` limits how far back, `--dest` chooses where, `--list` just reports what it can see. Stop it with Ctrl+C and run it again to continue.


`node backfill.js <folder> [more folders]` turns photos you already have into merged PDFs, filed under `merged/<year>/<month>/<day>/` like the live ones, with a row each in the monthly Excel register.

On Android, to keep the sender's name: copy `Internal storage\\Android\\media\\com.whatsapp\\WhatsApp\\Media\\WhatsApp Images` off the phone once, then export each chat **without** media (a small text file) into a second folder, and pass both. The text files say who sent which photo and when; the photos come from the media folder. PDFs are named `<VEHICLE>_<Sender>_<date>.pdf`. Photos no chat file accounts for are still merged, grouped by date and named by vehicle number.

On iPhone, export each chat with media, unzip, and pass the unzipped folders.

Options: `--redo` (delete the PDFs an earlier backfill made and build them again), `--undo` (delete and stop), `--since 2025-11-01`, `--until`, `--gap 30` (minutes of quiet that ends a set), `--min 3`, `--only-numbers` (skip group chats), `--no-ocr`, `--dry`. Nothing is emailed or sent on WhatsApp, names and numbers in `ignore-list.txt` are skipped entirely, and re-running continues where it stopped.

## Renewals

Put your renewal sheet in the bot folder as `renewals.xlsx` (columns are found by name: expiry / name / vehicle / policy / mobile). Every day at `RENEWAL_HOUR` the bot sends you, once per policy per milestone, the policies reaching `RENEWAL_MILESTONES` (default 7 days before, 2 days before, and on the day), with phone numbers; `due` or `due 7` in your own chat shows the upcoming list any time. `node scan-policies.js 365` pulls last year's policy PDFs from Gmail, reads policy number, insured, vehicle, period and mobile, and writes `merged/register/Policies.xlsx`; those expiries feed the reminders too.

## Which WhatsApp connection to use

**This bot uses Baileys**, an actively maintained open-source library that speaks WhatsApp's own protocol from your number, the same way WhatsApp Web does. It was chosen after whatsapp-web.js (browser automation) stopped being able to download photos on current WhatsApp Web builds.

Be aware:
- It is unofficial. Meta can ban numbers that look automated. This bot never messages anyone except you by default (`PDF_TO=me`), which keeps it quiet. A **separate SIM** for the bot is the safer long-term setup.
- It needs a machine that stays on and online. No browser is required for the photo merging.

**The official route** is the WhatsApp Business Cloud API (Meta): no ban risk, webhooks, template messages, per-conversation pricing, and a number that is not on the regular WhatsApp app. Only `bot.js` would change; `lib/` is transport-independent.

## What the parser understands

- **Vehicle**: bike/scooty/activa/… → two-wheeler; car/swift/creta/… → private car; tempo/truck/pickup → goods carrier; auto/taxi/bus → passenger (PCCV needs the class, which the parser cannot guess yet, so it asks you to use the app).
- **Slab**: `125cc`, `1200 cc`, `7 kw` (electric), `2500 kg` / `12 ton` for goods.
- **Year**: `2021`, `03/2019`, `15-03-2019`. A bare year is taken as June of that year.
- **IDV**: `idv 60000`, `4.5 lakh`, `60k`, `Rs 4,50,000`.
- **Policy**: `tp only` / `third party`, `od only`, otherwise comprehensive.
- **Zone**: `zone A`, or a metro name; default B.
- **NCB**: `ncb 25`, `25% ncb`, `ncb 2 years`.
- **Add-ons**: `zero dep` / `nil dep`, `engine protect`, `rsa`, `imt 23`.
- **PDF fields**: `for Ramesh Kumar`, registration `TS09 AB 1234`, common model names.

Health and fire products are not wired yet. The calculator exposes `yecCalculate()`, `ohGeneratePDF()` and the fire `calculate()` the same way, so adding them is another driver function in `lib/calculator.js` plus a few parser rules.

## Safety rails already in

- Never replies to its own messages, statuses, or (by default) groups.
- Replies **once** when a photo burst starts, once with the PDF. No per-photo chatter.
- A quote reply always carries "indicative, subject to underwriting".
- If the calculator rejects the input (future date, missing IDV), the bot says what is wrong instead of sending a wrong number.
- Everything is logged; nothing is deleted from the phone.

## Test

`npm test` runs without WhatsApp: golden-case pricing, validation error path, parser cases, an end-to-end car quote, and a 3-image merge with one corrupt file skipped.
