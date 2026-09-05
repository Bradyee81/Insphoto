// Everything the console (PRD §7) needs that requires the service role:
// login, the polled live-feed, moderation actions, settings, stats and the
// ZIP export. Every route except login requires a valid host token (§12).

import { badRequest, json, notFound, unauthorized } from "../lib/respond.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { bearerToken, mintToken, verifyPin, verifyToken } from "../lib/hostAuth.ts";
import { getObject, remove } from "../lib/r2.ts";
import { sendBroadcast } from "../lib/broadcast.ts";
import { ZipBuilder } from "../lib/zip.ts";

async function requireHost(req: Request, slug: string) {
  const token = bearerToken(req);
  const payload = await verifyToken(token, slug);
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

  const token = await mintToken({ event_id: event.id, slug: event.slug });
  return json({ token, event });
}

export async function handleFeed(req: Request, slug: string): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();

  const { data, error } = await supabaseAdmin()
    .from("album_media")
    .select("*")
    .eq("event_id", auth.event_id)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) return json({ error: error.message }, { status: 500 });
  return json({ media: data });
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

  await remove([media.storage_path, media.thumb_path]);
  const { error } = await supabaseAdmin().from("album_media").delete().eq("id", mediaId);
  if (error) return json({ error: error.message }, { status: 500 });
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

  // postgres_changes won't reach anon subscribers for this transition — see plan.
  await sendBroadcast(`event:${auth.event_id}`, "media_hidden", { id: mediaId });
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

  const admin = supabaseAdmin();
  const { count: total } = await admin
    .from("album_media")
    .select("id", { count: "exact", head: true })
    .eq("event_id", auth.event_id);
  const { count: pending } = await admin
    .from("album_media")
    .select("id", { count: "exact", head: true })
    .eq("event_id", auth.event_id)
    .eq("status", "pending");
  const { data: rows } = await admin
    .from("album_media")
    .select("bytes, device_id")
    .eq("event_id", auth.event_id);

  const bytesTotal = (rows ?? []).reduce(
    (n: number, r: { bytes: number | null }) => n + (r.bytes ?? 0),
    0,
  );
  const contributors = new Set((rows ?? []).map((r: { device_id: string }) => r.device_id)).size;

  return json({
    photos: total ?? 0,
    pending: pending ?? 0,
    contributors,
    bytes: bytesTotal,
  });
}

export async function handleHostExport(req: Request, slug: string): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();

  const { data: rows, error } = await supabaseAdmin()
    .from("album_media")
    .select("id, storage_path, kind, status")
    .eq("event_id", auth.event_id)
    .neq("status", "hidden");

  if (error) return json({ error: error.message }, { status: 500 });

  const zip = new ZipBuilder();
  let index = 1;
  for (const row of rows ?? []) {
    const bytes = await getObject(row.storage_path);
    if (!bytes) continue;
    const ext = row.kind === "video" ? "mp4" : "jpg";
    zip.addFile(`${String(index).padStart(4, "0")}.${ext}`, bytes);
    index++;
  }

  const body = zip.build();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${slug}-album.zip"`,
      "access-control-allow-origin": "*",
    },
  });
}
