# Binho Season

Scoreboard, standings, and season tracker for an office Binho league.

Live scoring with a game clock and sudden death, per-opponent head-to-head, power up and
event card stats, championship belt, and a separate all-time record for standard Binho.
The Google Sheet is the database, so every result is also a spreadsheet row you can sort,
chart, or export.

---

## How it fits together

```
  phones + laptops          Apps Script web app           Google Sheet
  ────────────────          ───────────────────           ────────────
  index.html        ──────► doPost()  checks role ──────► Log      (one row per match)
  (GitHub Pages)    ◄────── returns league state ◄─────── State    (roster, settings)
                                                          Photos   (player pictures)
```

The browser never writes to the sheet directly. It asks the Apps Script to, and the script
decides whether that caller is allowed. That is why the roles below actually hold.

---

## Setup

### 1. The backend

1. Open your season workbook in Google Sheets.
2. **Extensions → Apps Script**, delete the sample code, paste in `apps-script/binho-api.gs`, save.
3. Run `setup()` once and authorize it. The "unverified app" screen is expected for your own
   script — Advanced → Go to project.
4. **Copy the admin passcode and recovery code from the execution log.** They are printed once
   and only stored as hashes.
5. **Deploy → New deployment → Web app.** Execute as **Me**, Who has access **Anyone**. Copy the
   URL ending in `/exec`.
6. Run `selfTest()` to confirm reads, writes, and a rejected unauthorized write. Delete the test
   row from the Log tab afterward.

### 2. The site

1. Create a repository and put these files in it.
2. Paste your `/exec` URL into `config.js`.
3. **Settings → Pages**, source: deploy from branch, `main` / root. GitHub gives you a URL in
   about a minute.
4. Open it, sign in with the admin passcode, and set a manager passcode from Setup.

Every push to `main` republishes. Nobody needs a new link.

### 3. On phones

Open the site in Safari or Chrome and add it to the home screen. It installs as an app —
full screen, own icon, and it opens offline. Recording a game still needs a connection,
since the data lives in the sheet.

---

## Roles

| | Guest | Manager | Admin |
|---|---|---|---|
| View standings, H2H, log | ✓ | ✓ | ✓ |
| Record a game, live or by hand | ✓ | ✓ | ✓ |
| Set player photos | ✓ | ✓ | ✓ |
| Add/remove players, set membership | | ✓ | ✓ |
| Change scoring and clock settings | | ✓ | ✓ |
| Delete a logged match | | ✓ | ✓ |
| End a season and crown a champion | | | ✓ |
| Erase all data | | | ✓ |
| Set passcodes | | | ✓ |

Sessions last 12 hours and are per device. Guests need no sign-in at all, which is the point:
the people playing should be able to record a game without a login.

If the admin passcode is lost, sign in with the recovery code. That signs you in as admin and
issues a fresh passcode and recovery code, both shown once.

---

## Security, honestly

**What holds:** roster, season, settings, and passcode changes are enforced by the Apps Script.
Editing the page source or calling the API directly will not get you past them. Passcodes are
stored as salted SHA-256 hashes in Script Properties and never sent to the browser.

**What does not:** the `/exec` URL is public by necessity, so anyone with the link can read the
league and record a match. That is the guest role working as designed. Treat a bogus result as
you would a bogus score written on a whiteboard — a manager deletes it from the Log.

**Do not** put the `/exec` URL anywhere you would not put a read-only view of the league.

---

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app — markup, styles, and logic in one file |
| `config.js` | Your API URL. The only thing you edit after setup |
| `manifest.webmanifest` | Makes it installable on a phone |
| `sw.js` | Service worker: caches the app shell for offline opening |
| `icon.svg` | App icon |
| `apps-script/binho-api.gs` | The backend. Lives in the sheet, not in this repo's deploy |

---

## House rules this encodes

- Regulation ends on the clock or the score limit, whichever lands first.
- Sudden death starts the moment the score is level at the tie mark (5 by default), or when
  regulation expires level at any score. Next goal wins, and every full minute the app stops the
  clock so each player removes a field peg.
- A five-goal lead flags the mercy rule.
- Two yellows become a red, tracked separately from straight reds.
- An own goal counts for the opponent and costs the scorer a peg — a house addition, so it does
  not apply in standard Binho games.
- Standard Binho follows the official rules and is never mixed into league standings.

Official Binho rules: https://binhoboard.com/pages/how-to-play

---

## Roadmap

- **Supabase** when the passcode model outgrows itself — real accounts, per-user identity, and
  standings that scale past one office.
- **App store** would need native surface beyond a wrapped web page — push notifications for
  challenges, offline recording that syncs later. The installed PWA covers most of the value first.
