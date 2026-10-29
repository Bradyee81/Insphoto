// Best Dress final vote on the phone. Opens by itself when the console
// starts the vote, closes itself at the cutoff. Taps are batched like photo
// likes, but flushed at least once a second while someone keeps tapping so
// the numbers on the LED move live. The server decides what counts: the
// cutoff time, and the per-phone cap (never shown here).
(function () {
  const CONTEST_NAME = "Best Dress";
  const FLUSH_IDLE_MS = 400;
  const FLUSH_MAX_WAIT_MS = 1000;
  const CHUNK = 200; // the server's per-call maximum

  const state = {
    event: null,
    contest: null,
    entries: [],
    clockOffsetMs: 0,
    pending: new Map(), // media_id -> taps not yet sent
    mine: new Map(), // media_id -> taps this phone made (display only)
    capped: new Set(), // finalists where the server stopped accepting this phone's taps
    flushTimer: null,
    firstPendingAt: 0,
    flushing: false,
    dismissed: false,
    countdownTimer: null,
    pollTimer: null,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function serverNow() {
    return Date.now() + state.clockOffsetMs;
  }

  async function syncClock() {
    try {
      const t0 = Date.now();
      const { data } = await window.Insphoto.supabase.rpc("album_now");
      if (data) state.clockOffsetMs = new Date(data).getTime() - (t0 + Date.now()) / 2;
    } catch {
      /* keep the last offset */
    }
  }

  function isOpen() {
    const c = state.contest;
    if (!c || c.phase !== "voting") return false;
    return !c.voting_ends_at || serverNow() < new Date(c.voting_ends_at).getTime();
  }

  function isFinished() {
    const c = state.contest;
    return !!c && (c.phase === "closed" || (c.phase === "voting" && !isOpen()));
  }

  // ---------- sending taps ----------

  async function flush() {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
    if (state.flushing || state.pending.size === 0 || !state.contest) return;
    state.flushing = true;
    state.firstPendingAt = 0;
    const batch = [...state.pending.entries()];
    state.pending.clear();
    const device = window.InsphotoDevice.deviceId();
    for (const [mediaId, total] of batch) {
      let left = total;
      while (left > 0) {
        const n = Math.min(left, CHUNK);
        left -= n;
        try {
          const { data, error } = await window.Insphoto.supabase.rpc("album_contest_vote", {
            p_contest: state.contest.id,
            p_media: mediaId,
            p_device: device,
            p_n: n,
          });
          if (error) throw error;
          const row = data && data[0];
          if (row && row.accepted < n && row.phase === "voting" && isOpen()) {
            state.capped.add(mediaId);
          }
          if (row && row.phase !== "voting") left = 0;
        } catch (e) {
          // Network blip: put the taps back and try again shortly — the
          // server still rejects anything that arrives after the cutoff.
          state.pending.set(mediaId, (state.pending.get(mediaId) || 0) + n + left);
          left = 0;
          console.error("vote flush failed", e);
        }
      }
    }
    state.flushing = false;
    if (state.pending.size > 0) schedule();
  }

  function schedule() {
    if (!state.firstPendingAt) state.firstPendingAt = Date.now();
    clearTimeout(state.flushTimer);
    const sinceFirst = Date.now() - state.firstPendingAt;
    const wait = Math.max(0, Math.min(FLUSH_IDLE_MS, FLUSH_MAX_WAIT_MS - sinceFirst));
    state.flushTimer = setTimeout(flush, wait);
  }

  function burst(card, x, y) {
    const b = document.createElement("span");
    b.className = "v-burst";
    b.textContent = "❤️";
    const r = card.getBoundingClientRect();
    b.style.left = `${x - r.left}px`;
    b.style.top = `${y - r.top}px`;
    card.appendChild(b);
    setTimeout(() => b.remove(), 700);
  }

  function tap(card, mediaId, ev) {
    if (!isOpen()) return;
    card.classList.remove("tapped");
    void card.offsetWidth;
    card.classList.add("tapped");
    if (ev && ev.clientX) burst(card, ev.clientX, ev.clientY);
    const mine = (state.mine.get(mediaId) || 0) + 1;
    state.mine.set(mediaId, mine);
    card.querySelector(".v-mine").textContent = `❤️ ${mine}`;
    if (state.capped.has(mediaId)) return; // keep the fun, stop sending
    state.pending.set(mediaId, (state.pending.get(mediaId) || 0) + 1);
    schedule();
  }

  // ---------- rendering ----------

  function renderGrid() {
    const grid = el("voteGrid");
    grid.innerHTML = "";
    state.entries.forEach((e, i) => {
      const card = document.createElement("button");
      card.className = "v-card";
      const img = document.createElement("img");
      const m = e.album_media || {};
      img.src = window.Insphoto.mediaUrl(m.thumb_path || m.storage_path);
      img.alt = "";
      const label = document.createElement("span");
      label.className = "v-label";
      label.textContent = e.label || `#${i + 1}`;
      const heart = document.createElement("span");
      heart.className = "v-heart";
      heart.textContent = "❤️";
      const mine = document.createElement("span");
      mine.className = "v-mine";
      const n = state.mine.get(e.media_id);
      mine.textContent = n ? `❤️ ${n}` : "";
      card.append(img, label, heart, mine);
      card.addEventListener("click", (ev) => tap(card, e.media_id, ev));
      grid.appendChild(card);
    });
  }

  function renderTimer() {
    const t = el("voteTimer");
    const c = state.contest;
    if (!c || c.phase !== "voting" || !c.voting_ends_at) {
      t.textContent = "";
      return;
    }
    const left = Math.max(0, Math.ceil((new Date(c.voting_ends_at).getTime() - serverNow()) / 1000));
    t.textContent = `${left}s`;
    t.classList.toggle("urgent", left <= 10);
    if (left === 0 && state.countdownTimer) {
      // Once, at zero: stop ticking and switch to the closed view. (Calling
      // render() directly here looped forever — render() draws the timer.)
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      setTimeout(render, 0);
    }
  }

  function render() {
    const view = el("voteView");
    const pill = el("votePill");
    const open = isOpen();
    const finished = isFinished();
    // The server still accepts taps for a moment after the cutoff — send
    // the last batch right now instead of waiting for the usual timer.
    if (finished && state.pending.size) flush();

    if (open) {
      el("voteMsg").textContent = "Tap a photo as many times as you like!";
      view.classList.remove("closed");
      if (!state.dismissed) view.hidden = false;
      pill.hidden = !view.hidden;
    } else if (finished && !view.hidden) {
      el("voteMsg").textContent = "Voting closed — thank you! Watch the screen for the winner.";
      view.classList.add("closed");
      pill.hidden = true;
    } else {
      view.hidden = true;
      pill.hidden = true;
    }

    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
    renderTimer();
    if (open && state.contest.voting_ends_at) {
      state.countdownTimer = setInterval(renderTimer, 250);
    }
  }

  // ---------- data ----------

  async function loadEntries() {
    const { data, error } = await window.Insphoto.supabase
      .from("album_contest_entries")
      .select("media_id, label, sort_order, album_media(thumb_path, storage_path)")
      .eq("contest_id", state.contest.id)
      .order("sort_order");
    if (error) throw error;
    state.entries = data || [];
  }

  async function onContest(contest) {
    const wasPhase = state.contest && state.contest.phase;
    const wasStarted = state.contest && state.contest.voting_started_at;
    state.contest = contest;
    if (contest.phase === "voting" && (wasPhase !== "voting" || wasStarted !== contest.voting_started_at)) {
      // A new vote: fresh counters on this phone too, and pop the screen open.
      state.mine.clear();
      state.capped.clear();
      state.pending.clear();
      state.dismissed = false;
      try {
        await loadEntries();
      } catch (e) {
        console.error(e);
      }
      renderGrid();
    }
    render();
  }

  async function fetchContest() {
    const { data } = await window.Insphoto.supabase
      .from("album_contests")
      .select("*")
      .eq("event_id", state.event.id)
      .eq("name", CONTEST_NAME)
      .maybeSingle();
    if (data) await onContest(data);
  }

  function subscribe() {
    window.Insphoto.supabase
      .channel(`contest:${state.event.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "album_contests", filter: `event_id=eq.${state.event.id}` },
        (payload) => {
          if (payload.new && payload.new.name === CONTEST_NAME) onContest(payload.new);
        },
      )
      .subscribe((status) => {
        // After any reconnect, re-read the state we may have missed.
        if (status === "SUBSCRIBED") fetchContest();
      });
  }

  function init(event) {
    state.event = event;
    el("voteClose").addEventListener("click", () => {
      flush();
      state.dismissed = true;
      el("voteView").hidden = true;
      el("votePill").hidden = !isOpen();
    });
    el("votePill").addEventListener("click", () => {
      state.dismissed = false;
      render();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flush();
      else fetchContest();
    });
    window.addEventListener("pagehide", flush);
    syncClock();
    subscribe();
    fetchContest();
    // Belt and braces in case a realtime message is missed.
    state.pollTimer = setInterval(fetchContest, 15000);
  }

  window.InsphotoVote = { init };
})();
