# InsPhoto — deploy & bootstrap

## Architecture note: two hosts, not one

The PRD's original plan was one Supabase Edge Function serving both the
HTML/CSS/JS and the API. That doesn't work: Supabase forces any `text/html`
GET response down to `text/plain` with a sandboxed CSP on the shared
`*.supabase.co` domain — a deliberate anti-phishing measure (confirmed
against the real deployment, and documented in [Supabase's own GitHub
discussions](https://github.com/orgs/supabase/discussions/31238)). JSON/JS/CSS
responses are unaffected — only HTML page loads are rewritten.

So the app is now split:

- **Cloudflare Pages** (`web/`) — the static guest/console/LED/admin pages.
  Free, no plan upgrade, and Cloudflare already hosts `cdn.insphoto.my` for R2.
- **Supabase Edge Function** (`supabase/functions/album`) — a pure JSON API:
  presigned R2 uploads, host auth, moderation, settings, stats, export, the
  admin bootstrap endpoint. Nothing here serves a page anymore.

The two talk over CORS (already permissive on the function) rather than
being same-origin, which is why `web/shared/supabase-init.js` and
`web/admin/index.html` hardcode the full Supabase Functions URL instead of
computing a relative path.

## 1. Install the Supabase CLI

```
npm install -g supabase
supabase login
```

## 2. Link the project

```
supabase link --project-ref pqhstyhtakohvwfjpmmf
```

## 3. Set the R2 secrets

Open `supabase/.env` (already created, `R2_BUCKET`/`R2_PUBLIC_BASE` prefilled)
and fill in the three blanks from the Cloudflare R2 dashboard (`insphoto`
bucket -> Manage R2 API Tokens): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`. That file is gitignored; it never gets committed.
Then push it:

```
supabase secrets set --env-file ./supabase/.env
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
auto-injected into every Edge Function by Supabase — nothing to set there.

## 4. Deploy the API function

```
supabase functions deploy album --no-verify-jwt
```

(`--no-verify-jwt` matches PRD §4's `verify_jwt = false`; `supabase/config.toml`
also declares this so the dashboard stays in sync if you deploy via git push.)

## 5. Deploy the static site to Cloudflare Pages

```
npm install          # pulls in wrangler as a dev dependency, already in package.json
npx wrangler login   # opens a browser for Cloudflare auth
npx wrangler pages project create insphoto --production-branch main
npx wrangler pages deploy web --project-name=insphoto
```

Wrangler prints a `*.pages.dev` URL when it finishes — that's the guest/
console/LED/admin site (e.g. `https://insphoto.pages.dev`). Re-run just the
`deploy` command after any change under `web/`.

**Optional — a nicer domain.** You already own `insphoto.my` and its zone is
active on Cloudflare (per PRD §4, used for `cdn.insphoto.my`). In the
Cloudflare dashboard, open the `insphoto` Pages project → Custom domains →
add something like `app.insphoto.my`. No code change needed; the site works
under any domain since all page-to-page links are relative and only the API
base URL is hardcoded (already absolute, pointing at Supabase).

## 6. Confirm the schema

The schema (PRD §5) is already applied to this project. `supabase/migrations/0001_init.sql`
is a byte-for-byte reference copy for the repo — **do not run it** against
`pqhstyhtakohvwfjpmmf`; it would fail on the already-existing tables anyway.
Sanity check in the SQL editor:

```sql
select key from album_settings;              -- expect create_passcode, token_secret, brand_name
select count(*) from album_events;
```

## 7. Create an event

Visit `https://<your-pages-site>/admin` (e.g. `https://insphoto.pages.dev/admin`).
Enter the seeded `create_passcode` (read it from `album_settings` in the SQL
editor — it's service-role-only, not visible to anon), pick a slug, a name,
and a host PIN. This creates the event row and its PIN hash — there's no
other way to do this, since guests/console have no insert access to
`album_events` or `album_event_secrets` by design.

The admin page hands back three URLs on the Pages site:

- Guest: `/e/<slug>` — put this behind the QR code / send to guests
- Console: `/h/<slug>` — open on the operator's laptop, sign in with the PIN
- LED: `/s/<slug>` — open fullscreen on the second monitor

## 8. Test end to end

1. Open the guest link on a phone, upload a photo — confirm it appears on a
   second phone's Explore tab within a few seconds.
2. Open the console, sign in, confirm the photo shows in the Live Grid.
3. Open the LED page fullscreen — confirm the photo appears there roughly
   `led_delay_seconds` (default 90s) after upload, with a "Just added" badge.
4. In the console, hide or delete that photo — confirm it disappears from
   the guest phone's feed and (if not yet shown) never reaches the LED.
5. Press Esc twice on the console (or the panic button) — confirm the LED
   blanks in under a second.
6. Tap a photo's heart rapidly ~300 times on a phone — check the network
   tab shows only a handful of `album_like` calls, and the like count lands
   on exactly 300 with 1 unique liker.
7. Kill wifi on the LED machine for 30 seconds — confirm it keeps rotating
   cached photos instead of blanking or showing an error.

Steps 1-6 of the deploy were exercised against the live project during
development (event creation, PIN login/token round-trip, and a full R2
presign → PUT → public-CDN-fetch cycle all confirmed working). Step 8's
device-dependent checks — camera capture, HEIC handling, LED timing, wifi
resilience — still need a real phone, laptop, and second screen.
