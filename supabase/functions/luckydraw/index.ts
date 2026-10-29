// `luckydraw` Edge Function — the online collection point for the Lucky Draw
// desktop app. Separate from `album`: it only touches the luckydraw_* tables
// (see migrations/0009_luckydraw_winners.sql).
//
// Two kinds of caller:
// - The Lucky Draw app, holding a room's publish key: creates the room,
//   pushes its winners list, passes on console "collected" ticks.
// - Prize desk phones on /w/<code>, holding the room's PIN: read the list
//   and tick prizes as collected.
//
// All routes are POST with a JSON body, so PINs and keys never sit in URLs.

import { createClient } from "@supabase/supabase-js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

const MAX_WINNERS = 2000;
// Wrong PINs allowed before the room locks for LOCK_MINUTES.
const MAX_FAILED_PINS = 10;
const LOCK_MINUTES = 5;
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
const fail = (status: number, error: string) => json({ error }, status);

let client: ReturnType<typeof createClient> | null = null;
// Service-role client: bypasses RLS, so every route checks a PIN or key first.
function db() {
  if (!client) {
    client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
  }
  return client;
}

const te = new TextEncoder();
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// Same "salt:sha256(salt+pin)" format as album's host PINs.
async function hashPin(pin: string): Promise<string> {
  const salt = randomHex(16);
  return `${salt}:${await sha256Hex(salt + pin)}`;
}
async function pinMatches(pin: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  return !!salt && !!hash && sameString(await sha256Hex(salt + pin), hash);
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const validPin = (pin: unknown): pin is string => typeof pin === "string" && /^\d{4,8}$/.test(pin);

interface Room {
  code: string;
  name: string;
  pin_hash: string;
  key_hash: string;
  failed_pins: number;
  locked_until: string | null;
}

async function getRoom(code: unknown): Promise<Room | null> {
  if (typeof code !== "string" || !/^[a-z0-9]{4,12}$/.test(code)) return null;
  const { data } = await db().from("luckydraw_rooms").select("*").eq("code", code).maybeSingle();
  return (data as Room | null) ?? null;
}

/** The app's publish key, or an error response. */
async function roomByKey(body: Record<string, unknown>): Promise<Room | Response> {
  const room = await getRoom(body.code);
  if (!room) return fail(404, "room not found");
  if (typeof body.key !== "string" || !sameString(await sha256Hex(body.key), room.key_hash)) {
    return fail(401, "wrong key");
  }
  return room;
}

/** A phone's PIN, or an error response. Locks the room after too many misses. */
async function roomByPin(body: Record<string, unknown>): Promise<Room | Response> {
  const room = await getRoom(body.code);
  if (!room) return fail(404, "This link isn't active. Check it with the console.");
  if (room.locked_until && new Date(room.locked_until) > new Date()) {
    return fail(423, `Too many wrong PINs. Try again in ${LOCK_MINUTES} minutes.`);
  }
  if (typeof body.pin !== "string" || !(await pinMatches(body.pin, room.pin_hash))) {
    const failed = room.failed_pins + 1;
    const lock = failed >= MAX_FAILED_PINS;
    await db()
      .from("luckydraw_rooms")
      .update({
        failed_pins: lock ? 0 : failed,
        locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : room.locked_until,
      })
      .eq("code", room.code);
    return fail(401, "Wrong PIN.");
  }
  if (room.failed_pins > 0) {
    await db().from("luckydraw_rooms").update({ failed_pins: 0 }).eq("code", room.code);
  }
  return room;
}

async function createRoom(body: Record<string, unknown>): Promise<Response> {
  if (!validPin(body.pin)) return fail(400, "PIN must be 4 to 8 digits");
  const key = randomHex(24);
  const row = {
    name: str(body.name, 80).trim() || "Lucky Draw",
    pin_hash: await hashPin(body.pin),
    key_hash: await sha256Hex(key),
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    const { error } = await db().from("luckydraw_rooms").insert({ code, ...row });
    if (!error) return json({ code, key });
  }
  return fail(500, "couldn't create a room, try again");
}

interface WinnerIn {
  uid: string;
  id: number;
  number: string;
  name: string;
  prize: string;
  group: string;
  section: string;
  drawn_at: string;
}

/** The app pushes its full winners list (when it changed) and console ticks. */
async function sync(body: Record<string, unknown>): Promise<Response> {
  const room = await roomByKey(body);
  if (room instanceof Response) return room;

  if (Array.isArray(body.winners)) {
    const winners = (body.winners as WinnerIn[]).slice(0, MAX_WINNERS);
    const rows = winners.map((w) => ({
      code: room.code,
      uid: str(w.uid, 80),
      record_id: Number(w.id) || 0,
      number: str(w.number, 40),
      name: str(w.name),
      prize: str(w.prize),
      draw_group: str(w.group, 80),
      section: str(w.section, 120),
      drawn_at: str(w.drawn_at, 40) || null,
    })).filter((r) => r.uid);
    if (rows.length) {
      // collected_at isn't in the rows, so ticks already made survive.
      const { error } = await db().from("luckydraw_winners").upsert(rows, { onConflict: "code,uid" });
      if (error) return fail(500, error.message);
    }
    // Winners the app no longer has (undone round, cleared results).
    const { data: existing } = await db().from("luckydraw_winners").select("uid").eq("code", room.code);
    const keep = new Set(rows.map((r) => r.uid));
    const gone = (existing ?? []).map((r: { uid: string }) => r.uid).filter((uid) => !keep.has(uid));
    if (gone.length) await db().from("luckydraw_winners").delete().eq("code", room.code).in("uid", gone);
  }

  if (Array.isArray(body.collect)) {
    for (const op of (body.collect as { uid: string; collected: boolean }[]).slice(0, MAX_WINNERS)) {
      await db()
        .from("luckydraw_winners")
        .update({ collected_at: op.collected ? new Date().toISOString() : null })
        .eq("code", room.code)
        .eq("uid", str(op.uid, 80));
    }
  }

  await db().from("luckydraw_rooms").update({ synced_at: new Date().toISOString() }).eq("code", room.code);
  const { data } = await db().from("luckydraw_winners").select("uid, collected_at").eq("code", room.code);
  const collected: Record<string, string | null> = {};
  for (const r of (data ?? []) as { uid: string; collected_at: string | null }[]) collected[r.uid] = r.collected_at;
  return json({ collected });
}

async function setPin(body: Record<string, unknown>): Promise<Response> {
  const room = await roomByKey(body);
  if (room instanceof Response) return room;
  if (!validPin(body.pin)) return fail(400, "PIN must be 4 to 8 digits");
  await db()
    .from("luckydraw_rooms")
    .update({ pin_hash: await hashPin(body.pin), failed_pins: 0, locked_until: null, name: str(body.name, 80).trim() || room.name })
    .eq("code", room.code);
  return json({ ok: true });
}

async function deleteRoom(body: Record<string, unknown>): Promise<Response> {
  const room = await roomByKey(body);
  if (room instanceof Response) return room;
  await db().from("luckydraw_rooms").delete().eq("code", room.code); // winners cascade
  return json({ ok: true });
}

async function list(body: Record<string, unknown>): Promise<Response> {
  const room = await roomByPin(body);
  if (room instanceof Response) return room;
  const { data, error } = await db()
    .from("luckydraw_winners")
    .select("uid, number, name, prize, draw_group, section, drawn_at, collected_at")
    .eq("code", room.code)
    .order("record_id", { ascending: false });
  if (error) return fail(500, error.message);
  const { data: r } = await db().from("luckydraw_rooms").select("synced_at").eq("code", room.code).single();
  return json({ name: room.name, synced_at: (r as { synced_at: string | null } | null)?.synced_at ?? null, winners: data ?? [] });
}

async function collect(body: Record<string, unknown>): Promise<Response> {
  const room = await roomByPin(body);
  if (room instanceof Response) return room;
  const { error } = await db()
    .from("luckydraw_winners")
    .update({ collected_at: body.collected ? new Date().toISOString() : null })
    .eq("code", room.code)
    .eq("uid", str(body.uid, 80));
  if (error) return fail(500, error.message);
  return json({ ok: true });
}

const ROUTES: Record<string, (body: Record<string, unknown>) => Promise<Response>> = {
  "/create": createRoom,
  "/sync": sync,
  "/pin": setPin,
  "/delete": deleteRoom,
  "/list": list,
  "/collect": collect,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // Requests arrive as .../functions/v1/luckydraw/<route>.
  const path = new URL(req.url).pathname.replace(/^.*\/luckydraw/, "") || "/";
  const route = ROUTES[path];
  if (req.method !== "POST" || !route) return fail(404, "not found");
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid JSON");
  }
  try {
    return await route(body ?? {});
  } catch (err) {
    console.error(err);
    return fail(500, "server error");
  }
});
