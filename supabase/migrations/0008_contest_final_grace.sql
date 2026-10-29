-- Last-second taps: phones send taps in batches (up to ~1 s apart), so taps
-- made just before zero arrive just after it. Phones stop taking taps at
-- zero by the server clock; the server now accepts batches for a short
-- grace period after the cutoff, then closes the vote. STOP ALL LIKES works
-- the same way — it sets the cutoff to "now" and the vote closes once the
-- grace period has passed — so the final number is the same on every phone
-- and on the screen.
--
-- Applied to the live `insphoto` project (ref pqhstyhtakohvwfjpmmf) via the
-- Supabase MCP. Kept here for the repo's schema history.

create or replace function public.album_contest_grace()
returns interval language sql immutable as $$ select interval '2 seconds' $$;

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
  if c.phase <> 'voting'
     or (c.voting_ends_at is not null and now() > c.voting_ends_at + album_contest_grace()) then
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

  -- Once the cutoff and its grace period have passed, the vote is closed
  -- before anything else happens.
  if c.phase = 'voting' and c.voting_ends_at is not null
     and now() > c.voting_ends_at + album_contest_grace() then
    update album_contests set phase = 'closed', voting_closed_at = c.voting_ends_at
     where id = p_contest returning * into c;
    insert into album_contest_log (contest_id, kind, detail)
    values (p_contest, 'voting_auto_closed', jsonb_build_object('at', c.voting_ends_at));
    perform album_contest_log_result(p_contest);
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
    if c.phase = 'nominating' then
      snap := coalesce(p_args->'snapshot', '[]'::jsonb);
      update album_contests set phase = 'nominations_closed' where id = p_contest returning * into c;
      insert into album_contest_log (contest_id, kind, detail)
      values (p_contest, 'nominations_closed', jsonb_build_object('ranking', snap));
    end if;

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

  elsif p_action = 'start_countdown' then
    if c.phase <> 'voting' then raise exception 'not allowed during %', c.phase; end if;
    if c.voting_ends_at is not null then raise exception 'countdown already running'; end if;
    secs := (p_args->>'seconds')::integer;
    if secs is null or secs < 5 or secs > 600 then raise exception 'invalid countdown'; end if;
    update album_contests set voting_ends_at = now() + make_interval(secs => secs)
     where id = p_contest returning * into c;
    insert into album_contest_log (contest_id, kind, n, detail)
    values (p_contest, 'countdown_started', secs, jsonb_build_object('ends_at', c.voting_ends_at));

  elsif p_action = 'stop_voting' then
    -- Cut off now; taps already on their way still count for the grace
    -- period, then the next tick closes the vote and logs the result.
    if c.phase = 'voting' and (c.voting_ends_at is null or c.voting_ends_at > now()) then
      update album_contests set voting_ends_at = now()
       where id = p_contest returning * into c;
      insert into album_contest_log (contest_id, kind) values (p_contest, 'voting_stopped');
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
