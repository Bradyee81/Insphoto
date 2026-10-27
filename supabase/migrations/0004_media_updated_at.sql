-- Lets the console poll only what changed since its last poll, instead of
-- re-downloading every row every 3 seconds (which stops scaling once a
-- photographer adds hundreds of photos). Likes, hide, feature and approve
-- all bump updated_at.
--
-- Applied to the live `insphoto` project (ref pqhstyhtakohvwfjpmmf) via the
-- Supabase MCP. Kept here for the repo's schema history.

alter table public.album_media add column if not exists updated_at timestamptz not null default now();

create or replace function public.album_media_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists album_media_touch_trg on public.album_media;
create trigger album_media_touch_trg
  before update on public.album_media
  for each row execute function public.album_media_touch();

create index if not exists album_media_event_updated_idx on public.album_media (event_id, updated_at);
