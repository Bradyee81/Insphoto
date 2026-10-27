-- Photographer uploads, featured-only LED, "show on screen", download lock,
-- and the Best Dress contest (nomination round + final vote round).
--
-- Applied to the live `insphoto` project (ref pqhstyhtakohvwfjpmmf) via the
-- Supabase MCP. Kept here for the repo's schema history.

-- ---------- photographer uploads ----------

alter table public.album_media
  add column if not exists source text not null default 'guest'
  check (source in ('guest', 'photographer'));

alter table public.album_event_secrets
  add column if not exists photog_pin_hash text;

-- Only the Edge Function (service role) may mark a row as a photographer
-- upload; anything a guest inserts directly is forced back to 'guest'.
create or replace function public.album_media_set_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare mod boolean;
begin
  select moderation into mod from public.album_events where id = new.event_id;
  new.status := case when coalesce(mod,false) then 'pending' else 'approved' end;
  new.featured := false;
  new.like_count := 0;
  new.liker_count := 0;
  if coalesce(auth.role(), '') <> 'service_role' then
    new.source := 'guest';
  end if;
  return new;
end; $$;

create index if not exists album_media_event_featured_idx
  on public.album_media (event_id) where featured;

-- ---------- LED / download settings ----------

alter table public.album_events
  add column if not exists led_featured_only boolean not null default false,
  add column if not exists led_spotlight_media uuid,
  add column if not exists originals_download boolean not null default false;

-- ---------- contest ----------

create table if not exists public.album_contests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.album_events(id) on delete cascade,
  name text not null default 'Best Dress',
  phase text not null default 'nominating'
    check (phase in ('nominating', 'nominations_closed', 'voting', 'closed')),
  voting_started_at timestamptz,
  voting_ends_at timestamptz,      -- null = no timer, stopped from the console
  voting_closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, name)
);
alter table public.album_contests enable row level security;
create policy album_contests_public_read on public.album_contests
  for select to anon, authenticated using (true);

-- Finalists only. Public: phones and the LED read this to show the stage.
create table if not exists public.album_contest_entries (
  contest_id uuid not null references public.album_contests(id) on delete cascade,
  media_id uuid not null references public.album_media(id) on delete cascade,
  label text not null default '',
  sort_order integer not null default 0,
  final_likes integer not null default 0,
  final_voters integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (contest_id, media_id)
);
alter table public.album_contest_entries enable row level security;
create policy album_contest_entries_public_read on public.album_contest_entries
  for select to anon, authenticated using (true);

-- Round 1 safety net. Console only — no anon policy, never reaches a phone.
create table if not exists public.album_contest_host_votes (
  contest_id uuid not null references public.album_contests(id) on delete cascade,
  media_id uuid not null references public.album_media(id) on delete cascade,
  votes integer not null default 0 check (votes >= 0),
  updated_at timestamptz not null default now(),
  primary key (contest_id, media_id)
);
alter table public.album_contest_host_votes enable row level security;

-- Round 2 per-phone tally, for the 1000-per-phone-per-finalist cap.
create table if not exists public.album_contest_votes (
  contest_id uuid not null references public.album_contests(id) on delete cascade,
  media_id uuid not null,
  device_id text not null,
  n integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (contest_id, media_id, device_id)
);
alter table public.album_contest_votes enable row level security;

-- Append-only audit log. No foreign keys, so it survives deletes and resets.
create table if not exists public.album_contest_log (
  id bigserial primary key,
  contest_id uuid not null,
  at timestamptz not null default now(),
  kind text not null,
  media_id uuid,
  device_id text,
  n integer,
  detail jsonb
);
create index if not exists album_contest_log_contest_idx on public.album_contest_log (contest_id, id);
alter table public.album_contest_log enable row level security;

alter publication supabase_realtime add table public.album_contests;

-- Server clock, so phones and the LED count down to the same moment.
create or replace function public.album_now()
returns timestamptz language sql stable as $$ select now() $$;
grant execute on function public.album_now() to anon, authenticated;

-- Round 2 vote. One call = one batch of taps from one phone for one finalist.
create or replace function public.album_contest_vote(
  p_contest uuid, p_media uuid, p_device text, p_n integer)
returns table(accepted integer, phase text)
language plpgsql security definer set search_path = public as $$
declare
  c public.album_contests;
  cur integer;
  add integer;
  cap constant integer := 1000;
begin
  if p_n is null or p_n <= 0 then raise exception 'invalid count'; end if;
  if p_device is null or length(p_device) < 8 then raise exception 'invalid device'; end if;
  p_n := least(p_n, 200);

  select * into c from album_contests where id = p_contest;
  if not found then raise exception 'contest not found'; end if;
  if c.phase <> 'voting' or (c.voting_ends_at is not null and now() > c.voting_ends_at) then
    return query select 0, c.phase;
    return;
  end if;
  if not exists (select 1 from album_contest_entries e
                 where e.contest_id = p_contest and e.media_id = p_media) then
    return query select 0, c.phase;
    return;
  end if;

  insert into album_contest_votes (contest_id, media_id, device_id, n)
  values (p_contest, p_media, p_device, 0)
  on conflict do nothing;

  select v.n into cur from album_contest_votes v
   where v.contest_id = p_contest and v.media_id = p_media and v.device_id = p_device
   for update;

  add := least(p_n, greatest(0, cap - cur));
  if add = 0 then
    return query select 0, c.phase;
    return;
  end if;

  update album_contest_votes v set n = v.n + add, updated_at = now()
   where v.contest_id = p_contest and v.media_id = p_media and v.device_id = p_device;

  update album_contest_entries e
     set final_likes = e.final_likes + add,
         final_voters = e.final_voters + (case when cur = 0 then 1 else 0 end)
   where e.contest_id = p_contest and e.media_id = p_media;

  insert into album_contest_log (contest_id, kind, media_id, device_id, n)
  values (p_contest, 'vote', p_media, p_device, add);

  return query select add, c.phase;
end; $$;

revoke all on function public.album_contest_vote(uuid, uuid, text, integer) from public;
grant execute on function public.album_contest_vote(uuid, uuid, text, integer) to anon, authenticated;

-- Every console contest action, in one transaction each. Service role only:
-- the Edge Function checks the host token, this enforces the phase rules.
create or replace function public.album_contest_admin(
  p_contest uuid, p_action text, p_args jsonb default '{}'::jsonb)
returns public.album_contests
language plpgsql security definer set search_path = public as $$
declare
  c public.album_contests;
  m uuid := nullif(p_args->>'media_id', '')::uuid;
  secs integer;
  snap jsonb;
  finalists integer;
begin
  select * into c from album_contests where id = p_contest for update;
  if not found then raise exception 'contest not found'; end if;

  -- A timed vote that has run out is closed before anything else happens.
  if c.phase = 'voting' and c.voting_ends_at is not null and now() > c.voting_ends_at then
    update album_contests set phase = 'closed', voting_closed_at = c.voting_ends_at
     where id = p_contest returning * into c;
    insert into album_contest_log (contest_id, kind, detail)
    values (p_contest, 'voting_auto_closed', jsonb_build_object('at', c.voting_ends_at));
  end if;

  if p_action = 'tick' then
    return c;
  end if;

  if p_action in ('host_votes', 'set_finalist', 'set_label', 'close_nominations', 'reopen_nominations')
     and c.phase not in ('nominating', 'nominations_closed') then
    raise exception 'not allowed during %', c.phase;
  end if;

  if p_action = 'host_votes' then
    insert into album_contest_host_votes (contest_id, media_id, votes)
    values (p_contest, m, greatest(0, (p_args->>'votes')::integer))
    on conflict (contest_id, media_id)
      do update set votes = excluded.votes, updated_at = now();
    insert into album_contest_log (contest_id, kind, media_id, n)
    values (p_contest, 'host_votes_set', m, greatest(0, (p_args->>'votes')::integer));

  elsif p_action = 'set_finalist' then
    if coalesce((p_args->>'on')::boolean, false) then
      insert into album_contest_entries (contest_id, media_id, sort_order)
      values (p_contest, m,
        coalesce((select max(sort_order) + 1 from album_contest_entries where contest_id = p_contest), 1))
      on conflict do nothing;
      insert into album_contest_log (contest_id, kind, media_id) values (p_contest, 'finalist_added', m);
    else
      delete from album_contest_entries where contest_id = p_contest and media_id = m;
      insert into album_contest_log (contest_id, kind, media_id) values (p_contest, 'finalist_removed', m);
    end if;

  elsif p_action = 'set_label' then
    update album_contest_entries set label = left(coalesce(p_args->>'label', ''), 60)
     where contest_id = p_contest and media_id = m;

  elsif p_action = 'close_nominations' then
    snap := coalesce(p_args->'snapshot', '[]'::jsonb);
    update album_contests set phase = 'nominations_closed' where id = p_contest returning * into c;
    insert into album_contest_log (contest_id, kind, detail)
    values (p_contest, 'nominations_closed', jsonb_build_object('ranking', snap));

  elsif p_action = 'reopen_nominations' then
    update album_contests set phase = 'nominating' where id = p_contest returning * into c;
    insert into album_contest_log (contest_id, kind) values (p_contest, 'nominations_reopened');

  elsif p_action = 'start_voting' then
    if c.phase not in ('nominating', 'nominations_closed') then
      raise exception 'not allowed during %', c.phase;
    end if;
    select count(*) into finalists from album_contest_entries where contest_id = p_contest;
    if finalists = 0 then raise exception 'no contestants selected'; end if;
    secs := nullif((p_args->>'seconds')::integer, 0);
    -- Counting always starts at zero; nothing carries over from dinner.
    delete from album_contest_votes where contest_id = p_contest;
    update album_contest_entries set final_likes = 0, final_voters = 0 where contest_id = p_contest;
    update album_contests
       set phase = 'voting',
           voting_started_at = now(),
           voting_ends_at = case when secs is null then null else now() + make_interval(secs => secs) end,
           voting_closed_at = null
     where id = p_contest returning * into c;
    insert into album_contest_log (contest_id, kind, detail)
    values (p_contest, 'voting_started', jsonb_build_object(
      'seconds', secs, 'ends_at', c.voting_ends_at,
      'contestants', (select jsonb_agg(jsonb_build_object('media_id', media_id, 'label', label) order by sort_order)
                        from album_contest_entries where contest_id = p_contest)));

  elsif p_action = 'stop_voting' then
    if c.phase = 'voting' then
      update album_contests set phase = 'closed', voting_closed_at = now()
       where id = p_contest returning * into c;
      insert into album_contest_log (contest_id, kind) values (p_contest, 'voting_stopped');
    end if;
    if c.phase = 'closed' then
      insert into album_contest_log (contest_id, kind, detail)
      values (p_contest, 'final_result', (
        select jsonb_agg(jsonb_build_object('media_id', media_id, 'label', label,
                 'likes', final_likes, 'voters', final_voters) order by final_likes desc)
          from album_contest_entries where contest_id = p_contest));
    end if;

  elsif p_action = 'reset' then
    if c.phase = 'voting' then raise exception 'stop voting before resetting'; end if;
    delete from album_contest_votes where contest_id = p_contest;
    delete from album_contest_entries where contest_id = p_contest;
    delete from album_contest_host_votes where contest_id = p_contest;
    update album_contests
       set phase = 'nominating', voting_started_at = null, voting_ends_at = null, voting_closed_at = null
     where id = p_contest returning * into c;
    insert into album_contest_log (contest_id, kind) values (p_contest, 'reset');

  else
    raise exception 'unknown action %', p_action;
  end if;

  return c;
end; $$;

revoke all on function public.album_contest_admin(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.album_contest_admin(uuid, text, jsonb) to service_role;
