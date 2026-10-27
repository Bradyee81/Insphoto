// Console: PIN login, live grid + moderation, LED control, event setup.
// PRD §7. The Best Dress tab lives in contest.js.
(function () {
  const POLL_MS = 3000;
  const FULL_RELOAD_MS = 60000;

  const state = {
    slug: null,
    token: null,
    event: null, // full album_events row, kept live via realtime
    media: [], // newest first
    byId: new Map(),
    cursor: null, // updated_at of the newest change we have seen
    lastFull: 0,
    filter: "all",
    focusedIndex: -1,
    lightboxId: null,
    pollTimer: null,
    lastEsc: 0,
    tiles: new Map(), // id -> tile element
    gridSig: "",
  };

  function tokenKey(slug) {
    return `insphoto_host_token_${slug}`;
  }

  const LAST_SLUG_KEY = "insphoto_console_last_slug";

  // The installed console app always opens at /h/ (an app's start address
  // can't carry the event). Reopen the last event this computer ran.
  function slugFromPath() {
    const m = location.pathname.match(/\/h\/([^/]+)$/);
    if (m) {
      try {
        localStorage.setItem(LAST_SLUG_KEY, m[1]);
      } catch {
        /* storage blocked — the app just won't remember the event */
      }
      return m[1];
    }
    let last = null;
    try {
      last = localStorage.getItem(LAST_SLUG_KEY);
    } catch {
      /* ignore */
    }
    if (last) history.replaceState(null, "", `/h/${last}`);
    return last;
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

  async function saveSettingsPatch(patch) {
    const res = await apiFetch(`/api/host/${state.slug}/settings`, {
      method: "POST",
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error("save failed");
    const body = await res.json();
    state.event = body.event;
    renderLedTab();
    return body.event;
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
    localStorage.setItem(tokenKey(state.slug), body.token);
    // The login response only carries a few columns; load the full row.
    const { data: event } = await window.Insphoto.supabase
      .from("album_events")
      .select("*")
      .eq("slug", state.slug)
      .single();
    state.event = event || body.event;
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

  function visibleMedia() {
    switch (state.filter) {
      case "photographer":
        return state.media.filter((m) => m.source === "photographer");
      case "guest":
        return state.media.filter((m) => m.source !== "photographer");
      case "featured":
        return state.media.filter((m) => m.featured);
      default:
        return state.media;
    }
  }

  function buildTile(m) {
    const tile = document.createElement("div");
    tile.className = "gtile";
    tile.dataset.id = m.id;

    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = mediaThumbUrl(m);
    tile.appendChild(img);

    const src = document.createElement("span");
    src.className = "gsrc";
    tile.appendChild(src);

    const status = document.createElement("span");
    status.className = "gstatus";
    tile.appendChild(status);

    const quick = document.createElement("div");
    quick.className = "gquick";
    const star = document.createElement("button");
    star.className = "qstar";
    star.title = "Feature (★)";
    star.textContent = "★";
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      moderate("feature", m.id);
    });
    const tv = document.createElement("button");
    tv.title = "Show on screen now";
    tv.textContent = "📺";
    tv.addEventListener("click", (e) => {
      e.stopPropagation();
      showOnScreen(m.id);
    });
    quick.append(star, tv);
    tile.appendChild(quick);

    const meta = document.createElement("div");
    meta.className = "gmeta";
    tile.appendChild(meta);

    tile.addEventListener("click", () => {
      state.focusedIndex = visibleMedia().findIndex((x) => x.id === m.id);
      openLightbox(m.id);
    });
    return tile;
  }

  function updateTile(tile, m, i) {
    tile.classList.toggle("focused", i === state.focusedIndex);
    tile.classList.toggle(
      "onscreen",
      state.event && state.event.led_scene === "spotlight" && state.event.led_spotlight_media === m.id,
    );
    tile.querySelector(".gsrc").textContent = m.source === "photographer" ? "📷" : "";
    const status = tile.querySelector(".gstatus");
    status.hidden = m.status === "approved";
    status.className = `gstatus ${m.status}`;
    status.textContent = m.status;
    tile.querySelector(".qstar").classList.toggle("on", !!m.featured);
    tile.querySelector(".gmeta").textContent =
      `${m.uploader_name || "Anonymous"} · ❤️ ${m.liker_count} · ${window.InsphotoFormat.relativeTime(m.created_at)}`;
  }

  // Keyed render: tiles are created once and updated in place, so a poll
  // that only changed a like count doesn't rebuild hundreds of images.
  function renderGrid() {
    const grid = document.getElementById("grid");
    const list = visibleMedia();
    const sig = state.filter + "|" + list.map((m) => m.id).join(",");
    if (sig !== state.gridSig) {
      state.gridSig = sig;
      const frag = document.createDocumentFragment();
      const keep = new Set(list.map((m) => m.id));
      for (const [id, tile] of state.tiles) {
        if (!state.byId.has(id)) state.tiles.delete(id);
        else if (!keep.has(id)) tile.remove();
      }
      for (const m of list) {
        let tile = state.tiles.get(m.id);
        if (!tile) {
          tile = buildTile(m);
          state.tiles.set(m.id, tile);
        }
        frag.appendChild(tile);
      }
      grid.innerHTML = "";
      grid.appendChild(frag);
    }
    list.forEach((m, i) => updateTile(state.tiles.get(m.id), m, i));
    const photog = state.media.filter((m) => m.source === "photographer").length;
    const featured = state.media.filter((m) => m.featured).length;
    document.getElementById("hStats").textContent =
      `${state.media.length} photos · 📷 ${photog} · ★ ${featured}`;
  }

  function mergeRows(rows, full) {
    if (full) {
      state.byId = new Map(rows.map((r) => [r.id, r]));
    } else {
      for (const r of rows) state.byId.set(r.id, r);
    }
    state.media = [...state.byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async function pollFeed(forceFull) {
    const full = forceFull || !state.cursor || Date.now() - state.lastFull > FULL_RELOAD_MS;
    try {
      const q = full ? "" : `?since=${encodeURIComponent(state.cursor)}`;
      const res = await apiFetch(`/api/host/${state.slug}/feed${q}`);
      if (!res.ok) return;
      const body = await res.json();
      mergeRows(body.media || [], full);
      if (body.cursor) state.cursor = body.cursor;
      if (full) state.lastFull = Date.now();
      renderGrid();
      if (state.lightboxId) refreshLightboxButtons();
    } catch {
      /* apiFetch already handled 401 */
    }
  }

  function startPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => pollFeed(false), POLL_MS);
    pollFeed(true);
  }

  // ---------- lightbox / moderation ----------

  function refreshLightboxButtons() {
    const m = state.byId.get(state.lightboxId);
    if (!m) return;
    const f = document.getElementById("lbFeature");
    f.textContent = m.featured ? "★ Featured (click to remove)" : "★ Feature";
    f.classList.toggle("on", !!m.featured);
    document.getElementById("lbApprove").hidden = m.status === "approved";
    document.getElementById("lbLikes").textContent = window.InsphotoFormat.likeLabel(m.like_count, m.liker_count);
    document.getElementById("lbStatus").textContent = m.status;
  }

  function openLightbox(id) {
    const m = state.byId.get(id);
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
    document.getElementById("lbUploader").textContent =
      (m.source === "photographer" ? "📷 " : "") + (m.uploader_name || "Anonymous");
    document.getElementById("lbTime").textContent = window.InsphotoFormat.relativeTime(m.created_at);
    refreshLightboxButtons();
    box.hidden = false;
  }

  function closeLightbox() {
    document.getElementById("lightbox").hidden = true;
    document.getElementById("lbMedia").innerHTML = "";
    state.lightboxId = null;
  }

  async function moderate(action, id = state.lightboxId) {
    if (!id) return;
    try {
      const res = await apiFetch(`/api/host/${state.slug}/media/${id}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error();
      if (action === "feature") {
        const body = await res.json();
        const m = state.byId.get(id);
        if (m) m.featured = body.featured;
        toast(body.featured ? "★ Featured" : "Removed from featured");
      } else {
        toast(`${action} ok`);
      }
      if (action === "delete" || action === "hide") {
        if (id === state.lightboxId) closeLightbox();
        if (action === "delete") state.byId.delete(id);
        else if (state.byId.get(id)) state.byId.get(id).status = "hidden";
        mergeRows([], false);
      }
      renderGrid();
      if (state.lightboxId) refreshLightboxButtons();
      pollFeed(false);
    } catch (e) {
      if (e.message !== "unauthorized") toast(`${action} failed — try again`);
    }
  }

  // ---------- LED control ----------

  const SCENE_NAMES = {
    wall: "Photo wall",
    ranking: "Ranking",
    contest: "Best Dress",
    spotlight: "One photo",
    blank: "Blank",
  };

  function renderLedTab() {
    const e = state.event;
    if (!e) return;
    document.querySelectorAll(".scene-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.scene === e.led_scene);
    });
    document.getElementById("currentScene").textContent = SCENE_NAMES[e.led_scene] || e.led_scene;
    document.getElementById("screenNow").innerHTML =
      `Screen: <b>${SCENE_NAMES[e.led_scene] || e.led_scene}</b>${e.led_featured_only ? " · ★ only" : ""}`;
    document.getElementById("holdToggle").checked = !!e.led_hold;
    document.getElementById("featuredOnlyToggle").checked = !!e.led_featured_only;
    document.getElementById("delayInput").value = e.led_delay_seconds;
    document.getElementById("tOriginals").checked = !!e.originals_download;

    const prev = document.getElementById("spotPreview");
    const spot = e.led_spotlight_media && state.byId.get(e.led_spotlight_media);
    prev.hidden = !(e.led_scene === "spotlight" && spot);
    if (spot) document.getElementById("spotPreviewImg").src = mediaThumbUrl(spot);
    if (state.media.length) renderGrid();
  }

  async function setScene(scene) {
    if (scene === "spotlight" && !state.event.led_spotlight_media) {
      toast("Pick a photo with 📺 first");
      return;
    }
    try {
      await saveSettingsPatch({ led_scene: scene });
    } catch (e) {
      if (e.message !== "unauthorized") toast("Could not change the screen — try again");
    }
  }

  async function showOnScreen(id) {
    try {
      await saveSettingsPatch({ led_spotlight_media: id, led_scene: "spotlight" });
      toast("📺 On screen now");
    } catch (e) {
      if (e.message !== "unauthorized") toast("Could not change the screen — try again");
    }
  }

  // ---------- desktop app: LED screen window ----------
  // Inside the InsPhoto Console desktop app (Tauri), the console can put
  // the LED screen full screen on the second display. In a plain browser
  // these buttons stay hidden and the screen is opened by its own link.

  const tauri = window.__TAURI__ && window.__TAURI__.core;

  async function openScreen() {
    try {
      toast(await tauri.invoke("open_screen", { slug: state.slug }));
    } catch (e) {
      toast(`Could not open the screen: ${e}`);
    }
  }

  async function closeScreen() {
    try {
      await tauri.invoke("close_screen");
      toast("Screen window closed");
    } catch (e) {
      toast(`Could not close the screen: ${e}`);
    }
  }

  function bindAppScreen() {
    if (!tauri) return;
    document.getElementById("openScreenBtn").hidden = false;
    document.getElementById("appScreenRow").hidden = false;
    document.getElementById("openScreenBtn").addEventListener("click", openScreen);
    document.getElementById("openScreenBtn2").addEventListener("click", openScreen);
    document.getElementById("closeScreenBtn").addEventListener("click", closeScreen);
  }

  async function panic() {
    await setScene("blank");
    toast("LED blanked");
  }

  async function toggleSetting(field, value) {
    try {
      await saveSettingsPatch({ [field]: value });
    } catch (e) {
      if (e.message !== "unauthorized") toast("Save failed — try again");
      renderLedTab();
    }
  }

  async function saveDelay() {
    const seconds = parseInt(document.getElementById("delayInput").value, 10) || 0;
    try {
      await saveSettingsPatch({ led_delay_seconds: seconds });
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

  function photogUrl() {
    return `${location.origin}/p/${state.slug}`;
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
        ["From photographer", s.photographer],
        ["Guest phones that uploaded", s.contributors],
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
    document.getElementById("tOriginals").checked = !!e.originals_download;
    document.getElementById("fName").value = e.name || "";
    document.getElementById("fTagline").value = e.tagline || "";
    document.getElementById("fHostName").value = e.host_name || "";
    document.getElementById("fWelcome").value = e.welcome_message || "";
    document.getElementById("fBrandColor").value = e.brand_color || "#0F766E";
    document.getElementById("fAccentColor").value = e.accent_color || "#F59E0B";
    document.getElementById("photogLink").value = photogUrl();
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
      await saveSettingsPatch(patch);
      status.textContent = "Saved";
      setTimeout(() => (status.textContent = ""), 2000);
      document.getElementById("hEventName").textContent = state.event.name;
    } catch {
      status.textContent = "Save failed";
    }
  }

  async function savePhotogPin() {
    const pin = document.getElementById("photogPin").value.trim();
    if (pin.length < 4) return toast("PIN must be at least 4 characters");
    try {
      const res = await apiFetch(`/api/host/${state.slug}/photog-pin`, {
        method: "POST",
        body: JSON.stringify({ pin }),
      });
      if (!res.ok) throw new Error();
      document.getElementById("photogPin").value = "";
      toast("Photographer PIN set");
    } catch {
      toast("Could not set the PIN");
    }
  }

  // Downloads every photo's best file straight into a folder the host
  // picks, one at a time. No ZIP, so there's no size limit. Needs Chrome or
  // Edge on a computer (the folder picker); elsewhere, tells the host so.
  async function exportAll() {
    const status = document.getElementById("exportStatus");
    if (!window.showDirectoryPicker) {
      status.textContent = "Please use Chrome or Edge on a computer for this.";
      return;
    }
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch {
      return; // cancelled
    }
    try {
      const res = await apiFetch(`/api/host/${state.slug}/export-list`);
      const { files } = await res.json();
      let done = 0;
      let failed = 0;
      for (const f of files) {
        status.textContent = `Downloading ${done + failed + 1} of ${files.length}…`;
        try {
          const r = await fetch(f.url);
          if (!r.ok) throw new Error();
          const handle = await dir.getFileHandle(f.name, { create: true });
          const w = await handle.createWritable();
          await r.body.pipeTo(w);
          done++;
        } catch {
          failed++;
        }
      }
      status.textContent = `Done: ${done} saved${failed ? `, ${failed} failed (run again to retry)` : ""}.`;
    } catch (e) {
      if (e.message !== "unauthorized") status.textContent = "Download failed — try again.";
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
    if (window.InsphotoConsoleContest) window.InsphotoConsoleContest.onTab(name === "contest");
  }

  function moveFocus(delta) {
    const list = visibleMedia();
    if (list.length === 0) return;
    state.focusedIndex = Math.max(0, Math.min(list.length - 1, state.focusedIndex + delta));
    renderGrid();
    const el = state.tiles.get(list[state.focusedIndex].id);
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);

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
        const list = visibleMedia();
        if (e.key === "ArrowRight") moveFocus(1);
        else if (e.key === "ArrowLeft") moveFocus(-1);
        else if (e.key === "ArrowDown") moveFocus(cols);
        else if (e.key === "ArrowUp") moveFocus(-cols);
        else if (e.key === "Enter" && state.focusedIndex >= 0 && list[state.focusedIndex]) {
          openLightbox(list[state.focusedIndex].id);
        }
      }

      const map = { 1: "wall", 2: "ranking", 3: "contest", 4: "spotlight", 6: "blank" };
      if (map[e.key]) setScene(map[e.key]);
    });
  }

  function bindStaticUI() {
    document.querySelectorAll(".ctab").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
    document.querySelectorAll(".filter").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.filter = btn.dataset.filter;
        state.focusedIndex = -1;
        document.querySelectorAll(".filter").forEach((b) => b.classList.toggle("active", b === btn));
        renderGrid();
      }),
    );
    document.getElementById("panicBtn").addEventListener("click", panic);
    document.getElementById("lbClose").addEventListener("click", closeLightbox);
    document.getElementById("lbSpot").addEventListener("click", () => {
      if (state.lightboxId) showOnScreen(state.lightboxId);
    });
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
    document.getElementById("spotBack").addEventListener("click", () => setScene("wall"));
    document.getElementById("holdToggle").addEventListener("change", (e) => toggleSetting("led_hold", e.target.checked));
    document
      .getElementById("featuredOnlyToggle")
      .addEventListener("change", (e) => toggleSetting("led_featured_only", e.target.checked));
    document.getElementById("tOriginals").addEventListener("change", (e) => {
      const on = e.target.checked;
      if (on && !confirm("Let guests download full-quality originals now? (Recommended only after the event.)")) {
        e.target.checked = false;
        return;
      }
      toggleSetting("originals_download", on);
    });
    document.getElementById("delaySave").addEventListener("click", saveDelay);
    document.getElementById("copyLink").addEventListener("click", () => {
      navigator.clipboard.writeText(guestUrl());
      toast("Link copied");
    });
    document.getElementById("copyPhotogLink").addEventListener("click", () => {
      navigator.clipboard.writeText(photogUrl());
      toast("Photographer link copied");
    });
    document.getElementById("savePhotogPin").addEventListener("click", savePhotogPin);
    document.getElementById("downloadQr").addEventListener("click", downloadQr);
    document.getElementById("exportAll").addEventListener("click", exportAll);
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
    if (window.InsphotoConsoleContest) window.InsphotoConsoleContest.start();
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
      const res = await apiFetch(`/api/host/${state.slug}/stats`);
      if (!res.ok) return showLogin();
      startApp();
    } catch {
      /* apiFetch already redirected to login on 401 */
    }
  }

  // First launch of the desktop app (or /h/ with no event): ask which event
  // to run. After that the app remembers it.
  function askForEvent() {
    document.getElementById("loginEventName").textContent = "Enter your event code";
    const input = document.getElementById("pinInput");
    input.type = "text";
    input.inputMode = "text";
    input.placeholder = "Event code, e.g. mwta72dnd";
    input.maxLength = 40;
    const go = () => {
      const slug = input.value.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) {
        document.getElementById("loginError").textContent = "That doesn't look like an event code.";
        document.getElementById("loginError").hidden = false;
        return;
      }
      location.replace(`/h/${slug}`);
    };
    document.getElementById("loginBtn").textContent = "Continue";
    document.getElementById("loginBtn").addEventListener("click", go);
    input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  }

  function boot() {
    state.slug = slugFromPath();
    if (!state.slug) {
      askForEvent();
      return;
    }
    document.getElementById("loginEventName").textContent = state.slug;
    bindLogin();
    bindStaticUI();
    bindAppScreen();
    bindKeyboard();
    tryResumeSession();
  }

  // Shared with contest.js.
  window.InsphotoConsole = {
    state,
    apiFetch,
    toast,
    mediaThumbUrl,
    setScene,
    showOnScreen,
  };

  document.addEventListener("DOMContentLoaded", boot);
})();
