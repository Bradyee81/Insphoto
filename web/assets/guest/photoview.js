// Fullscreen photo view: like batching, share, download, swipe, self-delete.
// PRD §6.2.
(function () {
  const LIKE_FLUSH_IDLE_MS = 800;
  const LIKE_CHUNK = 100;

  const state = {
    event: null,
    contextList: [],
    index: -1,
    media: null, // currently displayed row
    pendingLikes: 0,
    flushTimer: null,
    flushing: false,
    swipeStartX: null,
    swipeStartY: null,
    longPressTimer: null,
  };

  const el = {};
  function cacheEls() {
    el.root = document.getElementById("photoView");
    el.close = document.getElementById("pvClose");
    el.wrap = document.getElementById("pvMediaWrap");
    el.prev = document.getElementById("pvPrev");
    el.next = document.getElementById("pvNext");
    el.uploader = document.getElementById("pvUploader");
    el.caption = document.getElementById("pvCaption");
    el.like = document.getElementById("pvLike");
    el.share = document.getElementById("pvShare");
    el.more = document.getElementById("pvMore");
    el.del = document.getElementById("pvDelete");
    el.sheet = document.getElementById("downloadSheet");
    el.dlStandard = document.getElementById("dlStandard");
    el.dlHigh = document.getElementById("dlHigh");
    el.dlCancel = document.getElementById("dlCancel");
  }

  function flushPendingLikes(immediate) {
    if (state.pendingLikes <= 0 || !state.media) return;
    clearTimeout(state.flushTimer);
    const run = async () => {
      if (state.flushing) return;
      state.flushing = true;
      let toSend = state.pendingLikes;
      state.pendingLikes = 0;
      const mediaId = state.media.id;
      const deviceId = window.InsphotoDevice.deviceId();
      while (toSend > 0) {
        const chunk = Math.min(toSend, LIKE_CHUNK);
        toSend -= chunk;
        try {
          const { data, error } = await window.Insphoto.supabase.rpc("album_like", {
            p_media: mediaId,
            p_device: deviceId,
            p_n: chunk,
          });
          if (error) throw error;
          if (data && data[0] && state.media && state.media.id === mediaId) {
            state.media.like_count = data[0].like_count;
            state.media.liker_count = data[0].liker_count;
            renderLike();
          }
        } catch (e) {
          // Keep the local optimistic count, retry once by re-queueing.
          state.pendingLikes += chunk;
          console.error("like flush failed", e);
          break;
        }
      }
      state.flushing = false;
    };
    if (immediate) run();
    else state.flushTimer = setTimeout(run, LIKE_FLUSH_IDLE_MS);
  }

  function renderLike() {
    if (!state.media) return;
    el.like.textContent = window.InsphotoFormat.likeLabel(
      state.media.like_count || 0,
      state.media.liker_count || 0,
    );
  }

  function tapLike() {
    if (!state.media) return;
    state.media.like_count = (state.media.like_count || 0) + 1;
    // liker_count only increases server-side on a device's first ever like —
    // we don't know that client-side, so we leave it alone optimistically.
    renderLike();
    el.like.classList.remove("tapped");
    void el.like.offsetWidth;
    el.like.classList.add("tapped");
    state.pendingLikes += 1;
    clearTimeout(state.flushTimer);
    state.flushTimer = setTimeout(() => flushPendingLikes(false), LIKE_FLUSH_IDLE_MS);
  }

  function renderMedia() {
    const m = state.media;
    el.wrap.innerHTML = "";
    if (m.kind === "video") {
      const video = document.createElement("video");
      video.src = window.Insphoto.mediaUrl(m.storage_path);
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.style.webkitTouchCallout = "none";
      el.wrap.appendChild(video);
    } else {
      const img = document.createElement("img");
      img.src = window.Insphoto.mediaUrl(m.storage_path);
      img.alt = m.caption || "";
      img.style.webkitTouchCallout = "none";
      el.wrap.appendChild(img);
    }
    el.uploader.textContent = m.uploader_name || "Anonymous";
    el.caption.textContent = m.caption || "";
    renderLike();

    const isMine = m.device_id && m.device_id === window.InsphotoDevice.deviceId();
    el.del.hidden = !(isMine && state.event && state.event.allow_guest_delete);

    el.prev.style.visibility = state.index > 0 ? "visible" : "hidden";
    el.next.style.visibility = state.index < state.contextList.length - 1 ? "visible" : "hidden";
  }

  async function loadIndex(i) {
    const id = state.contextList[i];
    if (!id) return;
    const { data, error } = await window.Insphoto.supabase
      .from("album_media")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !data) return;
    state.index = i;
    state.media = data;
    state.pendingLikes = 0;
    renderMedia();
  }

  async function open(id, contextList) {
    cacheEls();
    state.contextList = contextList && contextList.length ? contextList.slice() : [id];
    const idx = state.contextList.indexOf(id);
    el.root.hidden = false;
    document.body.style.overflow = "hidden";
    await loadIndex(idx === -1 ? 0 : idx);
  }

  function close() {
    flushPendingLikes(true);
    el.root.hidden = true;
    document.body.style.overflow = "";
    el.wrap.innerHTML = "";
    state.media = null;
  }

  function goPrev() {
    if (state.index > 0) {
      flushPendingLikes(true);
      loadIndex(state.index - 1);
    }
  }
  function goNext() {
    if (state.index < state.contextList.length - 1) {
      flushPendingLikes(true);
      loadIndex(state.index + 1);
    }
  }

  async function fetchBlob(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("download failed");
    return res.blob();
  }

  async function shareCurrent() {
    if (!state.media) return;
    const url = window.Insphoto.mediaUrl(state.media.storage_path);
    try {
      if (navigator.canShare) {
        const blob = await fetchBlob(url);
        const file = new File([blob], "photo.jpg", { type: blob.type || "image/jpeg" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], text: state.media.caption || "" });
          return;
        }
      }
      if (navigator.share) {
        await navigator.share({ url, text: state.media.caption || "" });
        return;
      }
      await navigator.clipboard.writeText(url);
      window.InsphotoApp.toast("Link copied");
    } catch (e) {
      if (e && e.name === "AbortError") return;
      console.error(e);
    }
  }

  function triggerDownload(url, filename) {
    fetchBlob(url).then((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
  }

  function openDownloadSheet() {
    // Full-quality originals stay locked until the host unlocks them after
    // the event; on the night, only the screen-quality copy downloads.
    el.dlHigh.hidden = !(state.event && state.event.originals_download);
    el.sheet.hidden = false;
  }
  function closeDownloadSheet() {
    el.sheet.hidden = true;
  }

  async function deleteCurrent() {
    if (!state.media) return;
    if (!confirm("Delete this photo? This can't be undone.")) return;
    const id = state.media.id;
    try {
      const res = await fetch(window.Insphoto.apiPath(`/api/media/${id}/delete`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: window.InsphotoDevice.deviceId() }),
      });
      if (!res.ok) throw new Error(await res.text());
      window.InsphotoFeed.removeMedia(id);
      goNextOrClose();
    } catch (e) {
      console.error(e);
      window.InsphotoApp.toast("Could not delete photo");
    }
  }

  function goNextOrClose() {
    if (state.index < state.contextList.length - 1) {
      state.contextList.splice(state.index, 1);
      loadIndex(state.index);
    } else if (state.index > 0) {
      state.contextList.splice(state.index, 1);
      loadIndex(state.index - 1);
    } else {
      close();
    }
  }

  function bindEvents() {
    el.close.addEventListener("click", close);
    el.prev.addEventListener("click", goPrev);
    el.next.addEventListener("click", goNext);
    el.like.addEventListener("click", tapLike);
    el.share.addEventListener("click", shareCurrent);
    el.more.addEventListener("click", openDownloadSheet);
    el.del.addEventListener("click", deleteCurrent);
    el.dlCancel.addEventListener("click", closeDownloadSheet);
    el.dlStandard.addEventListener("click", () => {
      closeDownloadSheet();
      if (state.media) {
        triggerDownload(window.Insphoto.mediaUrl(state.media.storage_path), "photo-standard.jpg");
      }
    });
    el.dlHigh.addEventListener("click", () => {
      closeDownloadSheet();
      if (state.media && state.event && state.event.originals_download) {
        // original_path is the true, unresized upload; null for rows from
        // before this existed, or the rare HEIC-decode-failure path where
        // storage_path already *is* the original — either way, fall back.
        const key = state.media.original_path || state.media.storage_path;
        triggerDownload(window.Insphoto.mediaUrl(key), "photo-original.jpg");
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushPendingLikes(true);
    });
    window.addEventListener("pagehide", () => flushPendingLikes(true));

    document.addEventListener("keydown", (e) => {
      if (el.root.hidden) return;
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "ArrowRight") goNext();
    });

    // Long-press for download (image is claimed by iOS "Save Image" on plain
    // long-press, so the visible ⋯ button is the primary path — this is a
    // secondary affordance for browsers that don't intercept it).
    el.wrap.addEventListener("touchstart", (e) => {
      state.swipeStartX = e.touches[0].clientX;
      state.swipeStartY = e.touches[0].clientY;
      state.longPressTimer = setTimeout(() => openDownloadSheet(), 500);
    });
    el.wrap.addEventListener("touchmove", (e) => {
      if (state.swipeStartX == null) return;
      const dx = Math.abs(e.touches[0].clientX - state.swipeStartX);
      const dy = Math.abs(e.touches[0].clientY - state.swipeStartY);
      if (dx > 10 || dy > 10) clearTimeout(state.longPressTimer);
    });
    el.wrap.addEventListener("touchend", (e) => {
      clearTimeout(state.longPressTimer);
      if (state.swipeStartX == null) return;
      const dx = e.changedTouches[0].clientX - state.swipeStartX;
      const dy = e.changedTouches[0].clientY - state.swipeStartY;
      state.swipeStartX = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx > 0) goPrev();
        else goNext();
      }
    });
  }

  function init(event) {
    state.event = event;
    cacheEls();
    bindEvents();
  }

  function setEvent(event) {
    state.event = event;
  }

  window.InsphotoPhotoView = { init, open, close, setEvent };
})();
