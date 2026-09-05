-- InsPhoto schema — PRD §5.
-- Reference copy only. This has ALREADY been applied to the live `insphoto`
-- Supabase project (ref pqhstyhtakohvwfjpmmf). Do NOT run this against that
-- project — it is kept here so the schema is versioned in the repo and a
-- fresh project (e.g. a local/staging one) can be bootstrapped from it.

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
