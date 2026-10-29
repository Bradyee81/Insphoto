-- Lucky Draw collection point (separate from the photo album).
--
-- The Lucky Draw desktop app publishes its winners here so the prize desk can
-- see them on a phone at insphoto.pages.dev/w/<code> and tick off prizes
-- handed out. Nothing in the album reads these tables.
--
-- RLS is on with no policies: anon/guests can't read or write them at all.
-- Only the `luckydraw` Edge Function (service role) touches them, after
-- checking the room's PIN (phones) or publish key (the desktop app).

create table public.luckydraw_rooms (
  code         text primary key,
  name         text not null default 'Lucky Draw',
  pin_hash     text not null,              -- "salt:sha256(salt+pin)"
  key_hash     text not null,              -- sha256 of the app's publish key
  failed_pins  integer not null default 0,  -- wrong PINs since the last lockout
  locked_until timestamptz,
  created_at   timestamptz not null default now(),
  synced_at    timestamptz
);
alter table public.luckydraw_rooms enable row level security;  -- no policies

create table public.luckydraw_winners (
  code         text not null references public.luckydraw_rooms(code) on delete cascade,
  -- The app's draw record id plus its draw time, so a reused id after an
  -- undo never inherits another winner's "collected".
  uid          text not null,
  record_id    bigint not null,
  number       text not null,
  name         text not null default '',
  prize        text not null default '',
  draw_group   text not null default '',
  section      text not null default '',
  drawn_at     timestamptz,
  collected_at timestamptz,
  primary key (code, uid)
);
alter table public.luckydraw_winners enable row level security;  -- no policies
