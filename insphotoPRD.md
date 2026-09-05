# PRD — InsPhoto (Event Photo Wall)

**Type:** Claude Code build brief. Not investor-facing.
**Module:** part of the wider event management suite (see project brief).
**Working name:** InsPhoto
**Status:** Sprint 1 ready to build. Supabase project created and **schema applied** (§5) — verify, don't recreate. Storage is Cloudflare R2 from day one.
**First live test:** MWTA 72nd Annual Dinner, October 2026, ~420 pax.

---

## 1. What this is

A guest photo wall for dinner events. Guests scan a QR at their table, land on an Instagram-style photo feed in the phone browser — no app, no signup — and upload, like, share and download photos. An operator runs the room from a Windows PC console and drives a live wall on the ballroom LED screen.

Built for a Malaysian dinner-event management company running events repeatedly, not for a one-off wedding.

**Three surfaces, one database:**

| Surface                         | User            | Device                  | Install                       |
| ------------------------------- | --------------- | ----------------------- | ----------------------------- |
| Guest app                       | ~420 guests     | phone browser           | no                            |
| Console                         | 1 operator      | Windows PC browser      | no                            |
| LED display                     | the big screen  | 2nd monitor, fullscreen | no — a URL the console drives |
| Watch-folder agent _(Sprint 3)_ | camera operator | Windows PC              | yes, small .exe               |

Operator capabilities must never ship inside the guest bundle.

---

## 2. Goals

1. A guest goes from QR scan to first upload in under 20 seconds, with no account.
2. The wall feels alive — new photos appear on other guests' phones and the LED within seconds.
3. Nothing inappropriate reaches a 20-foot screen in front of State guests.
4. Best-dressed style contests can be run and defended — the ranking must not be gameable by one fast thumb.
5. The event company gets an automatic sponsor impression report after the night.

**Non-goals for MVP:** billing, guest accounts, face search, AI highlight reels, table/seating tagging, comments.

---

## 3. Tech stack (decided — do not re-litigate)

- **Backend:** Supabase — Postgres, Auth (host only), Realtime, Storage
- **Region:** `ap-southeast-1` (Singapore)
- **Front-ends:** plain HTML/CSS/JS served by a Supabase Edge Function (Deno). No build step, no framework. Rationale: three small surfaces, zero deploy pipeline, and the venue PC only needs a browser.
- **Client library:** `@supabase/supabase-js` v2 via CDN (UMD build)
- **Two providers, two jobs.** Cloudflare R2 holds the _files_; Supabase holds the _data_ (events, media rows, likes), pushes realtime updates to the guest feed and LED, and runs the Edge Function that serves the pages and mints presigned uploads. R2 is object storage — it cannot query or subscribe. Supabase Realtime is what makes the live wall live.
- **Storage:** **Cloudflare R2** from day one — not Supabase Storage. Egress is free, which is what makes 420 guests browsing an album cost nothing. Uploads go direct from the phone to R2 via a presigned PUT minted by the Edge Function; photo bytes never pass through Supabase. Setup steps in `SETUP-r2.md`.
- **All R2 access sits behind one module** exposing `upload()`, `publicUrl()`, `remove()`. Nothing else in the codebase references R2 or S3 directly.
- **No React, no Vite, no Tauri for this module.**

### Storage cost — settled

R2 free tier is 10 GB/month storage, 1M Class A and 10M Class B operations, with **zero egress charges**. One dinner is roughly 1.9 GB stored, 3,000 writes and 200,000 reads — everything but storage is inside the free tier by two orders of magnitude. Twelve dinners a year keeping everything is ~23 GB, about **US$0.20/month**. Supabase's 1 GB storage limit is no longer a constraint on this project.

---

## 4. Environment

### Supabase — database, realtime, and the Edge Function that serves the pages

```
SUPABASE_PROJECT     insphoto
SUPABASE_REF         pqhstyhtakohvwfjpmmf
SUPABASE_URL         https://pqhstyhtakohvwfjpmmf.supabase.co
REGION               ap-southeast-1 (Singapore)
ANON_KEY             sb_publishable_EEzW55bkKAsvOLznhe6j5g_We-O-p8u
EDGE_FUNCTION        album      (verify_jwt = false)
```

Schema from §5 is **already applied** to this project, including the seeded `album_settings` rows (`create_passcode`, `token_secret`, `brand_name`). Read them with the service role; they are not readable by anon.

The interim copy that briefly lived in the `Live Host Booking App` project has been deleted. That project is unrelated production and is not to be touched.

### Cloudflare R2 — Edge Function secrets, server-only

```
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET            insphoto
R2_PUBLIC_BASE       https://cdn.insphoto.my  (LIVE — custom domain connected and Active)
```

Done: `insphoto.my` is registered at Spaceship, the zone is active on Cloudflare, and `cdn.insphoto.my` is connected to the R2 bucket (Active/Enabled). Bucket CORS is saved — note R2 rejects `HEAD` in `AllowedMethods`, so it is `GET`+`PUT` only. Remaining setup: the five R2 secrets on the Edge Function.

R2 credentials never reach any browser. The service-role key never reaches any browser. Both live only in Edge Function secrets.

## 5. Data model — APPLY THIS FIRST

Written and tested during planning, then removed along with the interim project. Apply as one migration to the new `insphoto` project.

```sql
create extension if not exists pgcrypto;

create table public.album_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.album_settings enable row level security;   -- no anon policies

create table public.album_events (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  name text not null,
  tagline text not null default '',
  host_name text not null default '',
  brand_color text not null default '#0F766E',
  accent_color text not null default '#F59E0B',
  logo_url text, cover_url text,
  upload_open boolean not null default true,
  gallery_public boolean not null default true,
  moderation boolean not null default false,
  allow_video boolean not null default true,
  allow_guest_delete boolean not null default true,
  max_file_mb integer not null default 25,
  welcome_message text not null default '',
  max_photo_px integer not null default 1920,
  jpeg_quality numeric not null default 0.80,
  led_delay_seconds integer not null default 90,
  led_scene text not null default 'wall',
  led_hold boolean not null default false,
  created_at timestamptz not null default now(),
  archive_at timestamptz
);
alter table public.album_events enable row level security;
create policy album_events_public_read on public.album_events
  for select to anon, authenticated using (true);

create table public.album_event_secrets (
  event_id uuid primary key references public.album_events(id) on delete cascade,
  pin_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.album_event_secrets enable row level security;  -- no anon policies

create table public.album_media (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.album_events(id) on delete cascade,
  storage_path text not null,
  thumb_path text,
  kind text not null default 'photo' check (kind in ('photo','video')),
  width integer, height integer, bytes integer,
  uploader_name text not null default '',
  caption text not null default '',
  status text not null default 'approved' check (status in ('pending','approved','hidden')),
  device_id text not null default '',
  featured boolean not null default false,
  like_count integer not null default 0,
  liker_count integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.album_media enable row level security;

create index album_media_event_created_idx on public.album_media (event_id, created_at desc);
create index album_media_event_status_idx  on public.album_media (event_id, status);
create index album_media_rank_idx on public.album_media (event_id, liker_count desc, like_count desc);

-- status comes from the event's moderation flag; the client cannot choose it
create or replace function public.album_media_set_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare mod boolean;
begin
  select moderation into mod from public.album_events where id = new.event_id;
  new.status := case when coalesce(mod,false) then 'pending' else 'approved' end;
  new.featured := false;
  new.like_count := 0;
  new.liker_count := 0;
  return new;
end; $$;

create trigger album_media_set_status_trg
  before insert on public.album_media
  for each row execute function public.album_media_set_status();

create policy album_media_public_read on public.album_media
  for select to anon, authenticated
  using (status = 'approved' and exists (
    select 1 from public.album_events e
    where e.id = album_media.event_id and e.gallery_public));

create policy album_media_guest_insert on public.album_media
  for insert to anon, authenticated
  with check (exists (
    select 1 from public.album_events e
    where e.id = album_media.event_id and e.upload_open));

create table public.album_likes (
  media_id uuid not null references public.album_media(id) on delete cascade,
  device_id text not null,
  n integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (media_id, device_id)
);
alter table public.album_likes enable row level security;  -- no anon policies

-- one tap = one like, batched by the client. Ranking uses distinct likers.
create or replace function public.album_like(p_media uuid, p_device text, p_n integer)
returns table(like_count integer, liker_count integer)
language plpgsql security definer set search_path = public as $$
declare
  cur integer; fresh boolean; cap constant integer := 500;
begin
  if p_n is null or p_n <= 0 then raise exception 'invalid count'; end if;
  p_n := least(p_n, 100);
  if p_device is null or length(p_device) < 8 then raise exception 'invalid device'; end if;

  select n into cur from album_likes where media_id = p_media and device_id = p_device;
  cur := coalesce(cur, 0);
  p_n := least(p_n, greatest(0, cap - cur));

  if p_n = 0 then
    return query select m.like_count, m.liker_count from album_media m where m.id = p_media;
    return;
  end if;

  insert into album_likes (media_id, device_id, n) values (p_media, p_device, p_n)
  on conflict (media_id, device_id)
    do update set n = album_likes.n + excluded.n, updated_at = now()
  returning (xmax = 0) into fresh;

  return query
  update album_media m
     set like_count  = m.like_count + p_n,
         liker_count = m.liker_count + (case when fresh then 1 else 0 end)
   where m.id = p_media
  returning m.like_count, m.liker_count;
end; $$;

revoke all on function public.album_like(uuid, text, integer) from public;
grant execute on function public.album_like(uuid, text, integer) to anon, authenticated;

alter publication supabase_realtime add table public.album_media;
alter publication supabase_realtime add table public.album_events;
```

### Notes on the above

- `album_likes`, `album_settings` and `album_event_secrets` have RLS on with **no policies at all** — anon cannot touch them. All like writes go through `album_like()`, which is `SECURITY DEFINER`. Caps at 100 per call, 500 lifetime per device per photo.
- There is **no storage bucket** in this design. Files live in R2; `storage_path` and `thumb_path` are R2 object keys, resolved for display as `R2_PUBLIC_BASE + "/" + path`.
- Seed `album_settings` with `create_passcode` and `token_secret` (`encode(gen_random_bytes(32),'hex')`) after applying.

### Schema still to add (Sprint 2+)

`album_contests`, `album_contest_entries`, `album_sponsors`, plus `album_media.contest_id` and a `disqualified` flag with reason.

## 6. Guest app — `/e/:slug`

Mobile-first. Assume a mid-range Android on 5G in a ballroom.

### 6.1 Explore feed (default tab)

- **Masonry collage grid**, 2 columns on phone / 4 on tablet+, variable heights from stored `width`/`height`, newest first
- Infinite scroll, page size 60, `IntersectionObserver` for lazy image loading
- Loads `thumb_path` (480px), never the full image
- New photos arrive live via Realtime INSERT and animate in at the top
- Empty state invites the first upload

### 6.2 Photo view

Opens fullscreen on tap. Loads the 1920px version.

- **Like** — one tap, one like, unlimited. Heart animates on every tap with no network wait.
  - **Taps are batched client-side.** Accumulate locally, flush the count via `album_like()` every **800 ms** of idle, and on close/`visibilitychange`. Never one request per tap — 400 guests tapping will melt the database.
  - Optimistic UI. On failure, keep the local count and retry once; do not roll back visibly.
  - Display format: `❤️ 1,240 · 89 people`
- **Share** — `navigator.share()` with the image file when `navigator.canShare({files})` is supported, else share the photo URL. Falls back to copy-link on desktop.
- **Download** — offered two ways because long-press alone is undiscoverable and iOS Safari already claims it for "Save Image":
  - a visible `⋯` button on every photo
  - a long-press handler (`-webkit-touch-callout: none` + 500 ms timer)
  - Sheet offers **Standard** (1920px) and **High quality** (largest stored rendition)
- Swipe left/right between photos
- Guests can delete their own upload when `allow_guest_delete` is on — matched on `device_id`, deleted server-side via the Edge Function

### 6.3 Ranking tab

Same grid, sorted by `liker_count DESC, like_count DESC`. Top 3 get position badges. Refreshes every 20 s and on Realtime updates.

### 6.4 Upload

- Camera and gallery entry points, multi-select
- Name asked once on first upload, stored in `localStorage`, editable later. "Stay anonymous" is allowed.
- **Browser-side resize before upload** — this is not optional:
  - display rendition: longest edge `max_photo_px` (1920), JPEG `jpeg_quality` (0.80) ≈ 300 KB
  - thumbnail: 480px, q0.72 ≈ 40 KB
  - both uploaded to R2 via presigned PUT (§4, `SETUP-r2.md` step 7); returned keys written to `storage_path` / `thumb_path`
  - on `createImageBitmap` failure (HEIC edge cases) fall back to uploading the original
- Per-file progress list with thumbnail, bar and status
- **Automatic retry on failure** — 3 attempts, exponential backoff. Presigned URLs expire after 5 minutes, so a retry past that window must request a fresh presign rather than reuse the old URL. Full offline queueing is Sprint 4 and is a user-facing toggle, not a default.
- Videos honour `allow_video` and `max_file_mb`; oversized files are skipped with a clear message

### 6.5 Identity

`device_id` is a UUID in `localStorage`, created on first visit. There is no login, ever. It is used for like attribution, "my photos", and self-delete. It is not a security boundary — treat every value from the client as untrusted.

---

## 7. Console — `/h/:slug`

Windows PC, browser, keyboard-driven. Host signs in with a PIN; the Edge Function returns an 18-hour HMAC token held in `localStorage`.

### 7.1 Live grid

Everything arriving, newest first, Realtime. Each tile shows uploader name, time, like count and status. Arrow-key navigation, `Enter` to open.

### 7.2 Moderation

- **Delete** — removes the row and both R2 objects, permanently (server-side; the client never holds R2 credentials)
- **Hide** — stays in the database, disappears from guest app and LED
- **Approve** — only when moderation is on
- **Feature** — pins to the LED wall for the next rotation
- Every action is instant on the LED (Realtime), no page refresh

### 7.3 LED control

- **Scene switcher, keyboard `1`–`6`:** `1` Live wall · `2` Ranking · `3` Winner reveal _(Sprint 2)_ · `4` Sponsor slate _(Sprint 3)_ · `5` Countdown _(Sprint 2)_ · `6` Blank
  MVP implements `1`, `2`, `6`; the others render a placeholder card so the switcher is complete from day one.
- **Panic key** — `Esc` twice, or a large red button. Sets `led_scene='blank'`. Must take effect on the LED in under 1 second.
- **Hold all** — one click sets `led_hold=true`; the LED stops accepting new photos until released. For when the room gets rowdy. The guest album keeps working.
- **Delay** — `led_delay_seconds` adjustable in the UI, default **90**.

### 7.4 Event setup

QR code (on-screen + downloadable PNG at 900px), guest link with copy button, live stats (photos, contributors, storage used, pending), settings toggles, branding fields, and a bulk ZIP download of the album.

---

## 8. LED display — `/s/:slug`

Fullscreen on a second monitor. Read-only. No controls visible.

### 8.1 The delay buffer — the safety feature

A photo becomes eligible for display only once `now() - created_at > led_delay_seconds`. The page holds a queue of eligible-but-unshown photos and re-evaluates every 5 seconds. Anything deleted or hidden in the console vanishes from the queue immediately via Realtime, so the operator has a full 90 seconds to kill something before a guest sees it.

`led_hold=true` freezes intake; already-queued photos keep playing so the screen never goes dead.

### 8.2 Wall scene

- Full-bleed photo, blurred colour-matched backdrop, gentle Ken Burns
- Uploader name and caption lower-left
- New arrivals interrupt the rotation with a "Just added" badge
- QR code and "Scan to join" card bottom-right, always visible
- 7 s per photo; videos play to end, capped at 20 s

### 8.3 Ranking scene

Top 9 by `liker_count`, largest first, live counts. Used for best-dressed reveals.

### 8.4 Resilience — this runs in a hotel ballroom

- Caches the last 100 photo URLs; a wifi drop must never blank the screen
- Realtime disconnect triggers reconnect with backoff and a full reload every 60 s regardless
- No modal, alert or dialog may ever be rendered — a blocking dialog on the LED is an incident
- Screen-wake lock where supported

---

## 9. Contest engine (Sprint 2 — design now, build next)

Generic and reusable, not a hardcoded best-dressed page. Configurable per event: name, rules text, entry window, voting window, entry criteria.

**Scoring: ranked by `liker_count` (unique voters), `like_count` as tiebreaker.** Unlimited likes stay for engagement, but the prize cannot be bought by one phone — 10 taps/second for five minutes is 3,000 likes from a single device. "89 people voted for her" is also a better stage announcement than "1,240 taps".

**Disqualification** is distinct from delete: the entry stays in the album, drops out of the ranking, and the reason is logged.

**Auto-flagging:** person-count detection flags entries breaking the rule (best dressed = exactly one person in frame). The operator still decides — they review ~12 flagged photos instead of scanning 400 under time pressure. Client-side model in the console; no photo leaves the venue for inference.

---

## 10. Sponsor layer (Sprint 3)

- Host uploads transparent PNG overlays — corner logo, bottom bar, or full border. Multiple sponsors, rotating or weighted.
- **Applied at render time, never baked into stored files.** Keeps the clean original, avoids doubling storage, and lets sponsors be added or swapped _after_ the night.
- The framed version is composited on-device the moment a guest taps Share.
- Photographer uploads get the watermark applied by the watch-folder agent on ingest.
- **Sponsor impression report**, auto-generated post-event: photos, shares, reach, reactions, logo coverage. For an event management company this is the commercial deliverable — the wall is the machine that produces it.

---

## 11. Photographer ingest (Sprint 3)

Both paths, no FTP.

- **Watch-folder agent** (primary): small Windows binary watching e.g. `D:\Event\Upload`. Lightroom / Capture One export preset writes there; the agent watermarks, uploads and moves to `\Done`. The photographer's existing workflow does not change.
- **Console drag-and-drop** (fallback): works day one, no install.
- **FTP is explicitly rejected** — a server, open ports and credentials on a venue PC are three more things to fail. Revisit only if a client demands it.

---

## 12. Non-functional requirements

**Performance**

- Explore grid interactive in under 2 s on a mid-range Android over 5G
- Like taps register visually in under 50 ms, independent of network
- LED must sustain a 5-hour event without a reload or a memory leak

**Security**

- Client input is never trusted. `status`, `like_count` and `liker_count` are only ever set server-side.
- Host PIN stored as a salted SHA-256 hash in a table anon cannot read
- Console tokens are HMAC-signed with an 18-hour expiry, verified on every privileged call
- Photo paths use UUIDs; the R2 custom domain is public-read, so paths are unguessable but not secret. State this plainly to clients.
- The Edge Function chooses every object key. A client that names its own path can overwrite another guest's photo.

**PDPA**
Guest entry screen carries a one-line notice before first upload. Three answers needed before it can be drafted: who the data controller is (the event company or the client), retention period (proposed: read-only at 30 days, deleted at 90 unless extended), and whether photos may be reused for marketing afterwards — which is a **separate consent** from displaying them at the event and cannot be obtained retroactively.

**Accessibility**
Tap targets ≥ 44px; the LED must be legible from 20 metres — minimum 28px caption text at 1080p.

---

## 13. Build order

**Sprint 1 — the wall works** ← build this first
Guest explore grid, photo view, upload pipeline, batched likes, share, download, ranking tab. Console live grid, delete, hide, panic key, QR, stats. LED wall scene with the 90 s delay buffer. Ranking scene.
_Ships as a complete, demo-able product on its own._

**Sprint 2 — the show**
Scene switcher completion, contest engine, winner reveal, countdown, disqualification, auto person-count flagging.

**Sprint 3 — the business**
Sponsor frames, watermark, watch-folder agent, console drag-and-drop, sponsor impression report.

**Sprint 4 — local polish**
EN / 中文 / BM, WhatsApp share shortcuts, guest "upload later" offline toggle.

---

## 14. Sprint 1 acceptance criteria

1. A phone scanning the QR reaches the feed with no login and uploads a photo in under 20 seconds.
2. That photo appears on a second phone's feed within 5 seconds without a refresh.
3. 300 rapid taps on one photo produce **1** new `liker_count` and **300** `like_count`, using no more than ~6 network requests.
4. A photo deleted in the console disappears from every connected guest phone within 5 seconds.
5. A photo uploaded at T+0 does not appear on the LED before T+90s, and deleting it before then means it never appears at all.
6. Pressing the panic key blanks the LED in under 1 second.
7. Killing the LED machine's wifi for 30 seconds does not blank the screen or show an error dialog.
8. A 4 MB iPhone photo arrives in R2 at roughly 300 KB, with a 480px thumbnail alongside, and is served from the custom domain.
9. The ranking tab orders by unique voters, not raw likes.
10. No console-only capability is reachable from the guest bundle.

---

## 15. Out of scope for MVP — fast-follow list

| Deferred                    | Why                                                 | Revisit                                                     |
| --------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| Comments                    | adds a moderation surface with no operator assigned | when there's a dedicated moderator                          |
| Table / seating tagging     | not compelling enough to earn build time            | future upgrade; MWTA seating plan import is ready if wanted |
| Offline upload queue        | 5G coverage is good in Malaysia                     | Sprint 4, as a **user-selectable toggle**, not a default    |
| Billing / multi-tenant      | in-house tool first                                 | if this is ever sold                                        |
| Face-based "find my photos" | PDPA exposure, needs a real consent flow            | not soon                                                    |
| Custom domain               | short link is fine for the test                     | before selling to clients                                   |
