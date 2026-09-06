// Upload flow: client-side resize, presign, direct-to-R2 PUT, then a normal
// insert of the album_media row. PRD §6.4.
(function () {
  const MAX_RETRIES = 3;
  const PRESIGN_SAFETY_MS = 4.5 * 60 * 1000; // re-presign once we're this close to the 5 min expiry

  const state = {
    event: null,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function extFromType(type, fallback) {
    if (!type) return fallback;
    const m = type.match(/\/([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : fallback;
  }

  // Modern phone cameras shoot 12-48MP. Decoding that at full resolution
  // just to immediately downscale it can spike memory enough to crash the
  // tab on mobile Safari before the upload ever starts (observed: page
  // silently reloads back to the default tab, no error, nothing uploaded).
  // Ask the browser to downsample *during* decode instead — resizeWidth
  // alone preserves aspect ratio, so this works for portrait or landscape
  // without needing the original dimensions up front. The cap is set above
  // our largest final rendition (1920) so quality isn't affected; the exact
  // per-rendition sizing still happens in resizeToBlob below.
  const DECODE_CAP = 2200;

  async function loadImage(file) {
    if (!("createImageBitmap" in window)) {
      throw new Error("createImageBitmap unsupported");
    }
    try {
      return await createImageBitmap(file, {
        resizeWidth: DECODE_CAP,
        resizeQuality: "medium",
      });
    } catch {
      // Some browsers reject the resize options for certain formats —
      // fall back to a full decode. HEIC decode failures are handled by
      // the caller's own catch, which falls back to uploading the original.
      return await createImageBitmap(file);
    }
  }

  async function resizeToBlob(bitmap, maxEdge, quality) {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    return { blob, width: w, height: h };
  }

  function xhrPut(url, blob, contentType, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("content-type", contentType);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`upload failed: ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("network error during upload"));
      xhr.send(blob);
    });
  }

  async function presign(files) {
    const res = await fetch(window.Insphoto.apiPath("/api/presign"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_id: state.event.id, files }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "presign failed");
    return (await res.json()).files; // [{part,key,url,expiresAt}]
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function makeItemUI(file) {
    const li = document.createElement("li");
    li.className = "upload-item";
    const thumb = document.createElement("img");
    if (file.type.startsWith("image/")) {
      thumb.src = URL.createObjectURL(file);
    } else {
      thumb.style.background = "#2a2f36";
    }
    const info = document.createElement("div");
    info.className = "u-info";
    const name = document.createElement("div");
    name.className = "u-name";
    name.textContent = file.name;
    const bar = document.createElement("div");
    bar.className = "u-bar";
    const fill = document.createElement("div");
    fill.className = "u-bar-fill";
    bar.appendChild(fill);
    const status = document.createElement("div");
    status.className = "u-status";
    status.textContent = "Preparing…";
    info.append(name, bar, status);
    li.append(thumb, info);
    el("uploadList").prepend(li);
    return { fill, status };
  }

  async function putWithRetry(part, blob, contentType, ext, ui, weight, baseProgress) {
    let attempt = 0;
    let presigned = null;
    let presignedAt = 0;
    while (attempt < MAX_RETRIES) {
      attempt++;
      try {
        if (!presigned || Date.now() - presignedAt > PRESIGN_SAFETY_MS) {
          const files = await presign([{ part, content_type: contentType, ext }]);
          presigned = files[0];
          presignedAt = Date.now();
        }
        await xhrPut(presigned.url, blob, contentType, (p) => {
          ui.fill.style.width = `${Math.round((baseProgress + p * weight) * 100)}%`;
        });
        return presigned.key;
      } catch (e) {
        if (attempt >= MAX_RETRIES) throw e;
        await sleep(2 ** (attempt - 1) * 1000);
        presigned = null; // force a fresh presign on retry
      }
    }
    throw new Error("upload failed");
  }

  async function processImage(file, ui) {
    let bitmap;
    try {
      bitmap = await loadImage(file);
    } catch {
      // HEIC or otherwise undecodable — fall back to uploading the original
      // as-is. It's already the true original, so there's no separate
      // "original" upload to do here (original_path stays null; the
      // download button falls back to storage_path for exactly this case).
      const key = await putWithRetry(
        "display",
        file,
        file.type || "application/octet-stream",
        extFromType(file.type, "jpg"),
        ui,
        1,
        0,
      );
      return {
        storage_path: key,
        thumb_path: null,
        original_path: null,
        width: null,
        height: null,
        bytes: file.size,
      };
    }

    const maxPx = state.event.max_photo_px || 1920;
    const quality = state.event.jpeg_quality || 0.8;
    const display = await resizeToBlob(bitmap, maxPx, quality);
    const thumb = await resizeToBlob(bitmap, 480, 0.72);

    // Thumb and display stay exactly as before (fast/cheap for the live
    // feed, photo view, LED). The true original is uploaded untouched
    // alongside them, purely so guests can get their actual photo back via
    // the "High quality" download — nothing else in the app reads it.
    const thumbKey = await putWithRetry("thumb", thumb.blob, "image/jpeg", "jpg", ui, 0.15, 0);
    const displayKey = await putWithRetry("display", display.blob, "image/jpeg", "jpg", ui, 0.35, 0.15);
    const originalKey = await putWithRetry(
      "original",
      file,
      file.type || "application/octet-stream",
      extFromType(file.type, "jpg"),
      ui,
      0.5,
      0.5,
    );

    return {
      storage_path: displayKey,
      thumb_path: thumbKey,
      original_path: originalKey,
      width: display.width,
      height: display.height,
      // Total bytes actually stored across all three renditions — the
      // console's "storage used" stat sums this column, and would badly
      // understate usage now that the (often much larger) original is kept.
      bytes: thumb.blob.size + display.blob.size + file.size,
    };
  }

  async function processVideo(file, ui) {
    const key = await putWithRetry(
      "video",
      file,
      file.type || "video/mp4",
      extFromType(file.type, "mp4"),
      ui,
      1,
      0,
    );
    // Video is already uploaded untouched (no resize pass), so storage_path
    // already *is* the original — no separate "original" upload needed.
    return {
      storage_path: key,
      thumb_path: null,
      original_path: null,
      width: null,
      height: null,
      bytes: file.size,
    };
  }

  async function handleFile(file) {
    const ui = makeItemUI(file);
    const isVideo = file.type.startsWith("video/");

    if (isVideo && !state.event.allow_video) {
      ui.status.textContent = "Videos aren't enabled for this event";
      ui.status.classList.add("error");
      return;
    }
    const maxBytes = (state.event.max_file_mb || 25) * 1024 * 1024;
    if (file.size > maxBytes) {
      ui.status.textContent = `Too large — max ${state.event.max_file_mb}MB`;
      ui.status.classList.add("error");
      return;
    }

    ui.status.textContent = "Uploading…";
    try {
      const result = isVideo ? await processVideo(file, ui) : await processImage(file, ui);
      const { error } = await window.Insphoto.supabase.from("album_media").insert({
        event_id: state.event.id,
        storage_path: result.storage_path,
        thumb_path: result.thumb_path,
        original_path: result.original_path,
        kind: isVideo ? "video" : "photo",
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        uploader_name: window.InsphotoDevice.guestName(),
        device_id: window.InsphotoDevice.deviceId(),
      });
      if (error) throw error;
      ui.fill.style.width = "100%";
      ui.status.textContent = "Done";
      ui.status.classList.add("done");
    } catch (e) {
      console.error(e);
      ui.status.textContent = "Failed — tap Gallery/Camera to retry";
      ui.status.classList.add("error");
    }
  }

  function handleFiles(fileList) {
    Array.from(fileList).forEach(handleFile);
  }

  function initNameField() {
    const input = el("nameInput");
    input.value = window.InsphotoDevice.guestName();
    el("nameSave").addEventListener("click", () => {
      window.InsphotoDevice.guestName(input.value.trim());
      window.InsphotoApp.toast("Name saved");
    });
  }

  function init(event) {
    state.event = event;
    initNameField();
    if (!event.allow_video) {
      // Restrict the native picker to images up front, rather than letting
      // a guest pick a video and only then telling them it's not allowed.
      el("cameraInput").setAttribute("accept", "image/*");
      el("galleryInput").setAttribute("accept", "image/*");
    }
    el("cameraInput").addEventListener("change", (e) => {
      handleFiles(e.target.files);
      e.target.value = "";
    });
    el("galleryInput").addEventListener("change", (e) => {
      handleFiles(e.target.files);
      e.target.value = "";
    });
    if (!event.upload_open) {
      document.querySelector(".upload-actions").hidden = true;
      const p = document.createElement("p");
      p.textContent = "Uploads are closed for this event right now.";
      p.style.padding = "0 8px";
      p.style.color = "var(--text-dim)";
      el("panel-upload").prepend(p);
    }
  }

  window.InsphotoUpload = { init };
})();
