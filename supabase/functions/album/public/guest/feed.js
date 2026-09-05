// Explore tab: masonry grid, infinite scroll, realtime insert/delete, lazy
// thumb loading. PRD §6.1.
(function () {
  const PAGE_SIZE = 60;

  const state = {
    event: null,
    columns: [],
    columnEls: [],
    offset: 0,
    done: false,
    loading: false,
    io: null, // sentinel observer
    lazyIo: null,
    seen: new Set(), // media ids already rendered, avoids dupes from realtime + pagination race
    list: [], // ordered ids, for photo-view swipe navigation
  };

  function columnCount() {
    return window.innerWidth >= 720 ? 4 : 2;
  }

  function buildColumns() {
    const grid = document.getElementById("feedGrid");
    grid.innerHTML = "";
    const n = columnCount();
    state.columns = Array.from({ length: n }, () => []);
    state.columnEls = Array.from({ length: n }, () => {
      const col = document.createElement("div");
      col.className = "masonry-col";
      grid.appendChild(col);
      return col;
    });
  }

  function shortestColumnIndex() {
    let idx = 0;
    let min = Infinity;
    state.columnEls.forEach((el, i) => {
      const h = el.getBoundingClientRect().height;
      if (h < min) {
        min = h;
        idx = i;
      }
    });
    return idx;
  }

  function tile(media) {
    const btn = document.createElement("button");
    btn.className = "tile";
    btn.dataset.id = media.id;

    const img = document.createElement("img");
    img.dataset.src = window.Insphoto.mediaUrl(media.thumb_path || media.storage_path);
    img.alt = media.caption || "";
    if (media.width && media.height) {
      img.style.aspectRatio = `${media.width} / ${media.height}`;
    }
    btn.appendChild(img);

    if (media.uploader_name) {
      const cap = document.createElement("div");
      cap.className = "tile-caption";
      cap.textContent = media.uploader_name;
      btn.appendChild(cap);
    }
    if (media.kind === "video") {
      const b = document.createElement("div");
      b.className = "badge";
      b.textContent = "▶ video";
      btn.appendChild(b);
    }

    btn.addEventListener("click", () =>
      window.InsphotoPhotoView.open(media.id, state.list),
    );

    if (state.lazyIo) state.lazyIo.observe(img);
    else img.src = img.dataset.src;

    return btn;
  }

  function appendMedia(list, { prepend = false } = {}) {
    for (const media of list) {
      if (state.seen.has(media.id)) continue;
      state.seen.add(media.id);
      if (prepend) state.list.unshift(media.id);
      else state.list.push(media.id);
      const el = tile(media);
      if (prepend) el.classList.add("new");
      const idx = prepend ? 0 : shortestColumnIndex();
      const col = state.columnEls[idx];
      if (prepend) col.insertBefore(el, col.firstChild);
      else col.appendChild(el);
    }
    updateEmptyState();
  }

  function removeMedia(id) {
    const el = document.querySelector(`#feedGrid .tile[data-id="${id}"]`);
    if (!el) return;
    el.classList.add("removing");
    setTimeout(() => el.remove(), 260);
    state.seen.delete(id);
    const idx = state.list.indexOf(id);
    if (idx !== -1) state.list.splice(idx, 1);
    updateEmptyState();
  }

  function updateEmptyState() {
    const empty = document.getElementById("feedEmpty");
    empty.hidden = state.seen.size > 0;
  }

  async function loadMore() {
    if (state.loading || state.done || !state.event) return;
    state.loading = true;
    const { data, error } = await window.Insphoto.supabase
      .from("album_media")
      .select("*")
      .eq("event_id", state.event.id)
      .order("created_at", { ascending: false })
      .range(state.offset, state.offset + PAGE_SIZE - 1);

    state.loading = false;
    if (error) {
      console.error(error);
      return;
    }
    if (!data || data.length < PAGE_SIZE) state.done = true;
    state.offset += data.length;
    appendMedia(data);
  }

  function setupInfiniteScroll() {
    if (state.io) state.io.disconnect();
    state.io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "600px" },
    );
    state.io.observe(document.getElementById("feedSentinel"));
  }

  function setupLazyLoad() {
    state.lazyIo = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const img = entry.target;
            if (img.dataset.src) img.src = img.dataset.src;
            state.lazyIo.unobserve(img);
          }
        }
      },
      { rootMargin: "300px" },
    );
  }

  function setupRealtime() {
    window.Insphoto.supabase
      .channel(`feed:${state.event.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "album_media", filter: `event_id=eq.${state.event.id}` },
        (payload) => appendMedia([payload.new], { prepend: true }),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "album_media", filter: `event_id=eq.${state.event.id}` },
        (payload) => removeMedia(payload.old.id),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "album_media", filter: `event_id=eq.${state.event.id}` },
        (payload) => {
          // Covers approve (pending -> approved becoming visible for the first time).
          if (!state.seen.has(payload.new.id) && payload.new.status === "approved") {
            appendMedia([payload.new], { prepend: true });
          }
        },
      )
      .on("broadcast", { event: "media_hidden" }, (msg) => removeMedia(msg.payload.id))
      .subscribe();
  }

  function init(event) {
    state.event = event;
    state.offset = 0;
    state.done = false;
    state.seen = new Set();
    setupLazyLoad();
    buildColumns();
    setupInfiniteScroll();
    setupRealtime();
    loadMore();

    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (columnCount() !== state.columnEls.length) {
          // Column count changed (phone <-> tablet width) — rebuild the grid
          // from scratch rather than trying to reflow tiles across columns.
          state.seen = new Set();
          state.list = [];
          state.offset = 0;
          state.done = false;
          buildColumns();
          loadMore();
        }
      }, 200);
    });
  }

  window.InsphotoFeed = { init, removeMedia, appendMedia };
})();
