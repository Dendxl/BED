/**
 * Hospital Bed Finder — single-page: map, hospital staff, patient chat.
 */
(function () {
  const API_BASE =
    window.HBF_API ||
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
      ? `http://${window.location.hostname}:8088`
      : "http://127.0.0.1:8088");

  const STAFF_TOKEN_KEY = "hbf_token";
  const PT_TOKEN_KEY = "hbf_patient_token";

  const FALLBACK_HOSPITALS = [
    { id: "spcmc", name: "San Pablo Colleges Medical Center", address: "Brgy. San Rafael, Maharlika Hwy., San Pablo City, Laguna", bedsAvailable: 42, lat: 14.0711, lng: 121.3068 },
    { id: "cgh", name: "Community General Hospital of San Pablo City, Inc.", address: "Cipriano B. Colago Ave., San Pablo City, Laguna", bedsAvailable: 28, lat: 14.07338, lng: 121.31312 },
    { id: "spdh", name: "San Pablo Doctors Hospital", address: "55 A. Mabini St., San Pablo City, Laguna", bedsAvailable: 35, lat: 14.073316, lng: 121.324295 },
    { id: "st-gerard", name: "St. Gerard Hospital", address: "32 P. Zamora St., San Pablo City, Laguna", bedsAvailable: 22, lat: 14.069861, lng: 121.324471 },
    { id: "ppl-sp", name: "Panlalawigang Pagamutan ng Laguna–San Pablo", address: "Gen. Antonio Luna Rd. cor. P. Gomez St., Brgy. IV-B, San Pablo City", bedsAvailable: 55, lat: 14.07245, lng: 121.32895 },
    { id: "spcgh", name: "San Pablo City General Hospital", address: "Gen. Antonio Luna Rd., San Pablo City, Laguna", bedsAvailable: 48, lat: 14.07305, lng: 121.32845 },
    { id: "ich", name: "Immaculate Conception Hospital, Inc.", address: "P. Alcantara St., San Pablo City, Laguna", bedsAvailable: 31, lat: 14.069146, lng: 121.32235 },
    { id: "sfpg", name: "Saints Francis and Paul General Hospital", address: "Justice Abad Santos St., Farconville, Brgy. San Francisco, San Pablo City", bedsAvailable: 18, lat: 14.0762, lng: 121.3184 },
  ];

  function normalizeHospital(r) {
    return {
      id: r.id,
      name: r.name,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      bedsAvailable: r.beds_available != null ? r.beds_available : r.bedsAvailable,
    };
  }

  async function loadHospitalData() {
    try {
      const r = await fetch(`${API_BASE}/api/hospitals`);
      if (!r.ok) throw new Error("bad");
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty");
      return rows.map(normalizeHospital);
    } catch {
      return FALLBACK_HOSPITALS;
    }
  }

  async function loadDoctorsByHospital() {
    try {
      const r = await fetch(`${API_BASE}/api/public/doctors-by-hospital`);
      if (!r.ok) throw new Error("bad");
      return await r.json();
    } catch {
      return {};
    }
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  /* -------- Views / hash -------- */
  function showView(name, options) {
    const updateHash = options && options.updateHash !== false;
    const valid = ["map", "staff", "patient"];
    if (!valid.includes(name)) name = "map";

    document.querySelectorAll(".site-panel").forEach((p) => p.classList.add("is-hidden"));
    const panel = document.getElementById("panel-" + name);
    if (panel) panel.classList.remove("is-hidden");

    document.querySelectorAll(".nav-tab").forEach((b) => {
      b.classList.toggle("is-active", b.getAttribute("data-view") === name);
    });

    if (updateHash) {
      const h = "#" + name;
      if (location.hash !== h) history.replaceState(null, "", h);
    }

    if (name === "map") {
      initMapIfNeeded();
    }
  }

  function initNav() {
    document.querySelectorAll(".nav-tab").forEach((btn) => {
      btn.addEventListener("click", () => showView(btn.getAttribute("data-view")));
    });
    window.addEventListener("hashchange", () => {
      const raw = (location.hash || "#map").slice(1);
      if (["map", "staff", "patient"].includes(raw)) {
        showView(raw, { updateHash: false });
      }
    });
  }

  /* -------- Map -------- */
  let map = null;
  let listEl = null;
  const markers = new Map();

  function iconForHospital() {
    return L.divIcon({
      className: "hospital-pin",
      html: `<span class="pin-inner" aria-hidden="true"></span>`,
      iconSize: [28, 36],
      iconAnchor: [14, 36],
      popupAnchor: [0, -32],
    });
  }

  function doctorsLineHtml(hid, doctorsMap) {
    const docs = doctorsMap[hid];
    if (!docs || docs.length === 0) {
      return `<p class="popup-meta">No doctors listed yet.</p>`;
    }
    const text = docs.map((d) => `${d.name} (${d.specialty})`).join("; ");
    return `<p class="popup-meta"><strong>Available doctors:</strong> ${escapeHtml(text)}</p>`;
  }

  function popupHtml(h, doctorsMap) {
    return `
    <p class="popup-title">${escapeHtml(h.name)}</p>
    <p class="popup-meta">${escapeHtml(h.address)}</p>
    <p class="popup-meta"><strong>${h.bedsAvailable}</strong> beds available (indicative)</p>
    ${doctorsLineHtml(h.id, doctorsMap)}`;
  }

  function cardDoctorsSnippet(hid, doctorsMap) {
    const docs = doctorsMap[hid];
    if (!docs || docs.length === 0) {
      return `<p class="address" style="margin-top:0.35rem">Doctors: <em>none listed</em></p>`;
    }
    const short = docs
      .slice(0, 3)
      .map((d) => `${escapeHtml(d.name)} — ${escapeHtml(d.specialty)}`)
      .join("<br />");
    const more = docs.length > 3 ? `<br /><em>+${docs.length - 3} more</em>` : "";
    return `<p class="address" style="margin-top:0.35rem"><strong>Doctors:</strong><br />${short}${more}</p>`;
  }

  function setActiveCard(id) {
    if (!listEl) return;
    listEl.querySelectorAll(".hospital-card").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.id === id);
    });
  }

  function renderHospitals(HOSPITALS, doctorsMap) {
    if (!listEl || !map) return;
    listEl.innerHTML = "";
    markers.forEach((m) => map.removeLayer(m));
    markers.clear();

    const bounds = L.latLngBounds(HOSPITALS.map((h) => [h.lat, h.lng]));
    map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });

    HOSPITALS.forEach((h) => {
      const marker = L.marker([h.lat, h.lng], { icon: iconForHospital() })
        .addTo(map)
        .bindPopup(popupHtml(h, doctorsMap));

      marker.on("click", () => setActiveCard(h.id));
      markers.set(h.id, marker);

      const li = document.createElement("li");
      li.innerHTML = `
      <article class="hospital-card" tabindex="0" role="button" data-id="${h.id}" aria-label="${escapeHtml(h.name)}">
        <h3>${escapeHtml(h.name)}</h3>
        <p class="address">${escapeHtml(h.address)}</p>
        ${cardDoctorsSnippet(h.id, doctorsMap)}
        <div class="beds-row">
          <span class="check" aria-hidden="true">✓</span>
          <span>${h.bedsAvailable} beds available</span>
        </div>
      </article>`;
      const card = li.querySelector(".hospital-card");

      function focusHospital() {
        setActiveCard(h.id);
        map.flyTo([h.lat, h.lng], Math.max(map.getZoom(), 16), { duration: 0.45 });
        marker.openPopup();
      }

      card.addEventListener("click", focusHospital);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          focusHospital();
        }
      });
      listEl.appendChild(li);
    });
  }

  async function reloadPublicMap() {
    if (!map || !listEl) return;
    const data = await loadHospitalData();
    const doctorsMap = await loadDoctorsByHospital();
    renderHospitals(data, doctorsMap);
  }

  function initMapIfNeeded() {
    if (map) {
      setTimeout(() => map.invalidateSize(), 80);
      return;
    }

    listEl = document.getElementById("hospital-list");
    if (!document.getElementById("map")) return;

    const pinStyle = document.createElement("style");
    pinStyle.textContent = `
      .hospital-pin { background: none; border: none; }
      .hospital-pin .pin-inner {
        display: block; width: 26px; height: 26px; background: #e63946;
        border: 3px solid #fff; border-radius: 50% 50% 50% 0; transform: rotate(-45deg);
        box-shadow: 0 2px 8px rgba(0,0,0,0.35); margin: 4px 0 0 1px;
      }`;
    document.head.appendChild(pinStyle);

    map = L.map("map", { scrollWheelZoom: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    map.on("click", () => {
      listEl.querySelectorAll(".hospital-card").forEach((el) => el.classList.remove("is-active"));
    });

    loadHospitalData().then((data) =>
      loadDoctorsByHospital().then((doctorsMap) => renderHospitals(data, doctorsMap))
    );
  }

  /* -------- Staff -------- */
  function staffToken() {
    return localStorage.getItem(STAFF_TOKEN_KEY);
  }
  function setStaffToken(t) {
    if (t) localStorage.setItem(STAFF_TOKEN_KEY, t);
    else localStorage.removeItem(STAFF_TOKEN_KEY);
  }

  function staffExplainFetch(err) {
    const base = "Cannot reach the API at " + API_BASE + ". Run start-all.bat.";
    if (err && err.name === "TypeError" && String(err.message).includes("fetch")) return base;
    return err && err.message ? err.message : base;
  }

  async function staffApi(path, opts) {
    const headers = { "Content-Type": "application/json", ...opts.headers };
    const t = staffToken();
    if (t) headers.Authorization = "Bearer " + t;
    let r;
    try {
      r = await fetch(API_BASE + path, { ...opts, headers });
    } catch (err) {
      throw new Error(staffExplainFetch(err));
    }
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {}
    if (!r.ok) {
      let msg = data && data.detail ? (Array.isArray(data.detail) ? data.detail[0].msg : data.detail) : r.statusText;
      if (r.status === 404 && String(path).startsWith("/api/")) {
        msg =
          "Not Found at " +
          API_BASE +
          path +
          ". Use API on port 8088 from this project — see http://" +
          window.location.hostname +
          ":8088/docs";
      }
      throw new Error(typeof msg === "string" ? msg : "Request failed");
    }
    return data;
  }

  function staffShowLogin() {
    document.getElementById("staff-login-section").hidden = false;
    document.getElementById("staff-dash-section").hidden = true;
  }

  function staffShowDash() {
    document.getElementById("staff-login-section").hidden = true;
    document.getElementById("staff-dash-section").hidden = false;
  }

  function renderStaffDoctors(rows) {
    const doctorListEl = document.getElementById("staff-doctor-list");
    doctorListEl.innerHTML = "";
    if (!rows.length) {
      doctorListEl.innerHTML = '<p class="hint" style="margin:0">No doctors listed yet.</p>';
      return;
    }
    rows.forEach((d) => {
      const div = document.createElement("div");
      div.className = "doc-row";
      const onDuty = d.is_available === 1 || d.is_available === true;
      div.innerHTML = `
        <div class="doc-meta">
          <div class="doc-name"></div>
          <div class="doc-spec"></div>
        </div>
        <button type="button" class="small secondary btn-toggle" data-id="${d.id}">${onDuty ? "Mark off duty" : "Mark on duty"}</button>
        <button type="button" class="small danger btn-del" data-id="${d.id}">Remove</button>`;
      div.querySelector(".doc-name").textContent = d.name;
      div.querySelector(".doc-spec").textContent = d.specialty + (onDuty ? "" : " (hidden from public)");
      div.querySelector(".btn-toggle").addEventListener("click", async () => {
        document.getElementById("staff-doc-error").hidden = true;
        try {
          await staffApi("/api/me/doctors/" + d.id, {
            method: "PATCH",
            body: JSON.stringify({ is_available: !onDuty }),
          });
          await loadStaffDoctors();
          reloadPublicMap();
        } catch (e) {
          document.getElementById("staff-doc-error").textContent = e.message;
          document.getElementById("staff-doc-error").hidden = false;
        }
      });
      div.querySelector(".btn-del").addEventListener("click", async () => {
        if (!confirm("Remove this doctor?")) return;
        document.getElementById("staff-doc-error").hidden = true;
        try {
          await staffApi("/api/me/doctors/" + d.id, { method: "DELETE" });
          await loadStaffDoctors();
          reloadPublicMap();
        } catch (e) {
          document.getElementById("staff-doc-error").textContent = e.message;
          document.getElementById("staff-doc-error").hidden = false;
        }
      });
      doctorListEl.appendChild(div);
    });
  }

  async function loadStaffDoctors() {
    document.getElementById("staff-doc-error").hidden = true;
    const rows = await staffApi("/api/me/doctors");
    renderStaffDoctors(rows);
  }

  async function loadStaffDash() {
    document.getElementById("staff-dash-error").hidden = true;
    const h = await staffApi("/api/me/hospital");
    document.getElementById("staff-hospital-title").textContent = h.name;
    document.getElementById("staff-hospital-address").textContent = h.address;
    document.getElementById("staff-beds").value = h.beds_available;
  }

  function initStaff() {
    document.getElementById("staff-btn-login").addEventListener("click", async () => {
      document.getElementById("staff-login-error").hidden = true;
      try {
        const out = await staffApi("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({
            username: document.getElementById("staff-username").value.trim(),
            password: document.getElementById("staff-password").value,
          }),
        });
        setStaffToken(out.access_token);
        await loadStaffDash();
        await loadStaffDoctors();
        staffShowDash();
      } catch (e) {
        document.getElementById("staff-login-error").textContent = staffExplainFetch(e) || "Login failed";
        document.getElementById("staff-login-error").hidden = false;
      }
    });

    document.getElementById("staff-btn-save").addEventListener("click", async () => {
      document.getElementById("staff-dash-error").hidden = true;
      const beds = parseInt(document.getElementById("staff-beds").value, 10);
      if (Number.isNaN(beds) || beds < 0) {
        document.getElementById("staff-dash-error").textContent = "Enter a valid bed count";
        document.getElementById("staff-dash-error").hidden = false;
        return;
      }
      try {
        await staffApi("/api/me/hospital/beds", {
          method: "PATCH",
          body: JSON.stringify({ beds_available: beds }),
        });
        reloadPublicMap();
        alert("Beds saved.");
      } catch (e) {
        document.getElementById("staff-dash-error").textContent = e.message || "Save failed";
        document.getElementById("staff-dash-error").hidden = false;
      }
    });

    document.getElementById("staff-btn-add-doc").addEventListener("click", async () => {
      document.getElementById("staff-doc-error").hidden = true;
      const name = document.getElementById("staff-doc-name").value.trim();
      const specialty = document.getElementById("staff-doc-specialty").value.trim();
      if (!name || !specialty) {
        document.getElementById("staff-doc-error").textContent = "Enter doctor name and specialty.";
        document.getElementById("staff-doc-error").hidden = false;
        return;
      }
      try {
        await staffApi("/api/me/doctors", {
          method: "POST",
          body: JSON.stringify({ name, specialty, is_available: true }),
        });
        document.getElementById("staff-doc-name").value = "";
        document.getElementById("staff-doc-specialty").value = "";
        await loadStaffDoctors();
        reloadPublicMap();
      } catch (e) {
        document.getElementById("staff-doc-error").textContent = e.message;
        document.getElementById("staff-doc-error").hidden = false;
      }
    });

    document.getElementById("staff-btn-logout").addEventListener("click", () => {
      setStaffToken(null);
      staffShowLogin();
    });

    if (staffToken()) {
      loadStaffDash()
        .then(() => loadStaffDoctors())
        .then(() => staffShowDash())
        .catch(() => {
          setStaffToken(null);
          staffShowLogin();
        });
    } else {
      staffShowLogin();
    }
  }

  /* -------- Patient -------- */
  function ptToken() {
    return localStorage.getItem(PT_TOKEN_KEY);
  }
  function setPtToken(t) {
    if (t) localStorage.setItem(PT_TOKEN_KEY, t);
    else localStorage.removeItem(PT_TOKEN_KEY);
  }

  async function ptApi(path, opts) {
    const headers = { "Content-Type": "application/json", ...opts.headers };
    if (ptToken()) headers.Authorization = "Bearer " + ptToken();
    const r = await fetch(API_BASE + path, { ...opts, headers });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      let d = data.detail;
      if (Array.isArray(d)) d = d.map((x) => x.msg || x).join(", ");
      throw new Error(d || r.statusText);
    }
    return data;
  }

  function ptAppendBubble(text, who) {
    const el = document.getElementById("pt-messages");
    const d = document.createElement("div");
    d.className = "bubble " + (who === "user" ? "user" : "bot");
    d.textContent = text;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }

  async function ptLoadHistory() {
    const el = document.getElementById("pt-messages");
    el.innerHTML = "";
    const rows = await ptApi("/api/patient/chat/history");
    rows.forEach((r) => {
      if (r.role === "user" || r.role === "assistant") {
        ptAppendBubble(r.content, r.role === "user" ? "user" : "bot");
      }
    });
  }

  async function ptRefreshBanner() {
    const banner = document.getElementById("pt-ai-banner");
    try {
      const h = await fetch(API_BASE + "/api/health");
      const j = await h.json();
      if (j.ai) {
        banner.textContent = "AI assistant enabled (OpenAI).";
        banner.className = "pt-banner ai-on";
      } else {
        banner.textContent = "Demo mode: set OPENAI_API_KEY on the server for ChatGPT-style answers.";
        banner.className = "pt-banner";
      }
    } catch {
      banner.textContent = "Could not reach API — run start-all.bat.";
      banner.className = "pt-banner";
    }
  }

  function ptShowChat() {
    document.getElementById("pt-wrap-auth").classList.add("is-hidden");
    document.getElementById("pt-wrap-chat").classList.remove("is-hidden");
    document.getElementById("pt-logout").hidden = false;
  }

  function ptShowAuth() {
    document.getElementById("pt-wrap-auth").classList.remove("is-hidden");
    document.getElementById("pt-wrap-chat").classList.add("is-hidden");
    document.getElementById("pt-logout").hidden = true;
  }

  function initPatient() {
    document.getElementById("pt-tab-signin").addEventListener("click", () => {
      document.getElementById("pt-tab-signin").classList.add("is-active");
      document.getElementById("pt-tab-register").classList.remove("is-active");
      document.getElementById("pt-signin-card").classList.remove("is-hidden");
      document.getElementById("pt-reg-card").classList.add("is-hidden");
    });
    document.getElementById("pt-tab-register").addEventListener("click", () => {
      document.getElementById("pt-tab-register").classList.add("is-active");
      document.getElementById("pt-tab-signin").classList.remove("is-active");
      document.getElementById("pt-reg-card").classList.remove("is-hidden");
      document.getElementById("pt-signin-card").classList.add("is-hidden");
    });

    document.getElementById("pt-btn-login").addEventListener("click", async () => {
      const err = document.getElementById("pt-login-err");
      err.hidden = true;
      try {
        const out = await ptApi("/api/auth/patient/login", {
          method: "POST",
          body: JSON.stringify({
            username: document.getElementById("pt-lu").value.trim(),
            password: document.getElementById("pt-lp").value,
          }),
        });
        setPtToken(out.access_token);
        ptShowChat();
        await ptRefreshBanner();
        await ptLoadHistory();
      } catch (e) {
        err.textContent = e.message || "Login failed";
        err.hidden = false;
      }
    });

    document.getElementById("pt-btn-register").addEventListener("click", async () => {
      const err = document.getElementById("pt-reg-err");
      err.hidden = true;
      try {
        const out = await ptApi("/api/auth/patient/register", {
          method: "POST",
          body: JSON.stringify({
            username: document.getElementById("pt-reg-user").value.trim(),
            password: document.getElementById("pt-reg-pass").value,
          }),
        });
        setPtToken(out.access_token);
        ptShowChat();
        await ptRefreshBanner();
        await ptLoadHistory();
      } catch (e) {
        err.textContent = e.message || "Registration failed";
        err.hidden = false;
      }
    });

    document.getElementById("pt-send").addEventListener("click", async () => {
      const ta = document.getElementById("pt-msg");
      const text = ta.value.trim();
      if (!text) return;
      ta.value = "";
      ptAppendBubble(text, "user");
      try {
        const out = await ptApi("/api/patient/chat", {
          method: "POST",
          body: JSON.stringify({ message: text }),
        });
        ptAppendBubble(out.reply, "bot");
      } catch (e) {
        ptAppendBubble("Error: " + (e.message || "request failed"), "bot");
      }
    });

    document.getElementById("pt-logout").addEventListener("click", () => {
      setPtToken(null);
      ptShowAuth();
    });

    if (ptToken()) {
      ptShowChat();
      ptRefreshBanner();
      ptLoadHistory().catch(() => {
        setPtToken(null);
        ptShowAuth();
      });
    } else {
      ptShowAuth();
    }
  }

  /* -------- boot -------- */
  document.addEventListener("DOMContentLoaded", () => {
    initNav();
    initStaff();
    initPatient();

    const raw = (location.hash || "#map").slice(1);
    const initial = ["map", "staff", "patient"].includes(raw) ? raw : "map";
    showView(initial, { updateHash: false });

    if (initial === "map") {
      initMapIfNeeded();
    }
  });
})();
