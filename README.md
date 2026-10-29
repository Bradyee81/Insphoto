# InsPhoto

A live event photo wall. Guests scan a QR code to see and share photos, a
photographer uploads from a laptop, and the big screen shows the best of it —
with a built-in **Best Dress** contest the room votes on from their phones.

## Download the console app

**[⬇ Download InsPhoto Console for Windows](https://github.com/Bradyee81/Insphoto/releases/latest)**
— open the latest release and click the `…x64-setup.exe` file under **Assets**.

Run the installer — it installs for your user only, no admin rights needed. If
Windows shows *"Windows protected your PC"*, click **More info → Run anyway**
(the app isn't code-signed).

On first launch, type your event code, then sign in with your host PIN. Press
**🖥 Open screen** to put the big-screen view full screen on the second display.
The app always loads the latest console, so it rarely needs reinstalling.

## Who uses what

| Who | Where | Link |
|---|---|---|
| Host / operator | **InsPhoto Console** app (or a browser) | `insphoto.pages.dev/h/<event>` |
| Big screen | Opened by the console app, or a browser on the screen PC (F11) | `insphoto.pages.dev/s/<event>` |
| Photographer | Browser on their laptop, with the photographer PIN | `insphoto.pages.dev/p/<event>` |
| Guests | Phone browser — scan the QR on the screen | `insphoto.pages.dev/e/<event>` |

## What it does

**Guests (phone)** — browse the album live, upload from camera or gallery,
like photos, see the ranking, vote in the Best Dress final. No login, no app.

**Photographer (laptop)** — drag in a folder of JPEGs (no RAW). Three uploads
at a time; each photo is in the album within seconds and its full-resolution
original follows in the background. Re-dropping the same files skips them.

**Console (host)**
- Live grid of every photo, filter by photographer / guests / featured
- ★ **Feature** a photo, 📺 **show one photo on screen now**, hide, delete
- Big-screen scenes: photo wall, ranking, Best Dress, one photo, blank
- **Featured only** mode — the wall shows only photos you star
- **Panic**: press Esc twice to blank the screen
- Photographer PIN, branding, upload/moderation switches, QR download
- After the event: allow full-quality downloads, download every photo to a folder

**Best Dress contest**
1. *Round 1 (during dinner)* — guests like photos; the console ranks them by
   **how many people** liked each. The host can add votes as a safety net
   (shown only in the console) and picks the contestants. The emcee's cutoff =
   **Close nominations**, which freezes the ranking.
2. *Round 2 (on stage)* — counting restarts at zero. Every phone opens the vote,
   the screen shows the contestants with big live numbers and a countdown.
   Up to 1,000 likes per phone per contestant. **STOP ALL LIKES** or the timer
   ends it; the winner gets a crown. While voting is open the console cannot
   change any numbers.
3. Every step is recorded — download the log as a CSV.

## Before an event

1. Console → **Event Setup**: set the photographer PIN, check branding, download the QR.
2. Rehearse once on real phones and the real screen (upload, feature, show on
   screen, a 30-second Best Dress round, then **Reset contest**).
3. Screen PC/laptop: turn off sleep and Windows updates, keep the clock on
   automatic time, have a phone hotspot as backup.

## How it's built

- **Cloudflare Pages** (`web/`) — the guest, console, screen and photographer pages
- **Supabase** — database, realtime updates, and the `album` Edge Function API
  (`supabase/functions/album`)
- **Cloudflare R2** (`cdn.insphoto.my`) — photo storage
- **Tauri 2** (`console-app/`) — the Windows console app

Deploy and setup steps are in [SETUP.md](SETUP.md); the full product spec is in
[insphotoPRD.md](insphotoPRD.md).

### Releasing a new console app version

Only needed when something under `console-app/` changes — console page changes
go live through Cloudflare Pages without a new app.

1. Bump `version` in `console-app/package.json` and `console-app/src-tauri/Cargo.toml`.
2. Commit, push, then push a tag: `git tag console-v0.2.0 && git push origin console-v0.2.0`.
3. GitHub Actions builds the installer and publishes the release (about 10 minutes).
