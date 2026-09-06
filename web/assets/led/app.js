// LED display: read-only, fullscreen, driven entirely by the console via
// Realtime. PRD §8. No alert/confirm/dialog anywhere in this file — a
// blocking dialog on the LED is an incident (§8.4).
(function () {
  const ELIGIBILITY_CHECK_MS = 5000;
  const PHOTO_MS = 7000;
  const VIDEO_MAX_MS = 20000;
  const RANKING_REFRESH_MS = 15000;
  const CACHE_LIMIT = 100;
  const RECONNECT_BASE_MS = 1000;
  const FORCE_RELOAD_AFTER_DISCONNECT_MS = 60000;

  const state = {
    slug: null,
    event: null,
    allMedia: new Map(), // id -> row
    cachedPool: [], // ids, capped at CACHE_LIMIT, most-recent-eligible first
    priorityQueue: [], // ids that just became eligible, shown next with a badge
    badgeShown: new Set(),
    rotationIndex: 0,
    rotationTimer: null,
    eligibilityTimer: null,
    rankingTimer: null,
    disconnectTimer: null,
    reconnectAttempt: 0,
    channel: null,
  };

  function slugFromPath() {
    const m = location.pathname.match(/\/s\/([^/]+)$/);
    return m ? m[1] : null;
  }

  function isEligible(row) {
    if (!row || row.status !== "approved") return false;
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    return ageMs > (state.event.led_delay_seconds || 0) * 1000;
  }

  function guestUrl() {
    // The guest page is on this same Cloudflare Pages site — unlike API
    // calls, which go to the separate Supabase origin (see apiPath).
    return `${location.origin}/e/${state.slug}`;
  }

  function renderJoinCard() {
    const el = document.getElementById("joinQr");
    el.innerHTML = "";
    const canvas = document.createElement("canvas");
    el.appendChild(canvas);
    window.QRCode.toCanvas(canvas, guestUrl(), { width: 120, margin: 1 });
  }

  // ---------- scene switching ----------

  function showScene(name) {
    document.querySelectorAll(".scene").forEach((s) => s.classList.remove("active"));
    if (name === "wall") document.getElementById("scene-wall").classList.add("active");
    else if (name === "ranking") document.getElementById("scene-ranking").classList.add("active");
    else if (name === "blank") document.getElementById("scene-blank").classList.add("active");
    else {
      document.getElementById("placeholderText").textContent =
        name === "winner"
          ? "Winner reveal — coming in Sprint 2"
          : name === "sponsor"
            ? "Sponsor slate — coming in Sprint 3"
            : name === "countdown"
              ? "Countdown — coming in Sprint 2"
              : "";
      document.getElementById("scene-placeholder").classList.add("active");
    }
  }

  function applyScene() {
    clearInterval(state.rankingTimer);
    const scene = state.event.led_scene || "wall";
    showScene(scene);
    if (scene === "wall") {
      startRotation();
    } else {
      clearTimeout(state.rotationTimer);
      if (scene === "ranking") {
        renderRanking();
        state.rankingTimer = setInterval(renderRanking, RANKING_REFRESH_MS);
      }
    }
  }

  // ---------- wall scene rotation ----------

  function pushToCache(id) {
    const existing = state.cachedPool.indexOf(id);
    if (existing !== -1) state.cachedPool.splice(existing, 1);
    state.cachedPool.unshift(id);
    if (state.cachedPool.length > CACHE_LIMIT) state.cachedPool.pop();
  }

  function recomputeEligibility() {
    if (!state.event) return;
    for (const row of state.allMedia.values()) {
      if (isEligible(row) && !state.cachedPool.includes(row.id)) {
        pushToCache(row.id);
        if (!state.badgeShown.has(row.id)) {
          state.priorityQueue.push(row.id);
        }
      }
    }
  }

  function removeFromRotation(id) {
    state.allMedia.delete(id);
    const ci = state.cachedPool.indexOf(id);
    if (ci !== -1) state.cachedPool.splice(ci, 1);
    state.priorityQueue = state.priorityQueue.filter((x) => x !== id);
    state.badgeShown.delete(id);
  }

  function currentWallRow() {
    if (state.priorityQueue.length > 0) {
      const id = state.priorityQueue.shift();
      state.badgeShown.add(id);
      return { row: state.allMedia.get(id), justAdded: true };
    }
    if (state.cachedPool.length === 0) return { row: null, justAdded: false };
    state.rotationIndex = state.rotationIndex % state.cachedPool.length;
    const id = state.cachedPool[state.rotationIndex];
    state.rotationIndex++;
    return { row: state.allMedia.get(id), justAdded: false };
  }

  function renderWall(row, justAdded) {
    const img = document.getElementById("wallImg");
    const video = document.getElementById("wallVideo");
    const backdrop = document.getElementById("wallBackdrop");
    const badge = document.getElementById("justAdded");
    const url = window.Insphoto.mediaUrl(row.storage_path);

    if (row.kind === "video") {
      img.hidden = true;
      video.hidden = false;
      video.src = url;
      video.currentTime = 0;
      video.play().catch(() => {});
      backdrop.style.backgroundImage = "none";
    } else {
      video.hidden = true;
      video.pause();
      img.hidden = false;
      img.src = url;
      backdrop.style.backgroundImage = `url(${url})`;
    }

    document.getElementById("wallUploader").textContent = row.uploader_name || "";
    document.getElementById("wallCaption").textContent = row.caption || "";

    if (justAdded) {
      badge.hidden = false;
      badge.classList.remove("just-added");
      void badge.offsetWidth;
      badge.classList.add("just-added");
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function scheduleNextWallTick(row) {
    clearTimeout(state.rotationTimer);
    const ms = row && row.kind === "video" ? VIDEO_MAX_MS : PHOTO_MS;
    state.rotationTimer = setTimeout(advanceWall, ms);
  }

  function advanceWall() {
    const { row, justAdded } = currentWallRow();
    if (!row) {
      scheduleNextWallTick(null);
      return;
    }
    renderWall(row, justAdded);
    scheduleNextWallTick(row);
  }

  function startRotation() {
    clearTimeout(state.rotationTimer);
    advanceWall();
  }

  // ---------- ranking scene ----------

  async function renderRanking() {
    if (!state.event) return;
    let rows;
    try {
      const { data, error } = await window.Insphoto.supabase
        .from("album_media")
        .select("*")
        .eq("event_id", state.event.id)
        .order("liker_count", { ascending: false })
        .order("like_count", { ascending: false })
        .limit(9);
      if (error) throw error;
      rows = data;
    } catch {
      return; // keep whatever is on screen — no error UI on the LED, ever
    }

    const grid = document.getElementById("rankingGrid");
    grid.innerHTML = "";
    rows.forEach((row, i) => {
      const tile = document.createElement("div");
      tile.className = "rank-tile";
      const img = document.createElement("img");
      img.src = window.Insphoto.mediaUrl(row.thumb_path || row.storage_path);
      tile.appendChild(img);
      const num = document.createElement("div");
      num.className = "rank-num";
      num.textContent = String(i + 1);
      tile.appendChild(num);
      const cap = document.createElement("div");
      cap.className = "rank-caption";
      cap.textContent = window.InsphotoFormat.likeLabel(row.like_count, row.liker_count);
      tile.appendChild(cap);
      grid.appendChild(tile);
    });
  }

  // ---------- data loading & realtime ----------

  async function loadInitialMedia() {
    try {
      const { data, error } = await window.Insphoto.supabase
        .from("album_media")
        .select("*")
        .eq("event_id", state.event.id)
        .eq("status", "approved")
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      for (const row of data) {
        state.allMedia.set(row.id, row);
        if (isEligible(row)) {
          pushToCache(row.id);
          state.badgeShown.add(row.id); // don't badge-flash the pre-existing backlog on load
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  function clearDisconnectTimer() {
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
  }

  function armDisconnectTimer() {
    if (state.disconnectTimer) return;
    state.disconnectTimer = setTimeout(() => location.reload(), FORCE_RELOAD_AFTER_DISCONNECT_MS);
  }

  function subscribe() {
    if (state.channel) {
      window.Insphoto.supabase.removeChannel(state.channel);
    }
    const channel = window.Insphoto.supabase
      .channel(`led:${state.event.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "album_media", filter: `event_id=eq.${state.event.id}` },
        (payload) => {
          if (payload.new.status === "approved") state.allMedia.set(payload.new.id, payload.new);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "album_media", filter: `event_id=eq.${state.event.id}` },
        (payload) => {
          if (payload.new.status === "approved") state.allMedia.set(payload.new.id, payload.new);
          else removeFromRotation(payload.new.id);
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "album_media", filter: `event_id=eq.${state.event.id}` },
        (payload) => removeFromRotation(payload.old.id),
      )
      .on("broadcast", { event: "media_hidden" }, (msg) => removeFromRotation(msg.payload.id))
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "album_events", filter: `id=eq.${state.event.id}` },
        (payload) => {
          state.event = payload.new;
          applyScene();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          state.reconnectAttempt = 0;
          clearDisconnectTimer();
        } else if (["TIMED_OUT", "CLOSED", "CHANNEL_ERROR"].includes(status)) {
          armDisconnectTimer();
          const delay = Math.min(30000, RECONNECT_BASE_MS * 2 ** state.reconnectAttempt);
          state.reconnectAttempt++;
          setTimeout(subscribe, delay);
        }
      });
    state.channel = channel;
  }

  function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    navigator.wakeLock.request("screen").catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        navigator.wakeLock.request("screen").catch(() => {});
      }
    });
  }

  async function boot() {
    state.slug = slugFromPath();
    if (!state.slug) return;

    const { data: event, error } = await window.Insphoto.supabase
      .from("album_events")
      .select("*")
      .eq("slug", state.slug)
      .single();
    if (error || !event) return; // silent — no dialog, just stays blank

    state.event = event;
    // The join-card QR is a nice-to-have; the photo wall is the whole
    // point. An uncaught throw here (e.g. the QR library failing to load)
    // must never take the wall down with it — wrap every non-essential
    // step so a failure in one can't silently cancel everything after it.
    try {
      renderJoinCard();
    } catch (e) {
      console.error("join card failed", e);
    }
    await loadInitialMedia();
    applyScene();
    subscribe();
    try {
      requestWakeLock();
    } catch (e) {
      console.error("wake lock failed", e);
    }

    state.eligibilityTimer = setInterval(recomputeEligibility, ELIGIBILITY_CHECK_MS);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
