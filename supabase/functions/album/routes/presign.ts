// POST /api/presign — mints presigned R2 PUT URLs for a guest upload. The
// Edge Function chooses every object key (PRD §12); the guest only ever
// receives a URL to PUT bytes at and the key to record afterwards.

import { badRequest, json, notFound } from "../lib/respond.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { makeKey, presignPut } from "../lib/r2.ts";

interface FileReq {
  part: "display" | "thumb" | "video";
  content_type: string;
  ext: string;
}

export async function handlePresign(req: Request): Promise<Response> {
  let body: { event_id?: string; files?: FileReq[] };
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }

  const { event_id, files } = body;
  if (!event_id || !Array.isArray(files) || files.length === 0) {
    return badRequest("event_id and files are required");
  }
  if (files.length > 4) return badRequest("too many files in one request");

  const { data: event, error } = await supabaseAdmin()
    .from("album_events")
    .select("id, upload_open, max_file_mb, allow_video")
    .eq("id", event_id)
    .single();

  if (error || !event) return notFound("event not found");
  if (!event.upload_open) return badRequest("uploads are closed for this event");

  const out: { part: string; key: string; url: string; expiresAt: number }[] = [];
  for (const f of files) {
    if (!["display", "thumb", "video"].includes(f.part)) {
      return badRequest(`invalid part: ${f.part}`);
    }
    if (f.part === "video" && !event.allow_video) {
      return badRequest("video uploads are disabled for this event");
    }
    const key = makeKey(event_id, f.part, f.ext || "jpg");
    const { url, expiresAt } = await presignPut(key, f.content_type || "application/octet-stream");
    out.push({ part: f.part, key, url, expiresAt });
  }

  return json({ files: out });
}
