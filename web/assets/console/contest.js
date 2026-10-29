// Console — Best Dress tab.
//
// Round 1 (nominating): live ranking of every photo by how many people
// liked it. The operator may add votes to a photo (safety net — shown only
// here, never on phones or the LED) and picks the contestants. The emcee's
// cutoff = "Close nominations", which freezes the ranking.
// Round 2 (voting): contestants only, likes from zero, live numbers on the
// LED. The console can only watch and stop it — the database refuses any
// other change while voting is open.
(function () {
  const POLL_ACTIVE_MS = 1500;
  const POLL_IDLE_MS = 6000;

  const C = () => window.InsphotoConsole;
  const $ = (id) => document.getElementById(id);

  const s = {
    data: null, // last GET /contest response
    clockOffsetMs: 0,
    active: false, // tab visible
    timer: null,
    countdown: null,
    busy: false,
    editingLabel: null, // media_id whose label input has focus — don't clobber it
  };

  const PHASE_TEXT = {
    nominating: "Round 1 open — guests are liking photos",
    nominations_closed: "Round 1 closed — pick contestants, then start the final vote",
    voting: "FINAL VOTE OPEN",
    closed: "Final vote closed",
  };

  function serverNow() {
    return Date.now() + s.clockOffsetMs;
  }

  function phase() {
    const c = s.data && s.data.contest;
    if (!c) return null;
    if (c.phase === "voting" && c.voting_ends_at && serverNow() >= new Date(c.voting_ends_at).getTime()) {
      return "closed";
    }
    return c.phase;
  }

  async function load() {
    try {
      const res = await C().apiFetch(`/api/host/${C().state.slug}/contest`);
      if (!res.ok) return;
      const t0 = Date.now();
      const data = await res.json();
      if (data.server_now) s.clockOffsetMs = new Date(data.server_now).getTime() - t0;
      s.data = data;
      render();
    } catch {
      /* apiFetch handles 401; anything else retries on the next poll */
    }
  }

  async function act(action, args = {}, okMsg) {
    if (s.busy) return;
    s.busy = true;
    try {
      const res = await C().apiFetch(`/api/host/${C().state.slug}/contest`, {
        method: "POST",
        body: JSON.stringify({ action, ...args }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        C().toast(body.error || "Not allowed right now");
        return false;
      }
      if (okMsg) C().toast(okMsg);
      return true;
    } catch {
      C().toast("Network problem — try again");
      return false;
    } finally {
      s.busy = false;
      load();
    }
  }

  // ---------- rendering ----------

  function row({ rank, thumb, scoreHtml, splitText, controls, picked, labelInput }) {
    const li = document.createElement("li");
    li.className = "c-row" + (picked ? " picked" : "");
    const r = document.createElement("span");
    r.className = "c-rank";
    r.textContent = rank;
    const img = document.createElement("img");
    img.src = window.Insphoto.mediaUrl(thumb);
    img.loading = "lazy";
    const meta = document.createElement("div");
    meta.className = "c-meta";
    meta.innerHTML = `<div class="c-score">${scoreHtml}</div>`;
    if (splitText) {
      const sp = document.createElement("div");
      sp.className = "c-split";
      sp.textContent = splitText;
      meta.appendChild(sp);
    }
    if (labelInput) meta.appendChild(labelInput);
    li.append(r, img, meta);
    if (controls) li.appendChild(controls);
    return li;
  }

  function button(text, onClick, cls) {
    const b = document.createElement("button");
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener("click", onClick);
    return b;
  }

  function renderRanking(p, contestantIds) {
    const list = $("cRanking");
    list.innerHTML = "";
    const editable = p === "nominating" || p === "nominations_closed";
    let rows = s.data.ranking;
    if (p === "nominations_closed" && s.data.frozen_ranking) {
      rows = s.data.frozen_ranking.detail.ranking || [];
      const at = new Date(s.data.frozen_ranking.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      $("cRankTitle").textContent = `Round 1 — frozen at the cutoff (${at})`;
    } else {
      $("cRankTitle").textContent = "Round 1 — most people liked (live)";
    }
    if (rows.length === 0) {
      list.innerHTML = '<li class="muted">No likes yet.</li>';
      return;
    }
    rows.forEach((r, i) => {
      const picked = contestantIds.has(r.media_id);
      const controls = document.createElement("div");
      controls.className = "c-ctl";
      if (p === "nominating") {
        const n = document.createElement("input");
        n.type = "number";
        n.min = "0";
        n.value = String(r.host);
        n.title = "Votes added by host (console only)";
        controls.appendChild(n);
        controls.appendChild(
          button("+ votes", () => act("host_votes", { media_id: r.media_id, votes: parseInt(n.value, 10) || 0 }, "Host votes saved")),
        );
      }
      if (editable) {
        controls.appendChild(
          button(picked ? "✓ Contestant" : "Pick", () => act("set_finalist", { media_id: r.media_id, on: !picked }), picked ? "on" : ""),
        );
      }
      controls.appendChild(button("📺", () => C().showOnScreen(r.media_id)));
      list.appendChild(
        row({
          rank: i + 1,
          thumb: r.thumb_path,
          scoreHtml: `${r.score} <span class="muted">people</span>`,
          splitText: r.host ? `${r.guests} guests + ${r.host} added by host` : `${r.guests} guests`,
          controls,
          picked,
        }),
      );
    });
  }

  function renderContestants(p) {
    const list = $("cContestants");
    list.innerHTML = "";
    const editable = p === "nominating" || p === "nominations_closed";
    const cs = s.data.contestants;
    $("cCount").textContent = `(${cs.length})`;
    if (cs.length === 0) {
      list.innerHTML = '<li class="muted">Nobody picked yet — use "Pick" on the left.</li>';
    }
    cs.forEach((c, i) => {
      let labelInput = null;
      if (editable) {
        labelInput = document.createElement("input");
        labelInput.placeholder = `Name or number shown on screen (default #${i + 1})`;
        labelInput.maxLength = 60;
        labelInput.value = c.label;
        labelInput.addEventListener("focus", () => (s.editingLabel = c.media_id));
        labelInput.addEventListener("blur", () => {
          s.editingLabel = null;
          if (labelInput.value !== c.label) act("set_label", { media_id: c.media_id, label: labelInput.value });
        });
        labelInput.addEventListener("keydown", (e) => e.key === "Enter" && labelInput.blur());
      }
      const controls = document.createElement("div");
      controls.className = "c-ctl";
      controls.appendChild(button("📺", () => C().showOnScreen(c.media_id)));
      if (editable) controls.appendChild(button("Remove", () => act("set_finalist", { media_id: c.media_id, on: false })));
      list.appendChild(
        row({
          rank: i + 1,
          thumb: c.thumb_path,
          scoreHtml: c.label ? escapeHtml(c.label) : `#${i + 1}`,
          splitText: c.uploader_name ? `photo by ${c.uploader_name}` : "",
          controls,
          labelInput,
        }),
      );
    });
  }

  function escapeHtml(t) {
    const d = document.createElement("div");
    d.textContent = t;
    return d.innerHTML;
  }

  function renderLive(p) {
    const box = $("cLive");
    box.innerHTML = "";
    if (p !== "voting" && p !== "closed") return;
    const cs = [...s.data.contestants].sort((a, b) => b.final_likes - a.final_likes);
    const top = cs.length ? cs[0].final_likes : 0;
    const h = document.createElement("h3");
    h.textContent = p === "voting" ? "Live final vote" : "Final result";
    box.appendChild(h);
    cs.forEach((c, i) => {
      const crown = p === "closed" && top > 0 && c.final_likes === top ? "👑 " : "";
      box.appendChild(
        row({
          rank: i + 1,
          thumb: c.thumb_path,
          scoreHtml: `${crown}${c.final_likes.toLocaleString()} <span class="muted">likes</span>`,
          splitText: `${c.label || "#" + (c.sort_order || i + 1)} · ${c.final_voters} phones voted`,
        }),
      );
    });
  }

  function renderActions(p) {
    const box = $("cActions");
    box.innerHTML = "";
    const n = s.data.contestants.length;
    if (p === "nominating") {
      box.appendChild(
        button("Close nominations (emcee cutoff)", () => {
          if (confirm("Freeze the Round 1 ranking now?")) act("close_nominations", {}, "Round 1 closed");
        }, "big"),
      );
    }
    if (p === "nominations_closed") {
      box.appendChild(button("Reopen Round 1", () => act("reopen_nominations", {}, "Round 1 reopened"), "ghost"));
    }
    if (p === "nominating" || p === "nominations_closed") {
      box.appendChild(
        button(`Step 1 · Open final vote (${n} contestants)`, async () => {
          if (n === 0) return C().toast("Pick at least one contestant first");
          const msg =
            `Open the final vote now?\n\n• The screen switches to the ${n} contestants\n` +
            `• Every phone opens the vote — guests can start liking\n• Counting starts from zero\n` +
            `• No timer yet: press "Start countdown" when the emcee announces it\n` +
            `• Once open, the console cannot change any numbers`;
          if (!confirm(msg)) return;
          const ok = await act("start_voting", { seconds: 0 }, "Final vote is open");
          if (ok) C().setScene("contest");
        }, "big"),
      );
    }
    if (p === "voting" && !s.data.contest.voting_ends_at) {
      box.appendChild(
        button("Step 2 · ⏱ Start countdown", () => {
          const secs = parseInt($("cSeconds").value, 10);
          if (!confirm(`Start the ${secs}-second countdown?\n\nLikes keep counting until it hits zero, then voting locks. It can't be restarted.`)) return;
          act("start_countdown", { seconds: secs }, `Countdown started — ${secs}s`);
        }, "big"),
      );
    }
    if (p === "voting") {
      box.appendChild(
        button("⛔ STOP ALL LIKES", () => act("stop_voting", {}, "Voting stopped"), "stop"),
      );
    }
    if (p === "closed") {
      // If the countdown ran out on its own, the next poll's "tick" closes
      // the vote officially and writes the final result to the log.
      box.appendChild(button("Show result on screen", () => C().setScene("contest"), "big"));
      box.appendChild(button("Back to photo wall", () => C().setScene("wall")));
    }
    $("cVoteBox").hidden = !(p === "voting" && !s.data.contest.voting_ends_at);
    $("cReset").hidden = p === "voting";
  }

  function renderCountdown() {
    const c = s.data && s.data.contest;
    const el = $("cPhase");
    const p = phase();
    let text = PHASE_TEXT[p] || "";
    if (p === "voting" && c.voting_ends_at) {
      const left = Math.max(0, Math.ceil((new Date(c.voting_ends_at).getTime() - serverNow()) / 1000));
      text += ` — ${left}s left`;
    }
    el.textContent = text;
    el.className = "phase-pill " + (p || "");
  }

  function render() {
    if (!s.data) return;
    const p = phase();
    const contestantIds = new Set(s.data.contestants.map((c) => c.media_id));
    renderCountdown();
    clearInterval(s.countdown);
    if (s.data.contest.phase === "voting" && s.data.contest.voting_ends_at) {
      s.countdown = setInterval(renderCountdown, 250);
    }
    $("cHelp").textContent =
      p === "nominating"
        ? "Ranking = how many different people liked each photo. \"+ votes\" adds host votes (only you see them). Pick who goes on stage."
        : p === "nominations_closed"
          ? "The ranking is frozen. Name the contestants (shown on screen), then start the final vote."
          : p === "voting"
            ? s.data.contest.voting_ends_at
              ? "Countdown running — voting locks at zero. Numbers cannot be changed from the console."
              : "Guests are liking. When the emcee announces it, pick the countdown and press Step 2. Numbers cannot be changed from the console."
            : "Voting is over. Download the log for the record.";
    // Don't rebuild the lists while the operator is typing a label.
    if (!s.editingLabel) {
      renderRanking(p, contestantIds);
      renderContestants(p);
    }
    renderLive(p);
    renderActions(p);
    schedule();
  }

  function schedule() {
    clearTimeout(s.timer);
    const p = phase();
    const fast = s.active || p === "voting";
    s.timer = setTimeout(load, fast ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }

  async function downloadLog() {
    try {
      const res = await C().apiFetch(`/api/host/${C().state.slug}/contest/log.csv`);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${C().state.slug}-best-dress-log.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      C().toast("Could not download the log");
    }
  }

  function start() {
    $("cLog").addEventListener("click", downloadLog);
    $("cReset").addEventListener("click", () => {
      if (!confirm("Reset the contest? This clears contestants, host votes and the final numbers (the log keeps a record). Only for rehearsals.")) return;
      if (prompt('Type RESET to confirm') !== "RESET") return;
      act("reset", {}, "Contest reset");
    });
    load();
  }

  function onTab(active) {
    s.active = active;
    if (active) load();
  }

  window.InsphotoConsoleContest = { start, onTab };
})();
