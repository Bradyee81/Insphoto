// Photographer upload surface (/p/:slug). A separate PIN from the host's,
// minting a token that can only upload: it is rejected by every console
// route (see requireHost in host.ts). Photographer rows are inserted here
// with the service role so `source = 'photographer'` sticks — the insert
// trigger forces anything a browser inserts directly back to 'guest'.

import { badRequest, json, notFound, unauthorized } from "../lib/respond.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { bearerToken, mintToken, verifyPin, verifyToken } from "../lib/hostAuth.ts";
import { makeKey, presignPut } from "../lib/r2.ts";

const PARTS = ["display", "thumb", "original"] as const;
type Part = (typeof PARTS)[number];

async function requirePhotog(req: Request, slug: string) {
  // Host tokens are accepted too, so the host can upload from the same page.
  return await verifyToken(bearerToken(req), slug);
}

// Keys must be ones this function minted for this event.
function ownKey(eventId: string, part: Part, key: unknown): key is string {
  if (typeof key !== "string") return false;
  const re = new RegExp(`^${eventId}/${part}/[0-9a-f-]{36}\\.[a-z0-9]{1,5}$`);
  return re.test(key);
}

export async function handlePhotogLogin(req: Request): Promise<Response> {
  let body: { slug?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }
  const { slug, pin } = body;
  if (!slug || !pin) return badRequest("slug and pin are required");

  const admin = supabaseAdmin();
  const { data: event } = await admin
    .from("album_events")
    .select("id, slug, name, max_photo_px, jpeg_quality")
    .eq("slug", slug)
    .single();
  if (!event) return notFound("event not found");

  const { data: secret } = await admin
    .from("album_event_secrets")
    .select("photog_pin_hash")
    .eq("event_id", event.id)
    .single();
  if (!secret?.photog_pin_hash) return unauthorized("photographer PIN not set yet — ask the host");
  if (!(await verifyPin(pin, secret.photog_pin_hash))) return unauthorized("wrong pin");

  const token = await mintToken({ event_id: event.id, slug: event.slug, role: "photog" });
  return json({ token, event });
}

export async function handlePhotogPresign(req: Request, slug: string): Promise<Response> {
  const auth = await requirePhotog(req, slug);
  if (!auth) return unauthorized();
  let body: { files?: { part: Part; content_type: string; ext: string }[] };
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }
  const files = body.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > 4) {
    return badRequest("1-4 files per request");
  }
  const out = [];
  for (const f of files) {
    if (!PARTS.includes(f.part)) return badRequest(`invalid part: ${f.part}`);
    const key = makeKey(auth.event_id, f.part, f.ext || "jpg");
    const { url, expiresAt } = await presignPut(key, f.content_type || "application/octet-stream");
    out.push({ part: f.part, key, url, expiresAt });
  }
  return json({ files: out });
}

export async function handlePhotogCreateMedia(req: Request, slug: string): Promise<Response> {
  const auth = await requirePhotog(req, slug);
  if (!auth) return unauthorized();
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }
  if (!ownKey(auth.event_id, "display", body.storage_path)) return badRequest("bad storage_path");
  if (!ownKey(auth.event_id, "thumb", body.thumb_path)) return badRequest("bad thumb_path");

  const { data, error } = await supabaseAdmin()
    .from("album_media")
    .insert({
      event_id: auth.event_id,
      storage_path: body.storage_path,
      thumb_path: body.thumb_path,
      kind: "photo",
      source: "photographer",
      width: Number(body.width) || null,
      height: Number(body.height) || null,
      bytes: Number(body.bytes) || null,
      uploader_name: String(body.uploader_name ?? "Photographer").slice(0, 40),
      caption: String(body.caption ?? "").slice(0, 200),
      device_id: "photographer",
    })
    .select("id")
    .single();
  if (error || !data) return json({ error: error?.message ?? "insert failed" }, { status: 500 });
  return json({ id: data.id });
}

// The full-resolution original goes up after the screen copy, so a photo is
// visible within seconds and the slow part happens in the background.
export async function handlePhotogAttachOriginal(
  req: Request,
  slug: string,
  mediaId: string,
): Promise<Response> {
  const auth = await requirePhotog(req, slug);
  if (!auth) return unauthorized();
  let body: { original_path?: unknown; bytes?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }
  if (!ownKey(auth.event_id, "original", body.original_path)) return badRequest("bad original_path");

  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from("album_media")
    .select("id, bytes, source")
    .eq("id", mediaId)
    .eq("event_id", auth.event_id)
    .single();
  if (!row || row.source !== "photographer") return notFound("photo not found");

  const { error } = await admin
    .from("album_media")
    .update({
      original_path: body.original_path,
      bytes: (row.bytes ?? 0) + (Number(body.bytes) || 0),
    })
    .eq("id", mediaId);
  if (error) return json({ error: error.message }, { status: 500 });
  return json({ ok: true });
}
