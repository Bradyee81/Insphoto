// Everything the console (PRD §7) needs that requires the service role:
// login, the polled live-feed, moderation actions, settings, stats, the
// export list and the photographer PIN. Every route except login requires
// a valid host token (§12).

import { badRequest, json, notFound, unauthorized } from "../lib/respond.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { bearerToken, hashPin, mintToken, verifyPin, verifyToken } from "../lib/hostAuth.ts";
import { publicUrl, remove } from "../lib/r2.ts";
import { notifyMediaRemoved } from "../lib/broadcast.ts";

export async function requireHost(req: Request, slug: string) {
  const token = bearerToken(req);
  const payload = await verifyToken(token, slug);
  // A photographer token must never reach the console routes.
  if (!payload || payload.role === "photog") return null;
  return payload; // null if invalid/expired/slug mismatch
}

export async function handleLogin(req: Request): Promise<Response> {
  let body: { slug?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }
  const { slug, pin } = body;
  if (!slug || !pin) return badRequest("slug and pin are required");

  const admin = supabaseAdmin();
  const { data: event, error } = await admin
    .from("album_events")
    .select("id, slug, name")
    .eq("slug", slug)
    .single();
  if (error || !event) return notFound("event not found");

  const { data: secret, error: secretErr } = await admin
    .from("album_event_secrets")
    .select("pin_hash")
    .eq("event_id", event.id)
    .single();
  if (secretErr || !secret) return notFound("event not found");

  const ok = await verifyPin(pin, secret.pin_hash);
  if (!ok) return unauthorized("wrong pin");

  const token = await mintToken({ event_id: event.id, slug: event.slug, role: "host" });
  return json({ token, event });
}

const FEED_PAGE = 1000;

// Full load: every row, newest first, paged past PostgREST's row cap.
// ?since=<iso>: only rows changed after that moment (new uploads, likes,
// hide/feature/approve) — what the console polls every few seconds.
export async function handleFeed(req: Request, slug: string): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();

  const since = new URL(req.url).searchParams.get("since");
  const admin = supabaseAdmin();
  const rows: Record<string, unknown>[] = [];

  if (since) {
    const { data, error } = await admin
      .from("album_media")
      .select("*")
      .eq("event_id", auth.event_id)
      .gt("updated_at", since)
      .order("updated_at", { ascending: true })
      .limit(FEED_PAGE);
    if (error) return json({ error: error.message }, { status: 500 });
    rows.push(...(data ?? []));
  } else {
    for (let from = 0; ; from += FEED_PAGE) {
      const { data, error } = await admin
        .from("album_media")
        .select("*")
        .eq("event_id", auth.event_id)
        .order("created_at", { ascending: false })
        .range(from, from + FEED_PAGE - 1);
      if (error) return json({ error: error.message }, { status: 500 });
      rows.push(...(data ?? []));
      if (!data || data.length < FEED_PAGE) break;
    }
  }

  // The cursor for the next ?since= poll is the newest updated_at we have
  // seen, taken from the database's own clock rather than the browser's.
  let cursor = since;
  for (const r of rows) {
    const u = r.updated_at as string;
    if (!cursor || u > cursor) cursor = u;
  }
  return json({ media: rows, cursor, full: !since });
}

async function loadMediaForEvent(mediaId: string, eventId: string) {
  const { data, error } = await supabaseAdmin()
    .from("album_media")
    .select("*")
    .eq("id", mediaId)
    .eq("event_id", eventId)
    .single();
  if (error || !data) return null;
  return data;
}

export async function handleHostMediaDelete(
  req: Request,
  slug: string,
  mediaId: string,
): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();
  const media = await loadMediaForEvent(mediaId, auth.event_id);
  if (!media) return notFound("photo not found");

  await remove([media.storage_path, media.thumb_path, media.original_path]);
  const { error } = await supabaseAdmin().from("album_media").delete().eq("id", mediaId);
  if (error) return json({ error: error.message }, { status: 500 });
  await notifyMediaRemoved(auth.event_id, mediaId);
  return json({ ok: true });
}

export async function handleHostMediaHide(
  req: Request,
  slug: string,
  mediaId: string,
): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();
  const media = await loadMediaForEvent(mediaId, auth.event_id);
  if (!media) return notFound("photo not found");

  const { error } = await supabaseAdmin()
    .from("album_media")
    .update({ status: "hidden" })
    .eq("id", mediaId);
  if (error) return json({ error: error.message }, { status: 500 });

  await notifyMediaRemoved(auth.event_id, mediaId);
  return json({ ok: true });
}

export async function handleHostMediaApprove(
  req: Request,
  slug: string,
  mediaId: string,
): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();
  const media = await loadMediaForEvent(mediaId, auth.event_id);
  if (!media) return notFound("photo not found");

  const { error } = await supabaseAdmin()
    .from("album_media")
    .update({ status: "approved" })
    .eq("id", mediaId);
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ ok: true });
}

export async function handleHostMediaFeature(
  req: Request,
  slug: string,
  mediaId: string,
): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();
  const media = await loadMediaForEvent(mediaId, auth.event_id);
  if (!media) return notFound("photo not found");

  const { error } = await supabaseAdmin()
    .from("album_media")
    .update({ featured: !media.featured })
    .eq("id", mediaId);
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ ok: true, featured: !media.featured });
}

const SETTINGS_FIELDS = [
  "name",
  "tagline",
  "host_name",
  "brand_color",
  "accent_color",
  "logo_url",
  "cover_url",
  "upload_open",
  "gallery_public",
  "moderation",
  "allow_video",
  "allow_guest_delete",
  "max_file_mb",
  "welcome_message",
  "max_photo_px",
  "jpeg_quality",
  "led_delay_seconds",
  "led_scene",
  "led_hold",
  "led_featured_only",
  "led_spotlight_media",
  "originals_download",
] as const;

export async function handleHostSettings(req: Request, slug: string): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }

  const patch: Record<string, unknown> = {};
  for (const field of SETTINGS_FIELDS) {
    if (field in body) patch[field] = body[field];
  }
  if (Object.keys(patch).length === 0) return badRequest("no valid fields to update");

  const { data, error } = await supabaseAdmin()
    .from("album_events")
    .update(patch)
    .eq("id", auth.event_id)
    .select()
    .single();

  if (error) return json({ error: error.message }, { status: 500 });
  return json({ event: data });
}

export async function handleHostStats(req: Request, slug: string): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();

  // Aggregated in SQL so the totals stay right past PostgREST's row cap.
  const { data, error } = await supabaseAdmin().rpc("album_event_stats", { p_event: auth.event_id });
  if (error) return json({ error: error.message }, { status: 500 });
  const s = (data ?? [])[0] ?? {};
  return json({
    photos: s.photos ?? 0,
    pending: s.pending ?? 0,
    photographer: s.photographer ?? 0,
    contributors: s.contributors ?? 0,
    bytes: s.bytes ?? 0,
  });
}

// The list of every photo's best file (the original when there is one), for
// the console to download one by one straight into a folder on the host's
// computer. This replaced a server-built ZIP: a few GB of originals doesn't
// fit in an Edge Function's memory or time limit, a browser writing
// file-by-file has no limit.
export async function handleHostExportList(req: Request, slug: string): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();

  const admin = supabaseAdmin();
  const files: { url: string; name: string }[] = [];
  for (let from = 0; ; from += FEED_PAGE) {
    const { data, error } = await admin
      .from("album_media")
      .select("id, storage_path, original_path, kind, source, created_at")
      .eq("event_id", auth.event_id)
      .neq("status", "hidden")
      .order("created_at", { ascending: true })
      .range(from, from + FEED_PAGE - 1);
    if (error) return json({ error: error.message }, { status: 500 });
    for (const row of data ?? []) {
      const key = row.original_path || row.storage_path;
      const ext = (key.match(/\.([a-z0-9]+)$/i)?.[1] ?? (row.kind === "video" ? "mp4" : "jpg")).toLowerCase();
      const n = String(files.length + 1).padStart(4, "0");
      const who = row.source === "photographer" ? "photographer" : "guest";
      files.push({ url: publicUrl(key)!, name: `${n}-${who}.${ext}` });
    }
    if (!data || data.length < FEED_PAGE) break;
  }
  return json({ files });
}

export async function handleSetPhotogPin(req: Request, slug: string): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();
  let body: { pin?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }
  const pin = (body.pin ?? "").trim();
  if (pin.length < 4) return badRequest("pin must be at least 4 characters");
  const { error } = await supabaseAdmin()
    .from("album_event_secrets")
    .update({ photog_pin_hash: await hashPin(pin) })
    .eq("event_id", auth.event_id);
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ ok: true });
}
