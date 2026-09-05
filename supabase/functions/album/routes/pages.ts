import { readPublic } from "../lib/staticFiles.ts";
import { asset, html, notFound } from "../lib/respond.ts";

const ASSETS: Record<string, { file: string; type: string }> = {
  "/e/app.js": { file: "guest/app.js", type: "application/javascript" },
  "/e/upload.js": { file: "guest/upload.js", type: "application/javascript" },
  "/e/feed.js": { file: "guest/feed.js", type: "application/javascript" },
  "/e/photoview.js": { file: "guest/photoview.js", type: "application/javascript" },
  "/e/ranking.js": { file: "guest/ranking.js", type: "application/javascript" },
  "/e/style.css": { file: "guest/style.css", type: "text/css" },
  "/h/app.js": { file: "console/app.js", type: "application/javascript" },
  "/h/style.css": { file: "console/style.css", type: "text/css" },
  "/s/app.js": { file: "led/app.js", type: "application/javascript" },
  "/s/style.css": { file: "led/style.css", type: "text/css" },
  "/shared/supabase-init.js": { file: "shared/supabase-init.js", type: "application/javascript" },
  "/shared/device.js": { file: "shared/device.js", type: "application/javascript" },
  "/shared/format.js": { file: "shared/format.js", type: "application/javascript" },
};

export async function tryServeAsset(path: string): Promise<Response | null> {
  const entry = ASSETS[path];
  if (!entry) return null;
  const body = await readPublic(entry.file);
  return asset(body, entry.type);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;

export async function serveGuestPage(slug: string): Promise<Response> {
  if (!SLUG_RE.test(slug)) return notFound("unknown event");
  const body = await readPublic("guest/index.html");
  return html(body);
}

export async function serveConsolePage(slug: string): Promise<Response> {
  if (!SLUG_RE.test(slug)) return notFound("unknown event");
  const body = await readPublic("console/index.html");
  return html(body);
}

export async function serveLedPage(slug: string): Promise<Response> {
  if (!SLUG_RE.test(slug)) return notFound("unknown event");
  const body = await readPublic("led/index.html");
  return html(body);
}

export async function serveAdminPage(): Promise<Response> {
  const body = await readPublic("admin/index.html");
  return html(body);
}
