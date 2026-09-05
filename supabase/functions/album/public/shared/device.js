// device_id: a UUID in localStorage, created on first visit. Not a security
// boundary (PRD §6.5) — used only for like attribution, "my photos", and
// self-delete matching.
(function () {
  const KEY = "insphoto_device_id";
  const NAME_KEY = "insphoto_name";

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function deviceId() {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = uuid();
      localStorage.setItem(KEY, id);
    }
    return id;
  }

  function guestName(next) {
    if (next !== undefined) {
      localStorage.setItem(NAME_KEY, next);
      return next;
    }
    return localStorage.getItem(NAME_KEY) || "";
  }

  window.InsphotoDevice = { deviceId, guestName };
})();
