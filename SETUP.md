# InsPhoto — deploy & bootstrap

Everything in `supabase/functions/album` is written; this is what's left to
actually put it live. None of this was run for you — no Supabase CLI, R2
credentials, or service-role key were available in the build environment.

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
`R2_SECRET_ACCESS_KEY`. PRD §4 already confirms the bucket, custom domain and
CORS are live — only these Edge Function secrets are outstanding. That file
is gitignored; it never gets committed. Then push it:

```
supabase secrets set --env-file ./supabase/.env
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
auto-injected into every Edge Function by Supabase — nothing to set there.

## 4. Deploy the function

```
supabase functions deploy album --no-verify-jwt
```

(`--no-verify-jwt` matches PRD §4's `verify_jwt = false`; `supabase/config.toml`
also declares this so the dashboard stays in sync if you deploy via git push.)

## 5. Confirm the schema

The schema (PRD §5) is already applied to this project. `supabase/migrations/0001_init.sql`
is a byte-for-byte reference copy for the repo — **do not run it** against
`pqhstyhtakohvwfjpmmf`; it would fail on the already-existing tables anyway.
Sanity check in the SQL editor:

```sql
select key from album_settings;              -- expect create_passcode, token_secret, brand_name
select count(*) from album_events;            -- expect 0 before step 6
```

## 6. Create the first event

Visit:

```
https://pqhstyhtakohvwfjpmmf.supabase.co/functions/v1/album/admin
```

Enter the seeded `create_passcode` (read it from `album_settings` in the SQL
editor — it's service-role-only, not visible to anon), pick a slug (e.g.
`mwta72`), a name, and a host PIN. This creates the event row and its PIN
hash — there's no other way to do this, since guests/console have no insert
access to `album_events` or `album_event_secrets` by design.

The admin page hands back three URLs:

- Guest: `.../album/e/<slug>` — put this behind the QR code / send to guests
- Console: `.../album/h/<slug>` — open on the operator's laptop, sign in with the PIN
- LED: `.../album/s/<slug>` — open fullscreen on the second monitor

## 7. (Optional) a shorter URL

The PRD's out-of-scope list defers a custom domain for the app itself
("short link is fine for the test"). If you want one before the October
dinner, point a subdomain at the function via Supabase's custom domain
support, or put a redirect in front of the long `functions/v1/album/...` URL.

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

None of this was exercised in the build environment — it needs real
Supabase/R2 credentials and physical devices, so please run through it before
the MWTA dinner.
