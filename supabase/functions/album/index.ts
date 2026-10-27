// Single entry point for the `album` Edge Function — a pure JSON API.
//
// The three surfaces' HTML/CSS/JS are served from Cloudflare Pages instead
// of from here: Supabase Edge Functions force any text/html GET response
// down to text/plain with a sandboxed CSP on the shared *.supabase.co
// domain (a deliberate anti-phishing measure, confirmed against the real
// deployment — see the note in web/shared/supabase-init.js). This function
// now only handles routes that need secrets a browser must never see (R2
// keys, service-role key, token secret). See insphotoPRD.md and the build
// plan for the full picture.

import { corsPreflight, notFound } from "./lib/respond.ts";
import { handlePresign } from "./routes/presign.ts";
import { handleGuestDelete } from "./routes/media.ts";
import { handleCreateEvent } from "./routes/admin.ts";
import {
  handlePhotogAttachOriginal,
  handlePhotogCreateMedia,
  handlePhotogLogin,
  handlePhotogPresign,
} from "./routes/photog.ts";
import { handleContestAction, handleContestGet, handleContestLog } from "./routes/contest.ts";
import {
  handleFeed,
  handleHostExportList,
  handleSetPhotogPin,
  handleHostMediaApprove,
  handleHostMediaDelete,
  handleHostMediaFeature,
  handleHostMediaHide,
  handleHostSettings,
  handleHostStats,
  handleLogin,
} from "./routes/host.ts";

// Requests arrive as .../functions/v1/album/<rest>. Normalize to the
// logical path used by the route table below.
function logicalPath(pathname: string): string {
  const marker = "/album";
  const idx = pathname.indexOf(marker);
  if (idx === -1) return pathname || "/";
  const rest = pathname.slice(idx + marker.length);
  return rest || "/";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight();

  const url = new URL(req.url);
  const path = logicalPath(url.pathname);
  const method = req.method;

  try {
    let m: RegExpMatchArray | null;

    if (method === "POST" && path === "/api/presign") {
      return await handlePresign(req);
    }
    if (method === "POST" && (m = path.match(/^\/api\/media\/([^/]+)\/delete$/))) {
      return await handleGuestDelete(req, m[1]);
    }
    if (method === "POST" && path === "/api/admin/events") {
      return await handleCreateEvent(req);
    }
    if (method === "POST" && path === "/api/host/login") {
      return await handleLogin(req);
    }
    if (method === "POST" && path === "/api/photog/login") {
      return await handlePhotogLogin(req);
    }
    if (method === "POST" && (m = path.match(/^\/api\/photog\/([^/]+)\/presign$/))) {
      return await handlePhotogPresign(req, m[1]);
    }
    if (method === "POST" && (m = path.match(/^\/api\/photog\/([^/]+)\/media$/))) {
      return await handlePhotogCreateMedia(req, m[1]);
    }
    if (method === "POST" && (m = path.match(/^\/api\/photog\/([^/]+)\/media\/([^/]+)\/original$/))) {
      return await handlePhotogAttachOriginal(req, m[1], m[2]);
    }
    if (method === "GET" && (m = path.match(/^\/api\/host\/([^/]+)\/contest$/))) {
      return await handleContestGet(req, m[1]);
    }
    if (method === "POST" && (m = path.match(/^\/api\/host\/([^/]+)\/contest$/))) {
      return await handleContestAction(req, m[1]);
    }
    if (method === "GET" && (m = path.match(/^\/api\/host\/([^/]+)\/contest\/log\.csv$/))) {
      return await handleContestLog(req, m[1]);
    }
    if (method === "GET" && (m = path.match(/^\/api\/host\/([^/]+)\/export-list$/))) {
      return await handleHostExportList(req, m[1]);
    }
    if (method === "POST" && (m = path.match(/^\/api\/host\/([^/]+)\/photog-pin$/))) {
      return await handleSetPhotogPin(req, m[1]);
    }
    if (method === "GET" && (m = path.match(/^\/api\/host\/([^/]+)\/feed$/))) {
      return await handleFeed(req, m[1]);
    }
    if (method === "GET" && (m = path.match(/^\/api\/host\/([^/]+)\/stats$/))) {
      return await handleHostStats(req, m[1]);
    }
    if (method === "POST" && (m = path.match(/^\/api\/host\/([^/]+)\/settings$/))) {
      return await handleHostSettings(req, m[1]);
    }
    if (
      method === "POST" &&
      (m = path.match(/^\/api\/host\/([^/]+)\/media\/([^/]+)\/delete$/))
    ) {
      return await handleHostMediaDelete(req, m[1], m[2]);
    }
    if (
      method === "POST" &&
      (m = path.match(/^\/api\/host\/([^/]+)\/media\/([^/]+)\/hide$/))
    ) {
      return await handleHostMediaHide(req, m[1], m[2]);
    }
    if (
      method === "POST" &&
      (m = path.match(/^\/api\/host\/([^/]+)\/media\/([^/]+)\/approve$/))
    ) {
      return await handleHostMediaApprove(req, m[1], m[2]);
    }
    if (
      method === "POST" &&
      (m = path.match(/^\/api\/host\/([^/]+)\/media\/([^/]+)\/feature$/))
    ) {
      return await handleHostMediaFeature(req, m[1], m[2]);
    }

    return notFound();
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }
});
