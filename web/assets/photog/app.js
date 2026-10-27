// Photographer upload page (/p/:slug). Built for a laptop and a few hundred
// DSLR JPEGs per night:
// - three uploads at a time, so a 500-photo drop doesn't swamp the laptop
//   or the venue connection;
// - each photo goes up as a screen copy + thumbnail first, so it lands in
//   the album within seconds, and its full-resolution original follows
//   once every queued photo is visible;
// - every step retries on its own with a fresh presigned URL;
// - photos already uploaded from this laptop are skipped if dropped again.
(function () {
  const WORKERS = 3;
  const MAX_RETRIES = 4;
  const THUMB_PX = 480;
  const RAW_EXT = /\.(cr2|cr3|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|dng|srw|x3f|3fr|iiq|rwl)$/i;

  const state = {
    slug: null,
    token: null,
    event: null,
    items: [], // {file, key, phase, mediaId, ui, attempts}
    running: 0,
  };

  const $ = (id) => document.getElementById(id);

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2500);
  }

  function slugFromPath() {
    const m = location.pathname.match(/\/p\/([^/]+)$/);
    return m ? m[1] : null;
  }

  const tokenKey = () => `insphoto_photog_token_${state.slug}`;
  const doneKey = () => `insphoto_photog_done_${state.slug}`;

  function loadDone() {
    try {
      return new Set(JSON.parse(localStorage.getItem(doneKey()) || "[]"));
    } catch {
      return new Set();
    }
  }
  function markDone(fileKey) {
    try {
      const s = loadDone();
      s.add(fileKey);
      localStorage.setItem(doneKey(), JSON.stringify([...s]));
    } catch {
      /* storage full or blocked — duplicates just won't be skipped */
    }
  }

  async function api(path, body) {
    const res = await fetch(window.Insphoto.apiPath(path), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      localStorage.removeItem(tokenKey());
      showLogin("Signed out — please enter the PIN again. Uploads will resume.");
      throw new Error("unauthorized");
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `request failed (${res.status})`);
    return json;
  }

  // ---------- login ----------

  function showLogin(err) {
    $("loginScreen").hidden = false;
    if (err) {
      $("loginError").textContent = err;
      $("loginError").hidden = false;
    }
  }

  async function login() {
    const pin = $("pinInput").value.trim();
    if (!pin) return;
    $("loginBtn").disabled = true;
    $("loginError").hidden = true;
    try {
      const res = await fetch(window.Insphoto.apiPath("/api/photog/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: state.slug, pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "login failed");
      state.token = body.token;
      state.event = body.event;
      localStorage.setItem(tokenKey(), body.token);
      localStorage.setItem(`insphoto_photog_event_${state.slug}`, JSON.stringify(body.event));
      startApp();
    } catch (e) {
      $("loginError").textContent = e.message;
      $("loginError").hidden = false;
    } finally {
      $("loginBtn").disabled = false;
    }
  }

  // ---------- image work ----------

  async function decode(file) {
    // Downsample during decode: a 45MP frame decoded at full size costs
    // ~180MB of memory, times three workers. 2200px is above any copy we make.
    try {
      return await createImageBitmap(file, { resizeWidth: 2200, resizeQuality: "high" });
    } catch {
      return await createImageBitmap(file);
    }
  }

  async function toJpeg(bitmap, maxEdge, quality) {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    return { blob, width: w, height: h };
  }

  function put(url, blob, type, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("content-type", type);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload ${xhr.status}`)));
      xhr.onerror = () => reject(new Error("network error"));
      xhr.send(blob);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function withRetry(fn) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (e.message === "unauthorized" || attempt >= MAX_RETRIES) throw e;
        await sleep(2 ** attempt * 1000);
      }
    }
  }

  function setProgress(item, frac, text) {
    item.ui.fill.style.width = `${Math.round(frac * 100)}%`;
    if (text) item.ui.status.textContent = text;
  }

  // Step 1: screen copy + thumbnail, then the album row. Visible after this.
  async function uploadDisplay(item) {
    setProgress(item, 0.02, "Preparing…");
    const bitmap = await decode(item.file);
    const maxPx = Math.max(1920, state.event.max_photo_px || 1920);
    const display = await toJpeg(bitmap, maxPx, Math.max(0.85, state.event.jpeg_quality || 0.85));
    const thumb = await toJpeg(bitmap, THUMB_PX, 0.75);
    if (bitmap.close) bitmap.close();
    item.ui.img.src = URL.createObjectURL(thumb.blob);

    const keys = await withRetry(async () => {
      const { files } = await api(`/api/photog/${state.slug}/presign`, {
        files: [
          { part: "thumb", content_type: "image/jpeg", ext: "jpg" },
          { part: "display", content_type: "image/jpeg", ext: "jpg" },
        ],
      });
      setProgress(item, 0.05, "Uploading…");
      await put(files[0].url, thumb.blob, "image/jpeg", () => {});
      await put(files[1].url, display.blob, "image/jpeg", (p) => setProgress(item, 0.05 + p * 0.35));
      return { thumb: files[0].key, display: files[1].key };
    });

    const { id } = await withRetry(() =>
      api(`/api/photog/${state.slug}/media`, {
        storage_path: keys.display,
        thumb_path: keys.thumb,
        width: display.width,
        height: display.height,
        bytes: display.blob.size + thumb.blob.size,
        uploader_name: ($("creditInput").value || "").trim() || "Photographer",
      }),
    );
    item.mediaId = id;
    markDone(item.key);
    setProgress(item, 0.4, "In album · saving full quality…");
  }

  // Step 2: the untouched original, for after-event downloads.
  async function uploadOriginal(item) {
    const type = item.file.type || "image/jpeg";
    const ext = (item.file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "jpg").toLowerCase();
    await withRetry(async () => {
      const { files } = await api(`/api/photog/${state.slug}/presign`, {
        files: [{ part: "original", content_type: type, ext }],
      });
      await put(files[0].url, item.file, type, (p) => setProgress(item, 0.4 + p * 0.6));
      await api(`/api/photog/${state.slug}/media/${item.mediaId}/original`, {
        original_path: files[0].key,
        bytes: item.file.size,
      });
    });
  }

  // ---------- queue ----------

  function nextTask() {
    // Every photo becomes visible before any original is sent.
    const display = state.items.find((i) => i.phase === "queued");
    if (display) return display;
    return state.items.find((i) => i.phase === "shown");
  }

  async function worker() {
    state.running++;
    try {
      for (let item = nextTask(); item; item = nextTask()) {
        const step = item.phase;
        item.phase = step === "queued" ? "display…" : "original…";
        try {
          if (step === "queued") {
            await uploadDisplay(item);
            item.phase = "shown";
          } else {
            await uploadOriginal(item);
            item.phase = "done";
            setProgress(item, 1, "Done");
            item.ui.li.className = "item done";
          }
        } catch (e) {
          if (e.message === "unauthorized") {
            item.phase = step; // resume after sign-in
            break;
          }
          item.failedStep = step;
          item.phase = "error";
          item.ui.li.className = "item error";
          item.ui.status.textContent = `Failed: ${e.message}`;
        }
        renderSummary();
      }
    } finally {
      state.running--;
      renderSummary();
    }
  }

  function pump() {
    while (state.running < WORKERS && nextTask()) worker();
  }

  function renderSummary() {
    const c = { queued: 0, shown: 0, done: 0, error: 0 };
    for (const i of state.items) {
      if (i.phase === "queued" || i.phase === "display…") c.queued++;
      else if (i.phase === "shown" || i.phase === "original…") c.shown++;
      else if (i.phase === "done") c.done++;
      else if (i.phase === "error") c.error++;
    }
    $("sQueued").textContent = c.queued;
    $("sShown").textContent = c.shown + c.done;
    $("sOriginals").textContent = c.done;
    $("sFailed").textContent = c.error;
    $("retryBtn").hidden = c.error === 0;
    const total = state.items.filter((i) => i.phase !== "skipped").length;
    $("overallFill").style.width = total ? `${Math.round(((c.done + c.error) / total) * 100)}%` : "0";
  }

  function addFiles(fileList) {
    const done = loadDone();
    let skipped = 0;
    let rejected = 0;
    for (const file of Array.from(fileList)) {
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      const li = document.createElement("li");
      li.className = "item";
      const img = document.createElement("img");
      const info = document.createElement("div");
      info.className = "info";
      const fname = document.createElement("div");
      fname.className = "fname";
      fname.textContent = file.name;
      const status = document.createElement("div");
      status.className = "status";
      const bar = document.createElement("div");
      bar.className = "bar2";
      const fill = document.createElement("div");
      bar.appendChild(fill);
      info.append(fname, status, bar);
      li.append(img, info);
      const item = { file, key, phase: "queued", mediaId: null, ui: { li, img, status, fill } };

      if (RAW_EXT.test(file.name) || !/^image\/(jpeg|png)$/.test(file.type)) {
        item.phase = "rejected";
        li.className = "item error";
        status.textContent = "Not uploaded — JPEG or PNG only (no RAW)";
        rejected++;
      } else if (done.has(key)) {
        item.phase = "skipped";
        li.className = "item done";
        status.textContent = "Already uploaded — skipped";
        skipped++;
      } else {
        status.textContent = "Waiting…";
      }
      state.items.push(item);
      $("list").prepend(li);
    }
    if (skipped) toast(`${skipped} already uploaded — skipped`);
    if (rejected) toast(`${rejected} file(s) skipped — JPEG or PNG only`);
    renderSummary();
    pump();
  }

  function retryFailed() {
    for (const i of state.items) {
      if (i.phase === "error") {
        i.phase = i.failedStep || "queued";
        i.ui.li.className = "item";
        i.ui.status.textContent = "Retrying…";
      }
    }
    renderSummary();
    pump();
  }

  // ---------- wiring ----------

  function bindDrop() {
    const drop = $("drop");
    ["dragenter", "dragover"].forEach((t) =>
      drop.addEventListener(t, (e) => {
        e.preventDefault();
        drop.classList.add("over");
      }),
    );
    ["dragleave", "drop"].forEach((t) =>
      drop.addEventListener(t, (e) => {
        e.preventDefault();
        drop.classList.remove("over");
      }),
    );
    drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
    // Dropping outside the box shouldn't make the browser open the photo.
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());
    $("fileInput").addEventListener("change", (e) => {
      addFiles(e.target.files);
      e.target.value = "";
    });
  }

  function startApp() {
    $("loginScreen").hidden = true;
    $("app").hidden = false;
    $("eventName").textContent = `📷 ${state.event.name}`;
    const credit = localStorage.getItem("insphoto_photog_credit");
    if (credit) $("creditInput").value = credit;
    pump(); // resume anything paused by a sign-out
  }

  function boot() {
    state.slug = slugFromPath();
    if (!state.slug) {
      document.body.innerHTML = "<p style='padding:40px'>Event not found.</p>";
      return;
    }
    $("loginEvent").textContent = state.slug;
    $("loginBtn").addEventListener("click", login);
    $("pinInput").addEventListener("keydown", (e) => e.key === "Enter" && login());
    $("retryBtn").addEventListener("click", retryFailed);
    $("creditInput").addEventListener("change", (e) =>
      localStorage.setItem("insphoto_photog_credit", e.target.value.trim()),
    );
    bindDrop();

    window.addEventListener("beforeunload", (e) => {
      const busy = state.items.some((i) => ["queued", "display…", "shown", "original…"].includes(i.phase));
      if (busy) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    const token = localStorage.getItem(tokenKey());
    const event = localStorage.getItem(`insphoto_photog_event_${state.slug}`);
    if (token && event) {
      state.token = token;
      state.event = JSON.parse(event);
      startApp();
    } else {
      showLogin();
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
