# Moving the bot to another computer

The program comes from GitHub; only your own things travel. One command packs
them, one unzip puts them back.

## What travels, and what does not

| Travels (only exists on the old PC) | Does not (downloaded fresh) |
| --- | --- |
| `.env` — your settings and Gmail app password | the bot's code |
| `baileys_auth/` — the WhatsApp login | `node_modules/` |
| `allowed-groups.txt`, `ignore-list.txt`, `email-routes.txt` | `.tessdata/` (number reader data) |
| `reminders.txt` — your daily reminders | `platform-tools/` (the phone tool) |
| `renewals.xlsx` — the renewal sheet | `logs/` |
| `merged/` — the PDFs, the Excel register, the policy list | |
| `groups-cache.json`, `inbox/processed.json` | |

`Desktop\WhatsApp Images`, the photos pulled off the phone, is **not** packed.
It is only needed if you want to run the backfill again. Copy it separately, or
leave it behind.

## On the old computer

```
cd C:\Users\dell\Desktop\PREMIUM-CALCULATOR-claude-whatsapp-photo-pdf-automation-mgr9gu\whatsapp-bot
node stop.js
node pack.js
```

You get `oic-bot-migration-<date>.zip` on the Desktop, usually a few MB and a
few seconds. Anything over 200 MB, which in practice means the `merged` folder
of PDFs, is deliberately left out and listed on screen instead: drag those
folders onto the pen drive as they are. PDFs are already compressed, so zipping
four gigabytes of them only costs an hour and saves nothing.

`--no-merged` leaves the PDFs behind altogether; `--all` forces even the big
folders into the zip if you really want one file.

The zip holds your Gmail app password and your WhatsApp login. Carry it on a
pen drive, not by email, and delete it from both computers afterwards.

## On the new computer

1. **Node.js** — install from [nodejs.org](https://nodejs.org), the LTS button.
   Accept the defaults.

2. **The bot** — download
   [the branch zip](https://github.com/jnvk999-collab/PREMIUM-CALCULATOR/archive/refs/heads/claude/whatsapp-photo-pdf-automation-mgr9gu.zip),
   unzip it to the Desktop. Inside is a `whatsapp-bot` folder; that is the one
   that matters.

3. **Your things** — unzip the migration zip **into that same `whatsapp-bot`
   folder**, keeping the folder names. Windows will ask about merging folders:
   say yes. Then copy any folders the packer listed on screen (normally
   `merged`) into that folder too.

4. **Install and start** — open `cmd` in that folder (type `cmd` in the address
   bar of the folder and press Enter), then one at a time:

   ```
   npm install
   node ocr-upgrade.js
   node doctor.js
   node start.js
   node install-autostart.js
   ```

   `npm install` takes a few minutes. `ocr-upgrade.js` downloads the number
   reader, about 150 MB, once. `doctor.js` should say everything is fine and
   name your groups. `install-autostart.js` makes it start with Windows.

5. **Check WhatsApp** — if `doctor.js` says the phone is not linked, open
   `qr.png` in the folder and scan it from WhatsApp, Settings, Linked devices.
   The login usually travels fine, so most of the time there is nothing to do.

## On the old computer, once the new one works

```
node stop.js
```

Then, on the phone, WhatsApp, Settings, Linked devices, remove the old
computer. Two bots on one number fight each other and both get dropped.

Delete the migration zip from both machines.

## If something is wrong

`node doctor.js` names the problem in plain words: bot not running, WhatsApp
not linked, a group name that matches nothing, the number reader missing. Run
it first, and send the output if it still does not make sense.
