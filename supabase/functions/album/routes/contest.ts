// Best Dress contest — the console side. Round 1 (nomination) ranks every
// photo by how many *people* liked it, plus any votes the host added as a
// safety net; the host then picks the contestants. Round 2 (final vote)
// counts likes from zero on the contestants only. The phase rules — above
// all, "the console cannot touch the numbers once voting has started" — are
// enforced inside album_contest_admin() in the database, not here.

import { badRequest, json, unauthorized } from "../lib/respond.ts";
import { supabaseAdmin } from "../lib/supabaseAdmin.ts";
import { requireHost } from "./host.ts";

const CONTEST_NAME = "Best Dress";
const NOMINATION_LIST = 60;

async function contestFor(eventId: string) {
  const admin = supabaseAdmin();
  const { data } = await admin
    .from("album_contests")
    .select("*")
    .eq("event_id", eventId)
    .eq("name", CONTEST_NAME)
    .maybeSingle();
  if (data) return data;
  const { data: created, error } = await admin
    .from("album_contests")
    .upsert({ event_id: eventId, name: CONTEST_NAME }, { onConflict: "event_id,name" })
    .select("*")
    .single();
  if (error) throw error;
  return created;
}

async function admin(contestId: string, action: string, args: Record<string, unknown> = {}) {
  return await supabaseAdmin().rpc("album_contest_admin", {
    p_contest: contestId,
    p_action: action,
    p_args: args,
  });
}

// Live nomination ranking: guests who liked + host-added votes.
async function nominationRanking(eventId: string, contestId: string) {
  const db = supabaseAdmin();
  const [{ data: media }, { data: hostVotes }] = await Promise.all([
    db
      .from("album_media")
      .select("id, thumb_path, storage_path, uploader_name, source, liker_count, like_count")
      .eq("event_id", eventId)
      .eq("status", "approved")
      .order("liker_count", { ascending: false })
      .order("like_count", { ascending: false })
      .limit(300),
    db.from("album_contest_host_votes").select("media_id, votes").eq("contest_id", contestId),
  ]);
  const host = new Map((hostVotes ?? []).map((h) => [h.media_id, h.votes as number]));
  const byId = new Map((media ?? []).map((m) => [m.id, m]));

  // A photo with host votes may sit outside the top 300 by guests — fetch it.
  const missing = [...host.keys()].filter((id) => !byId.has(id));
  if (missing.length) {
    const { data: extra } = await db
      .from("album_media")
      .select("id, thumb_path, storage_path, uploader_name, source, liker_count, like_count")
      .in("id", missing)
      .eq("status", "approved");
    for (const m of extra ?? []) byId.set(m.id, m);
  }

  return [...byId.values()]
    .map((m) => ({
      media_id: m.id,
      thumb_path: m.thumb_path || m.storage_path,
      uploader_name: m.uploader_name,
      source: m.source,
      guests: m.liker_count as number,
      host: host.get(m.id) ?? 0,
      score: (m.liker_count as number) + (host.get(m.id) ?? 0),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, NOMINATION_LIST);
}

export async function handleContestGet(req: Request, slug: string): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();

  const base = await contestFor(auth.event_id);
  const { data: contest, error } = await admin(base.id, "tick");
  if (error) return json({ error: error.message }, { status: 500 });

  const db = supabaseAdmin();
  const [ranking, { data: entries }, { data: frozen }, { data: nowRow }] = await Promise.all([
    nominationRanking(auth.event_id, base.id),
    db
      .from("album_contest_entries")
      .select("media_id, label, sort_order, final_likes, final_voters, album_media(thumb_path, storage_path, uploader_name)")
      .eq("contest_id", base.id)
      .order("sort_order"),
    db
      .from("album_contest_log")
      .select("at, detail")
      .eq("contest_id", base.id)
      .eq("kind", "nominations_closed")
      .order("id", { ascending: false })
      .limit(1),
    db.rpc("album_now"),
  ]);

  return json({
    contest,
    server_now: nowRow,
    ranking,
    // What the ranking looked like at the emcee's cutoff (round 1 closed).
    frozen_ranking: contest.phase !== "nominating" && frozen?.[0] ? frozen[0] : null,
    contestants: (entries ?? []).map((e) => ({
      media_id: e.media_id,
      label: e.label,
      sort_order: e.sort_order,
      final_likes: e.final_likes,
      final_voters: e.final_voters,
      // deno-lint-ignore no-explicit-any
      thumb_path: (e as any).album_media?.thumb_path || (e as any).album_media?.storage_path,
      // deno-lint-ignore no-explicit-any
      uploader_name: (e as any).album_media?.uploader_name ?? "",
    })),
  });
}

const ACTIONS = new Set([
  "host_votes",
  "set_finalist",
  "set_label",
  "close_nominations",
  "reopen_nominations",
  "start_voting",
  "start_countdown",
  "stop_voting",
  "reset",
]);

export async function handleContestAction(req: Request, slug: string): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }
  const action = String(body.action ?? "");
  if (!ACTIONS.has(action)) return badRequest("unknown action");

  const contest = await contestFor(auth.event_id);
  const args: Record<string, unknown> = { ...body };
  delete args.action;
  if (action === "close_nominations") {
    // The frozen ranking is computed here, never taken from the browser.
    args.snapshot = await nominationRanking(auth.event_id, contest.id);
  }

  const { data, error } = await admin(contest.id, action, args);
  if (error) {
    // Phase-rule refusals ("not allowed during voting") come back as 409.
    return json({ error: error.message }, { status: 409 });
  }
  return json({ contest: data });
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function handleContestLog(req: Request, slug: string): Promise<Response> {
  const auth = await requireHost(req, slug);
  if (!auth) return unauthorized();
  const contest = await contestFor(auth.event_id);

  const db = supabaseAdmin();
  const lines = ["id,time_utc,kind,photo_id,phone_id,count,detail"];
  for (let after = 0; ; ) {
    const { data, error } = await db
      .from("album_contest_log")
      .select("id, at, kind, media_id, device_id, n, detail")
      .eq("contest_id", contest.id)
      .gt("id", after)
      .order("id")
      .limit(1000);
    if (error) return json({ error: error.message }, { status: 500 });
    for (const r of data ?? []) {
      lines.push([r.id, r.at, r.kind, r.media_id, r.device_id, r.n, r.detail].map(csvCell).join(","));
      after = r.id;
    }
    if (!data || data.length < 1000) break;
  }
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${slug}-best-dress-log.csv"`,
      "access-control-allow-origin": "*",
    },
  });
}
