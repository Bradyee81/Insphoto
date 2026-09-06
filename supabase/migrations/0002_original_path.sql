-- Adds storage for the true, unresized original file a guest uploaded.
-- PRD's original design only ever kept a 1920px "display" rendition and a
-- 480px thumb (deliberately, to control storage/bandwidth cost) - the host
-- later asked to also retain the true source resolution for guests who want
-- their actual photo back, without slowing down the live feed/photo view/LED
-- (which keep using display/thumb exactly as before). This column is nullable
-- and additive: existing rows are unaffected, and the app falls back to
-- storage_path wherever original_path is null (older rows, or the rare HEIC-
-- decode-failure path where the "display" upload already *is* the original).
--
-- Already applied to the live `insphoto` project (ref pqhstyhtakohvwfjpmmf)
-- via the Management API. Kept here for the repo's schema history.

alter table public.album_media add column if not exists original_path text;
