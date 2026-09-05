// Loaded after the supabase-js UMD CDN script. Anon key + URLs here are
// public/publishable by design (PRD §4) — nothing secret lives client-side.
//
// The static pages are served from Cloudflare Pages, not from Supabase —
// Supabase Edge Functions force any HTML GET response down to text/plain on
// their shared *.supabase.co domain (an anti-phishing measure, not something
// this app can opt out of), so the HTML/CSS/JS live here instead and the
// Edge Function is a pure JSON API. That means API calls are cross-origin,
// hence an absolute URL below rather than a same-origin relative path. CORS
// on the function already allows this (access-control-allow-origin: *).
(function () {
  const SUPABASE_URL = "https://pqhstyhtakohvwfjpmmf.supabase.co";
  const ANON_KEY = "sb_publishable_EEzW55bkKAsvOLznhe6j5g_We-O-p8u";
  const FUNCTIONS_BASE = "https://pqhstyhtakohvwfjpmmf.supabase.co/functions/v1/album";
  const R2_PUBLIC_BASE = "https://cdn.insphoto.my";

  const client = window.supabase.createClient(SUPABASE_URL, ANON_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
  });

  function mediaUrl(key) {
    if (!key) return null;
    return `${R2_PUBLIC_BASE}/${key}`;
  }

  window.Insphoto = {
    supabase: client,
    apiPath: (p) => FUNCTIONS_BASE + p,
    mediaUrl,
  };
})();
