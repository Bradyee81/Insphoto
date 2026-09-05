// Guest app bootstrap: loads the event by slug, applies branding, wires tabs.
(function () {
  let toastTimer;
  function toast(message) {
    const t = document.getElementById("toast");
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2200);
  }

  function slugFromPath() {
    const m = location.pathname.match(/\/e\/([^/]+)$/);
    return m ? m[1] : null;
  }

  function applyBranding(event) {
    document.documentElement.style.setProperty("--brand", event.brand_color || "#0F766E");
    document.documentElement.style.setProperty("--accent", event.accent_color || "#F59E0B");
    document.getElementById("eventName").textContent = event.name;
    document.getElementById("eventTagline").textContent = event.tagline || "";
    document.title = `${event.name} — InsPhoto`;
    if (event.logo_url) {
      const logo = document.getElementById("logo");
      logo.src = event.logo_url;
      logo.hidden = false;
    }
  }

  function setupTabs() {
    const tabs = document.querySelectorAll(".tab");
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    document.getElementById("emptyUploadBtn").addEventListener("click", () => switchTab("upload"));
  }

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    document.getElementById(`panel-${name}`).classList.add("active");
    if (name === "ranking") window.InsphotoRanking.onShow();
    else window.InsphotoRanking.onHide();
  }

  function setupNotice(event) {
    const key = `insphoto_notice_${event.id}`;
    if (localStorage.getItem(key)) return;
    const notice = document.getElementById("notice");
    const text = document.getElementById("noticeText");
    text.textContent =
      event.welcome_message ||
      "Photos you upload may be shown on the event screen and this shared album.";
    notice.hidden = false;
    document.getElementById("noticeOk").addEventListener("click", () => {
      localStorage.setItem(key, "1");
      notice.hidden = true;
    });
  }

  async function boot() {
    const slug = slugFromPath();
    if (!slug) {
      document.body.innerHTML = "<p style='padding:40px;text-align:center'>Event not found.</p>";
      return;
    }

    const { data: event, error } = await window.Insphoto.supabase
      .from("album_events")
      .select("*")
      .eq("slug", slug)
      .single();

    if (error || !event) {
      document.body.innerHTML =
        "<p style='padding:40px;text-align:center'>This event link isn't valid.</p>";
      return;
    }

    applyBranding(event);
    setupNotice(event);
    setupTabs();

    window.InsphotoFeed.init(event);
    window.InsphotoRanking.init(event);
    window.InsphotoPhotoView.init(event);
    window.InsphotoUpload.init(event);

    // Keep branding/toggles live if the host changes them mid-event.
    window.Insphoto.supabase
      .channel(`event:${event.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "album_events", filter: `id=eq.${event.id}` },
        (payload) => applyBranding(payload.new),
      )
      .subscribe();
  }

  window.InsphotoApp = { toast };
  document.addEventListener("DOMContentLoaded", boot);
})();
