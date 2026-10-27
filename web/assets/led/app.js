// LED display: read-only, fullscreen, driven entirely by the console via
// Realtime. PRD §8. No alert/confirm/dialog anywhere in this file — a
// blocking dialog on the LED is an incident (§8.4).
(function () {
  const ELIGIBILITY_CHECK_MS = 5000;
  const PHOTO_MS = 7000;
  const VIDEO_MAX_MS = 20000;
  const RANKING_REFRESH_MS = 15000;
  const CONTEST_POLL_MS = 1000;
  const CLOCK_SYNC_MS = 60000;
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
    contestTimer: null,
    countdownTimer: null,
    disconnectTimer: null,
    reconnectAttempt: 0,
    channel: null,
    clockOffsetMs: 0, // server time minus this machine's time
    contest: null, // album_contests row
    contestCounts: new Map(), // media_id -> last shown count, for the bump animation
  };

  function serverNow() {
    return Date.now() + state.clockOffsetMs;
  }

  async function syncClock() {
    try {
      const t0 = Date.now();
      const { data, error } = await window.Insphoto.supabase.rpc("album_now");
      if (error || !data) return;
      const t1 = Date.now();
      state.clockOffsetMs = new Date(data).getTime() - (t0 + t1) / 2;
    } catch {
      /* keep the last offset */
    }
  }

  function slugFromPath() {
    const m = location.pathname.match(/\/s\/([^/]+)$/);
    return m ? m[1] : null;
  }

  // Featured-only mode: only photos the console starred reach the wall, and
  // they skip the delay — the host has already looked at them.
  function isEligible(row) {
    if (!row || row.status !== "approved") return false;
    if (state.event.led_featured_only) return !!row.featured;
    const ageMs = serverNow() - new Date(row.created_at).getTime();
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

  const SCENES = ["wall", "ranking", "spotlight", "contest", "blank"];

  function showScene(name) {
    document.querySelectorAll(".scene").forEach((s) => s.classList.remove("active"));
    if (SCENES.includes(name)) {
      document.getElementById(`scene-${name}`).classList.add("active");
    } else {
      document.getElementById("placeholderText").textContent = "";
      document.getElementById("scene-placeholder").classList.add("active");
    }
  }

  function applyScene() {
    clearInterval(state.rankingTimer);
    clearInterval(state.contestTimer);
    clearTimeout(state.rotationTimer);
    const scene = state.event.led_scene || "wall";
    showScene(scene);
    if (scene === "wall") {
      startRotation();
    } else if (scene === "ranking") {
      renderRanking();
      state.rankingTimer = setInterval(renderRanking, RANKING_REFRESH_MS);
    } else if (scene === "spotlight") {
      renderSpotlight();
    } else if (scene === "contest") {
      refreshContest();
      state.contestTimer = setInterval(refreshContest, CONTEST_POLL_MS);
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
    // Drop anything that stopped qualifying (e.g. un-featured in
    // featured-only mode) before adding newcomers.
    state.cachedPool = state.cachedPool.filter((id) => isEligible(state.allMedia.get(id)));
    state.priorityQueue = state.priorityQueue.filter((id) => isEligible(state.allMedia.get(id)));
    // "Hold all": keep rotating what is already up, add nothing new.
    if (state.event.led_hold) return;
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
    // If it is on screen right now, move on immediately.
    const img = document.getElementById("wallImg");
    if (img.dataset.id === id && (state.event.led_scene || "wall") === "wall") advanceWall();
  }

  function currentWallRow() {
    while (state.priorityQueue.length > 0) {
      const id = state.priorityQueue.shift();
      const row = state.allMedia.get(id);
      state.badgeShown.add(id);
      if (row) return { row, justAdded: true };
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
      img.dataset.id = row.id;
      video.hidden = false;
      video.src = url;
      video.currentTime = 0;
      video.play().catch(() => {});
      backdrop.style.backgroundImage = "none";
    } else {
      video.hidden = true;
      video.pause();
      img.hidden = false;
      img.dataset.id = row.id;
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

  function clearWall() {
    const img = document.getElementById("wallImg");
    img.hidden = true;
    img.dataset.id = "";
    img.removeAttribute("src");
    document.getElementById("wallVideo").hidden = true;
    document.getElementById("wallBackdrop").style.backgroundImage = "none";
    document.getElementById("wallUploader").textContent = "";
    document.getElementById("wallCaption").textContent = "";
    document.getElementById("justAdded").hidden = true;
  }

  function scheduleNextWallTick(row) {
    clearTimeout(state.rotationTimer);
    const ms = row && row.kind === "video" ? VIDEO_MAX_MS : PHOTO_MS;
    state.rotationTimer = setTimeout(advanceWall, row ? ms : 1000);
  }

  function advanceWall() {
    const { row, justAdded } = currentWallRow();
    if (!row) {
      if (document.getElementById("wallImg").dataset.id) clearWall();
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

  // ---------- spotlight scene ----------

  async function renderSpotlight() {
    const id = state.event.led_spotlight_media;
    const img = document.getElementById("spotImg");
    const backdrop = document.getElementById("spotBackdrop");
    if (!id) {
      img.removeAttribute("src");
      backdrop.style.backgroundImage = "none";
      return;
    }
    let row = state.allMedia.get(id);
    if (!row) {
      try {
        const { data } = await window.Insphoto.supabase.from("album_media").select("*").eq("id", id).single();
        row = data;
      } catch {
        return; // keep whatever is on screen
      }
    }
    if (!row || state.event.led_spotlight_media !== id) return;
    const url = window.Insphoto.mediaUrl(row.storage_path);
    img.src = url;
    backdrop.style.backgroundImage = `url(${url})`;
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

  // ---------- contest scene ----------
  // Polled once a second rather than pushed over Realtime: one LED asking
  // once a second is trivial load, and survives reconnects without any
  // catching-up logic. Numbers only, as large as the screen allows.

  function votingOpen(c) {
    if (!c || c.phase !== "voting") return false;
    return !c.voting_ends_at || serverNow() < new Date(c.voting_ends_at).getTime();
  }

  function renderCountdown() {
    const timer = document.getElementById("contestTimer");
    const c = state.contest;
    if (!c || c.phase !== "voting" || !c.voting_ends_at) {
      timer.hidden = true;
      return;
    }
    const left = Math.max(0, Math.ceil((new Date(c.voting_ends_at).getTime() - serverNow()) / 1000));
    timer.hidden = false;
    timer.textContent = String(left);
    timer.classList.toggle("urgent", left <= 10);
    if (left === 0) renderContestStatus();
  }

  function renderContestStatus() {
    const status = document.getElementById("contestStatus");
    const scene = document.getElementById("scene-contest");
    const c = state.contest;
    const open = votingOpen(c);
    const final = !!c && (c.phase === "closed" || (c.phase === "voting" && !open));
    scene.classList.toggle("final", final);
    status.textContent = open
      ? "Vote now — scan the QR and tap ❤️ on your favourite!"
      : final
        ? "Voting closed"
        : "Voting opens soon";
  }

  function gridColumns(n) {
    if (n <= 5) return Math.max(1, n);
    return Math.ceil(n / 2);
  }

  async function refreshContest() {
    if (!state.event) return;
    let contest, entries;
    try {
      const { data: cs, error: ce } = await window.Insphoto.supabase
        .from("album_contests")
        .select("*")
        .eq("event_id", state.event.id)
        .eq("name", "Best Dress")
        .maybeSingle();
      if (ce) throw ce;
      contest = cs;
      if (!contest) return;
      const { data, error } = await window.Insphoto.supabase
        .from("album_contest_entries")
        .select("media_id, label, sort_order, final_likes, album_media(storage_path, thumb_path)")
        .eq("contest_id", contest.id)
        .order("sort_order");
      if (error) throw error;
      entries = data || [];
    } catch {
      return; // keep the last numbers on screen
    }

    state.contest = contest;
    renderContestStatus();
    clearInterval(state.countdownTimer);
    renderCountdown();
    if (contest.phase === "voting" && contest.voting_ends_at) {
      state.countdownTimer = setInterval(renderCountdown, 250);
    }

    const grid = document.getElementById("contestGrid");
    grid.style.gridTemplateColumns = `repeat(${gridColumns(entries.length)}, minmax(0, 1fr))`;
    const twoRows = entries.length > 5;
    grid.style.setProperty("--photo-h", twoRows ? "27vh" : "58vh");
    grid.style.setProperty("--count-size", twoRows ? "60px" : "96px");
    // Rebuild only if the contestant list itself changed; otherwise just
    // update the numbers so photos don't flicker.
    const sig = entries.map((e) => e.media_id + ":" + e.label).join("|");
    if (grid.dataset.sig !== sig) {
      grid.dataset.sig = sig;
      grid.innerHTML = "";
      state.contestCounts.clear();
      entries.forEach((e, i) => {
        const card = document.createElement("div");
        card.className = "c-card";
        card.dataset.id = e.media_id;
        const photo = document.createElement("div");
        photo.className = "c-photo";
        const img = document.createElement("img");
        const m = e.album_media || {};
        img.src = window.Insphoto.mediaUrl(m.storage_path || m.thumb_path);
        photo.appendChild(img);
        const label = document.createElement("div");
        label.className = "c-label";
        label.textContent = e.label || `#${i + 1}`;
        photo.appendChild(label);
        const count = document.createElement("div");
        count.className = "c-count";
        count.textContent = "0";
        card.append(photo, count);
        grid.appendChild(card);
      });
    }

    const max = entries.reduce((n, e) => Math.max(n, e.final_likes), 0);
    const final = grid.closest(".scene").classList.contains("final");
    for (const e of entries) {
      const card = grid.querySelector(`.c-card[data-id="${e.media_id}"]`);
      if (!card) continue;
      const countEl = card.querySelector(".c-count");
      const prev = state.contestCounts.get(e.media_id);
      if (prev !== e.final_likes) {
        countEl.textContent = e.final_likes.toLocaleString("en-US");
        if (prev !== undefined) {
          countEl.classList.remove("bump");
          void countEl.offsetWidth;
          countEl.classList.add("bump");
        }
        state.contestCounts.set(e.media_id, e.final_likes);
      }
      const leading = max > 0 && e.final_likes === max;
      card.classList.toggle("leader", leading);
      card.classList.toggle("winner", final && leading);
      let crown = card.querySelector(".c-crown");
      if (final && leading && !crown) {
        crown = document.createElement("div");
        crown.className = "c-crown";
        crown.textContent = "👑";
        card.prepend(crown);
      } else if (!(final && leading) && crown) {
        crown.remove();
      }
    }
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
      // Featured photos can be older than the newest 300 — load them too.
      const { data: featured } = await window.Insphoto.supabase
        .from("album_media")
        .select("*")
        .eq("event_id", state.event.id)
        .eq("featured", true);
      for (const row of featured || []) {
        state.allMedia.set(row.id, row);
        if (isEligible(row) && !state.cachedPool.includes(row.id)) {
          pushToCache(row.id);
          state.badgeShown.add(row.id);
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

  // A long disconnect gets a fresh page load — but only once the network is
  // actually back. Reloading while offline would replace the wall with the
  // browser's own "no internet" page, which is far worse than a stale wall.
  async function reloadWhenOnline() {
    try {
      const res = await fetch(location.href, { cache: "no-store" });
      if (res.ok) {
        location.reload();
        return;
      }
    } catch {
      /* still offline */
    }
    state.disconnectTimer = setTimeout(reloadWhenOnline, 10000);
  }

  function armDisconnectTimer() {
    if (state.disconnectTimer) return;
    state.disconnectTimer = setTimeout(reloadWhenOnline, FORCE_RELOAD_AFTER_DISCONNECT_MS);
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
          if (payload.new.status === "approved") {
            state.allMedia.set(payload.new.id, payload.new);
            recomputeEligibility();
          } else {
            removeFromRotation(payload.new.id);
          }
        },
      )
      // Deletes and hides arrive as broadcasts from the Edge Function —
      // postgres_changes can't deliver either to this anon subscriber.
      .on("broadcast", { event: "media_removed" }, (msg) => removeFromRotation(msg.payload.id))
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "album_events", filter: `id=eq.${state.event.id}` },
        (payload) => {
          state.event = payload.new;
          recomputeEligibility();
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
    await syncClock();
    setInterval(syncClock, CLOCK_SYNC_MS);
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
