// Loaded after the supabase-js UMD CDN script. Anon key + URLs here are
// public/publishable by design (PRD §4) — nothing secret lives client-side.
(function () {
  const SUPABASE_URL = "https://pqhstyhtakohvwfjpmmf.supabase.co";
  const ANON_KEY = "sb_publishable_EEzW55bkKAsvOLznhe6j5g_We-O-p8u";
  const R2_PUBLIC_BASE = "https://cdn.insphoto.my";

  const client = window.supabase.createClient(SUPABASE_URL, ANON_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
  });

  // Requests to /e/:slug, /h/:slug, /s/:slug may be served either at the
  // project's default functions path (/functions/v1/album/...) or from a
  // custom domain mounted at the function root. Work out the right prefix
  // for same-origin API calls either way.
  function functionRoot() {
    const marker = "/album";
    const idx = location.pathname.indexOf(marker);
    if (idx === -1) return "";
    return location.pathname.slice(0, idx + marker.length);
  }

  function mediaUrl(key) {
    if (!key) return null;
    return `${R2_PUBLIC_BASE}/${key}`;
  }

  window.Insphoto = {
    supabase: client,
    apiPath: (p) => functionRoot() + p,
    mediaUrl,
  };
})();
