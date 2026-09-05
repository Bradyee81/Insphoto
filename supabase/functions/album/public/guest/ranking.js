// Ranking tab: same grid, sorted by unique voters. PRD §6.3.
(function () {
  const REFRESH_MS = 20000;

  const state = {
    event: null,
    list: [], // ordered media rows
    columnEls: [],
    active: false,
    timer: null,
  };

  function columnCount() {
    return window.innerWidth >= 720 ? 4 : 2;
  }

  function buildColumns() {
    const grid = document.getElementById("rankingGrid");
    grid.innerHTML = "";
    const n = columnCount();
    state.columnEls = Array.from({ length: n }, () => {
      const col = document.createElement("div");
      col.className = "masonry-col";
      grid.appendChild(col);
      return col;
    });
  }

  function tile(media, rank) {
    const btn = document.createElement("button");
    btn.className = "tile";
    btn.dataset.id = media.id;

    const img = document.createElement("img");
    img.src = window.Insphoto.mediaUrl(media.thumb_path || media.storage_path);
    img.alt = media.caption || "";
    if (media.width && media.height) img.style.aspectRatio = `${media.width} / ${media.height}`;
    btn.appendChild(img);

    if (rank <= 3) {
      const badge = document.createElement("div");
      badge.className = "rank-badge";
      badge.textContent = String(rank);
      btn.appendChild(badge);
    }

    const cap = document.createElement("div");
    cap.className = "tile-caption";
    cap.textContent = window.InsphotoFormat.likeLabel(media.like_count, media.liker_count);
    btn.appendChild(cap);

    btn.addEventListener("click", () =>
      window.InsphotoPhotoView.open(
        media.id,
        state.list.map((m) => m.id),
      ),
    );
    return btn;
  }

  function render() {
    buildColumns();
    state.list.forEach((media, i) => {
      const el = tile(media, i + 1);
      // Round-robin placement keeps rank order readable left-to-right.
      const col = state.columnEls[i % state.columnEls.length];
      col.appendChild(el);
    });
  }

  async function refresh() {
    if (!state.event) return;
    const { data, error } = await window.Insphoto.supabase
      .from("album_media")
      .select("*")
      .eq("event_id", state.event.id)
      .order("liker_count", { ascending: false })
      .order("like_count", { ascending: false })
      .limit(120);
    if (error) {
      console.error(error);
      return;
    }
    state.list = data || [];
    if (state.active) render();
  }

  function startTimer() {
    clearInterval(state.timer);
    state.timer = setInterval(refresh, REFRESH_MS);
  }

  function setupRealtime() {
    window.Insphoto.supabase
      .channel(`ranking:${state.event.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "album_media", filter: `event_id=eq.${state.event.id}` },
        () => refresh(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "album_media", filter: `event_id=eq.${state.event.id}` },
        () => refresh(),
      )
      .subscribe();
  }

  function onShow() {
    state.active = true;
    render();
  }
  function onHide() {
    state.active = false;
  }

  function init(event) {
    state.event = event;
    refresh();
    startTimer();
    setupRealtime();

    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.active) render();
      }, 200);
    });
  }

  window.InsphotoRanking = { init, onShow, onHide };
})();
