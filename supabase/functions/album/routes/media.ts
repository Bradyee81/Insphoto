// POST /api/media/:id/delete — guest self-delete (PRD §6.2). device_id is
// not a security boundary (§6.5) but it is the only signal we have, and it's
// enough to stop an accidental double-post without giving guests a general
// delete capability — anything else still requires the host token (routes/host.ts).

import { badRequest, json, notFound } from "../lib/respond.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { remove } from "../lib/r2.ts";

export async function handleGuestDelete(req: Request, mediaId: string): Promise<Response> {
  let body: { device_id?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }
  const deviceId = body.device_id;
  if (!deviceId || deviceId.length < 8) return badRequest("invalid device_id");

  const admin = supabaseAdmin();
  const { data: media, error } = await admin
    .from("album_media")
    .select("id, device_id, storage_path, thumb_path, original_path, event_id, album_events!inner(allow_guest_delete)")
    .eq("id", mediaId)
    .single();

  if (error || !media) return notFound("photo not found");
  if (media.device_id !== deviceId) return badRequest("not your upload");
  // deno-lint-ignore no-explicit-any
  const allowGuestDelete = (media as any).album_events?.allow_guest_delete;
  if (!allowGuestDelete) return badRequest("guest delete is disabled for this event");

  await remove([media.storage_path, media.thumb_path, media.original_path]);
  const { error: delErr } = await admin.from("album_media").delete().eq("id", mediaId);
  if (delErr) return json({ error: delErr.message }, { status: 500 });

  return json({ ok: true });
}
