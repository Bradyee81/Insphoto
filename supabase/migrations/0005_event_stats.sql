-- Console stats aggregated in SQL, so totals stay right past PostgREST's
-- 1000-row response cap once a photographer uploads hundreds of photos.
--
-- Applied to the live `insphoto` project (ref pqhstyhtakohvwfjpmmf) via the
-- Supabase MCP. Kept here for the repo's schema history.

create or replace function public.album_event_stats(p_event uuid)
returns table(photos bigint, pending bigint, photographer bigint, contributors bigint, bytes bigint)
language sql stable security definer set search_path = public as $$
  select count(*),
         count(*) filter (where status = 'pending'),
         count(*) filter (where source = 'photographer'),
         count(distinct device_id),
         coalesce(sum(bytes), 0)::bigint
    from album_media where event_id = p_event
$$;
revoke all on function public.album_event_stats(uuid) from public, anon, authenticated;
grant execute on function public.album_event_stats(uuid) to service_role;
