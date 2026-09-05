// POST /api/admin/events — bootstraps a new event. Not a PRD-specified
// surface; without it there is no way to create the first event or set its
// host PIN, since album_event_secrets/album_events have no anon insert
// policy. Gated by the seeded `create_passcode` setting (PRD §5 notes).

import { badRequest, json } from "../lib/respond.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { hashPin } from "../lib/hostAuth.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;

export async function handleCreateEvent(req: Request): Promise<Response> {
  let body: { passcode?: string; slug?: string; name?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }

  const { passcode, slug, name, pin } = body;
  if (!passcode || !slug || !name || !pin) {
    return badRequest("passcode, slug, name and pin are required");
  }
  if (!SLUG_RE.test(slug)) {
    return badRequest("slug must be lowercase letters, numbers, hyphens (3-40 chars)");
  }
  if (pin.length < 4) return badRequest("pin must be at least 4 characters");

  const admin = supabaseAdmin();

  const { data: setting, error: settingErr } = await admin
    .from("album_settings")
    .select("value")
    .eq("key", "create_passcode")
    .single();

  if (settingErr || !setting || setting.value !== passcode) {
    return badRequest("invalid passcode");
  }

  const { data: event, error: insertErr } = await admin
    .from("album_events")
    .insert({ slug, name })
    .select("id, slug")
    .single();

  if (insertErr || !event) {
    return json({ error: insertErr?.message ?? "could not create event" }, { status: 500 });
  }

  const pinHash = await hashPin(pin);
  const { error: secretErr } = await admin
    .from("album_event_secrets")
    .insert({ event_id: event.id, pin_hash: pinHash });

  if (secretErr) {
    return json({ error: secretErr.message }, { status: 500 });
  }

  return json({ ok: true, slug: event.slug, event_id: event.id });
}
