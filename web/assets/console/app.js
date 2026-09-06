// Console: PIN login, live grid + moderation, LED control, event setup.
// PRD §7.
(function () {
  const POLL_MS = 3000;

  const state = {
    slug: null,
    token: null,
    event: null, // full album_events row, kept live via realtime
    media: [],
    focusedIndex: -1,
    lightboxId: null,
    pollTimer: null,
    lastEsc: 0,
  };

  function tokenKey(slug) {
    return `insphoto_host_token_${slug}`;
  }

  function slugFromPath() {
    const m = location.pathname.match(/\/h\/([^/]+)$/);
    return m ? m[1] : null;
  }

  function toast(message) {
    const t = document.getElementById("toast");
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2200);
  }

  async function apiFetch(path, opts = {}) {
    const res = await fetch(window.Insphoto.apiPath(path), {
      ...opts,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${state.token}`,
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401) {
      localStorage.removeItem(tokenKey(state.slug));
      showLogin("Session expired — please sign in again.");
      throw new Error("unauthorized");
    }
    return res;
  }

  // ---------- login ----------

  function showLogin(error) {
    document.getElementById("app").hidden = true;
    document.getElementById("loginScreen").hidden = false;
    if (error) {
      const e = document.getElementById("loginError");
      e.textContent = error;
      e.hidden = false;
    }
  }

  async function attemptLogin(pin) {
    const res = await fetch(window.Insphoto.apiPath("/api/host/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: state.slug, pin }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "login failed");
    }
    const body = await res.json();
    state.token = body.token;
    state.event = body.event;
    localStorage.setItem(tokenKey(state.slug), body.token);
    startApp();
  }

  function bindLogin() {
    const input = document.getElementById("pinInput");
    const btn = document.getElementById("loginBtn");
    const doLogin = async () => {
      const pin = input.value.trim();
      if (!pin) return;
      btn.disabled = true;
      document.getElementById("loginError").hidden = true;
      try {
        await attemptLogin(pin);
      } catch (e) {
        document.getElementById("loginError").textContent = e.message;
        document.getElementById("loginError").hidden = false;
      } finally {
        btn.disabled = false;
      }
    };
    btn.addEventListener("click", doLogin);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });
  }

  // ---------- live grid ----------

  function mediaThumbUrl(m) {
    return window.Insphoto.mediaUrl(m.thumb_path || m.storage_path);
  }

  function renderGrid() {
    const grid = document.getElementById("grid");
    grid.innerHTML = "";
    state.media.forEach((m, i) => {
      const tile = document.createElement("div");
      tile.className = "gtile" + (i === state.focusedIndex ? " focused" : "");
      tile.dataset.id = m.id;

      const img = document.createElement("img");
      img.src = mediaThumbUrl(m);
      tile.appendChild(img);

      if (m.status !== "approved") {
        const s = document.createElement("span");
        s.className = `gstatus ${m.status}`;
        s.textContent = m.status;
        tile.appendChild(s);
      }
      if (m.featured) {
        const f = document.createElement("span");
        f.className = "gfeatured";
        f.textContent = "★";
        tile.appendChild(f);
      }
      const meta = document.createElement("div");
      meta.className = "gmeta";
      meta.textContent = `${m.uploader_name || "Anonymous"} · ${window.InsphotoFormat.relativeTime(m.created_at)}`;
      tile.appendChild(meta);

      tile.addEventListener("click", () => {
        state.focusedIndex = i;
        openLightbox(m.id);
      });
      grid.appendChild(tile);
    });
    document.getElementById("hStats").textContent = `${state.media.length} photos`;
  }

  async function pollFeed() {
    try {
      const res = await apiFetch(`/api/host/${state.slug}/feed`);
      if (!res.ok) return;
      const body = await res.json();
      state.media = body.media || [];
      renderGrid();
    } catch {
      /* apiFetch already handled 401 */
    }
  }

  function startPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollFeed, POLL_MS);
    pollFeed();
  }

  // ---------- lightbox / moderation ----------

  function openLightbox(id) {
    const m = state.media.find((x) => x.id === id);
    if (!m) return;
    state.lightboxId = id;
    const box = document.getElementById("lightbox");
    const mediaEl = document.getElementById("lbMedia");
    mediaEl.innerHTML = "";
    if (m.kind === "video") {
      const v = document.createElement("video");
      v.src = window.Insphoto.mediaUrl(m.storage_path);
      v.controls = true;
      mediaEl.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.src = window.Insphoto.mediaUrl(m.storage_path);
      mediaEl.appendChild(img);
    }
    document.getElementById("lbUploader").textContent = m.uploader_name || "Anonymous";
    document.getElementById("lbTime").textContent = window.InsphotoFormat.relativeTime(m.created_at);
    document.getElementById("lbLikes").textContent = window.InsphotoFormat.likeLabel(m.like_count, m.liker_count);
    document.getElementById("lbStatus").textContent = m.status;
    box.hidden = false;
  }

  function closeLightbox() {
    document.getElementById("lightbox").hidden = true;
    document.getElementById("lbMedia").innerHTML = "";
    state.lightboxId = null;
  }

  async function moderate(action) {
    if (!state.lightboxId) return;
    try {
      await apiFetch(`/api/host/${state.slug}/media/${state.lightboxId}/${action}`, { method: "POST" });
      toast(`${action} ok`);
      if (action === "delete" || action === "hide") closeLightbox();
      pollFeed();
    } catch {
      /* handled */
    }
  }

  // ---------- LED control ----------

  function renderLedTab() {
    const e = state.event;
    if (!e) return;
    document.querySelectorAll(".scene-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.scene === e.led_scene);
    });
    document.getElementById("currentScene").textContent = e.led_scene;
    document.getElementById("holdToggle").checked = !!e.led_hold;
    document.getElementById("delayInput").value = e.led_delay_seconds;
  }

  async function setScene(scene) {
    try {
      const res = await apiFetch(`/api/host/${state.slug}/settings`, {
        method: "POST",
        body: JSON.stringify({ led_scene: scene }),
      });
      if (res.ok) {
        state.event.led_scene = scene;
        renderLedTab();
      }
    } catch {
      /* handled */
    }
  }

  async function panic() {
    await setScene("blank");
    toast("LED blanked");
  }

  async function toggleHold(hold) {
    try {
      await apiFetch(`/api/host/${state.slug}/settings`, {
        method: "POST",
        body: JSON.stringify({ led_hold: hold }),
      });
      state.event.led_hold = hold;
    } catch {
      /* handled */
    }
  }

  async function saveDelay() {
    const seconds = parseInt(document.getElementById("delayInput").value, 10) || 0;
    try {
      await apiFetch(`/api/host/${state.slug}/settings`, {
        method: "POST",
        body: JSON.stringify({ led_delay_seconds: seconds }),
      });
      state.event.led_delay_seconds = seconds;
      toast("Delay saved");
    } catch {
      /* handled */
    }
  }

  // ---------- event setup ----------

  function guestUrl() {
    // The guest page is on this same Cloudflare Pages site — unlike API
    // calls, which go to the separate Supabase origin (see apiPath).
    return `${location.origin}/e/${state.slug}`;
  }

  function renderQr() {
    const container = document.getElementById("qr");
    container.innerHTML = "";
    const canvas = document.createElement("canvas");
    container.appendChild(canvas);
    window.QRCode.toCanvas(canvas, guestUrl(), { width: 180, margin: 1 });
    document.getElementById("guestLink").value = guestUrl();
  }

  function downloadQr() {
    window.QRCode.toDataURL(guestUrl(), { width: 900, margin: 2 }, (err, dataUrl) => {
      if (err) return console.error(err);
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${state.slug}-qr.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  async function refreshStats() {
    try {
      const res = await apiFetch(`/api/host/${state.slug}/stats`);
      if (!res.ok) return;
      const s = await res.json();
      const list = document.getElementById("statsList");
      list.innerHTML = "";
      const rows = [
        ["Photos", s.photos],
        ["Contributors", s.contributors],
        ["Pending review", s.pending],
        ["Storage used", window.InsphotoFormat.bytesLabel(s.bytes)],
      ];
      for (const [label, value] of rows) {
        const li = document.createElement("li");
        li.textContent = `${label}: ${value}`;
        list.appendChild(li);
      }
    } catch {
      /* handled */
    }
  }

  function fillSettingsForm() {
    const e = state.event;
    document.getElementById("tUploadOpen").checked = e.upload_open;
    document.getElementById("tGalleryPublic").checked = e.gallery_public;
    document.getElementById("tModeration").checked = e.moderation;
    document.getElementById("tAllowVideo").checked = e.allow_video;
    document.getElementById("tAllowGuestDelete").checked = e.allow_guest_delete;
    document.getElementById("fName").value = e.name || "";
    document.getElementById("fTagline").value = e.tagline || "";
    document.getElementById("fHostName").value = e.host_name || "";
    document.getElementById("fWelcome").value = e.welcome_message || "";
    document.getElementById("fBrandColor").value = e.brand_color || "#0F766E";
    document.getElementById("fAccentColor").value = e.accent_color || "#F59E0B";
  }

  async function saveSettings() {
    const patch = {
      upload_open: document.getElementById("tUploadOpen").checked,
      gallery_public: document.getElementById("tGalleryPublic").checked,
      moderation: document.getElementById("tModeration").checked,
      allow_video: document.getElementById("tAllowVideo").checked,
      allow_guest_delete: document.getElementById("tAllowGuestDelete").checked,
      name: document.getElementById("fName").value.trim(),
      tagline: document.getElementById("fTagline").value.trim(),
      host_name: document.getElementById("fHostName").value.trim(),
      welcome_message: document.getElementById("fWelcome").value.trim(),
      brand_color: document.getElementById("fBrandColor").value,
      accent_color: document.getElementById("fAccentColor").value,
    };
    const status = document.getElementById("saveStatus");
    try {
      const res = await apiFetch(`/api/host/${state.slug}/settings`, {
        method: "POST",
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const body = await res.json();
        state.event = body.event;
        status.textContent = "Saved";
        setTimeout(() => (status.textContent = ""), 2000);
        document.getElementById("hEventName").textContent = state.event.name;
      }
    } catch {
      /* handled */
    }
  }

  async function exportZip() {
    toast("Preparing download…");
    try {
      const res = await apiFetch(`/api/host/${state.slug}/export.zip`);
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${state.slug}-album.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.error(e);
      toast("Export failed");
    }
  }

  // ---------- tabs & keyboard ----------

  function switchTab(name) {
    document.querySelectorAll(".ctab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".ctab-panel").forEach((p) => p.classList.remove("active"));
    document.getElementById(`ctab-${name}`).classList.add("active");
    if (name === "setup") {
      try {
        renderQr();
      } catch (e) {
        console.error("QR render failed", e);
      }
      refreshStats();
    }
  }

  function moveFocus(delta) {
    if (state.media.length === 0) return;
    state.focusedIndex = Math.max(0, Math.min(state.media.length - 1, state.focusedIndex + delta));
    renderGrid();
    const el = document.querySelector(`.gtile[data-id="${state.media[state.focusedIndex].id}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);

      if (e.key === "Escape") {
        if (!document.getElementById("lightbox").hidden) {
          closeLightbox();
          return;
        }
        const now = Date.now();
        if (now - state.lastEsc < 600) {
          panic();
          state.lastEsc = 0;
        } else {
          state.lastEsc = now;
        }
        return;
      }

      if (typing) return;

      if (!document.getElementById("app").hidden && document.getElementById("ctab-grid").classList.contains("active")) {
        const cols = Math.max(1, Math.floor(document.getElementById("grid").clientWidth / 148));
        if (e.key === "ArrowRight") moveFocus(1);
        else if (e.key === "ArrowLeft") moveFocus(-1);
        else if (e.key === "ArrowDown") moveFocus(cols);
        else if (e.key === "ArrowUp") moveFocus(-cols);
        else if (e.key === "Enter" && state.focusedIndex >= 0) {
          openLightbox(state.media[state.focusedIndex].id);
        }
      }

      if (["1", "2", "6"].includes(e.key)) {
        const map = { 1: "wall", 2: "ranking", 6: "blank" };
        setScene(map[e.key]);
      }
    });
  }

  function bindStaticUI() {
    document.querySelectorAll(".ctab").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
    document.getElementById("panicBtn").addEventListener("click", panic);
    document.getElementById("lbClose").addEventListener("click", closeLightbox);
    document.getElementById("lbApprove").addEventListener("click", () => moderate("approve"));
    document.getElementById("lbHide").addEventListener("click", () => moderate("hide"));
    document.getElementById("lbFeature").addEventListener("click", () => moderate("feature"));
    document.getElementById("lbDelete").addEventListener("click", () => {
      if (confirm("Permanently delete this photo?")) moderate("delete");
    });
    document.querySelectorAll(".scene-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!btn.disabled) setScene(btn.dataset.scene);
      });
    });
    document.getElementById("holdToggle").addEventListener("change", (e) => toggleHold(e.target.checked));
    document.getElementById("delaySave").addEventListener("click", saveDelay);
    document.getElementById("copyLink").addEventListener("click", () => {
      navigator.clipboard.writeText(guestUrl());
      toast("Link copied");
    });
    document.getElementById("downloadQr").addEventListener("click", downloadQr);
    document.getElementById("exportZip").addEventListener("click", exportZip);
    document.getElementById("saveSettings").addEventListener("click", saveSettings);
  }

  function subscribeEventUpdates() {
    window.Insphoto.supabase
      .channel(`console-event:${state.event.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "album_events", filter: `id=eq.${state.event.id}` },
        (payload) => {
          state.event = payload.new;
          renderLedTab();
        },
      )
      .subscribe();
  }

  function startApp() {
    document.getElementById("loginScreen").hidden = true;
    document.getElementById("app").hidden = false;
    document.getElementById("hEventName").textContent = state.event.name;
    fillSettingsForm();
    renderLedTab();
    subscribeEventUpdates();
    startPolling();
  }

  async function tryResumeSession() {
    const token = localStorage.getItem(tokenKey(state.slug));
    if (!token) return showLogin();
    state.token = token;
    const { data: event, error } = await window.Insphoto.supabase
      .from("album_events")
      .select("*")
      .eq("slug", state.slug)
      .single();
    if (error || !event) return showLogin("Event not found.");
    state.event = event;
    // Confirm the token still works before showing the app.
    try {
      const res = await apiFetch(`/api/host/${state.slug}/feed`);
      if (!res.ok) return showLogin();
      startApp();
    } catch {
      /* apiFetch already redirected to login on 401 */
    }
  }

  function boot() {
    state.slug = slugFromPath();
    if (!state.slug) {
      document.body.innerHTML = "<p style='padding:40px'>Event not found.</p>";
      return;
    }
    document.getElementById("loginEventName").textContent = state.slug;
    bindLogin();
    bindStaticUI();
    bindKeyboard();
    tryResumeSession();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
