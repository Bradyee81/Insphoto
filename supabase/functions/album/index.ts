// Single entry point for the `album` Edge Function. Serves all three
// surfaces' HTML/CSS/JS and the small JSON API that needs server-only
// secrets (R2 keys, service-role key, token secret). See insphotoPRD.md and
// the build plan for the full picture.

import { corsPreflight, notFound } from "./lib/respond.ts";
import {
  serveAdminPage,
  serveConsolePage,
  serveGuestPage,
  serveLedPage,
  tryServeAsset,
} from "./routes/pages.ts";
import { handlePresign } from "./routes/presign.ts";
import { handleGuestDelete } from "./routes/media.ts";
import { handleCreateEvent } from "./routes/admin.ts";
import {
  handleFeed,
  handleHostExport,
  handleHostMediaApprove,
  handleHostMediaDelete,
  handleHostMediaFeature,
  handleHostMediaHide,
  handleHostSettings,
  handleHostStats,
  handleLogin,
} from "./routes/host.ts";

// Requests arrive as .../functions/v1/album/<rest> (or, behind a custom
// domain routing straight at the function, just /<rest>). Normalize to the
// logical path used by the route table below either way.
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
    // Static assets first — they share the /e /h /s prefixes with the page routes.
    const asset = await tryServeAsset(path);
    if (asset) return asset;

    // Pages
    let m: RegExpMatchArray | null;
    if (method === "GET" && (m = path.match(/^\/e\/([^/]+)$/))) {
      return await serveGuestPage(m[1]);
    }
    if (method === "GET" && (m = path.match(/^\/h\/([^/]+)$/))) {
      return await serveConsolePage(m[1]);
    }
    if (method === "GET" && (m = path.match(/^\/s\/([^/]+)$/))) {
      return await serveLedPage(m[1]);
    }
    if (method === "GET" && path === "/admin") {
      return await serveAdminPage();
    }

    // API
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
    if (method === "GET" && (m = path.match(/^\/api\/host\/([^/]+)\/feed$/))) {
      return await handleFeed(req, m[1]);
    }
    if (method === "GET" && (m = path.match(/^\/api\/host\/([^/]+)\/stats$/))) {
      return await handleHostStats(req, m[1]);
    }
    if (method === "GET" && (m = path.match(/^\/api\/host\/([^/]+)\/export\.zip$/))) {
      return await handleHostExport(req, m[1]);
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
