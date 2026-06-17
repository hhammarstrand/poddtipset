"use strict";

// ── Hjalpare ────────────────────────────────────────────────────────────────
const app = document.getElementById("app");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const LANG_NAMES = { sv: "Svenska", en: "Engelska" };
const langName = (l) => LANG_NAMES[l] || (l || "").toUpperCase();

function todayStockholm() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ── Datakalla: statisk JSON (genererad av GitHub Actions) ─────────────────────
let _data = null;
async function loadData() {
  if (_data) return _data;
  const res = await fetch("./data/recommendations.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arr = await res.json();
  // Nyast forst.
  _data = (Array.isArray(arr) ? arr : []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  return _data;
}

function fmtDuration(min) {
  if (!min || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

function fmtDate(d) {
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("sv-SE", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

// ── Tema ─────────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const cur =
      document.documentElement.getAttribute("data-theme") ||
      (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = cur === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  });
}

// ── Komponenter ───────────────────────────────────────────────────────────────
function listenButtons(links) {
  const out = [];
  if (links?.apple)
    out.push(`<a class="btn" href="${esc(links.apple)}" target="_blank" rel="noopener"><span class="btn-icon"></span>Apple Podcasts</a>`);
  if (links?.spotify)
    out.push(`<a class="btn primary" href="${esc(links.spotify)}" target="_blank" rel="noopener"><span class="btn-icon">▶</span>Spotify</a>`);
  if (links?.web)
    out.push(`<a class="btn" href="${esc(links.web)}" target="_blank" rel="noopener"><span class="btn-icon">🔗</span>Webbspelare</a>`);
  return out.join("");
}

function chips(rec) {
  const out = [];
  if (rec.genre) out.push(`<span class="chip"><b>${esc(rec.genre)}</b></span>`);
  if (rec.language) out.push(`<span class="chip">${esc(langName(rec.language))}</span>`);
  if (rec.year) out.push(`<span class="chip">${esc(rec.year)}</span>`);
  const dur = fmtDuration(rec.duration_minutes);
  if (dur) out.push(`<span class="chip">⏱ ${esc(dur)}</span>`);
  if (rec.hosts) out.push(`<span class="chip">${esc(rec.hosts)}</span>`);
  return out.join("");
}

function sourcesBlock(rec) {
  if (!rec.sources || !rec.sources.length) return "";
  const links = rec.sources
    .slice(0, 2)
    .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || "Kalla")}</a>`)
    .join("");
  return `<div class="sources"><span class="label">Varfor det racknas som ett av de basta</span>${links}</div>`;
}

function heroCard(rec, stale, today) {
  if (!rec) {
    return `<div class="empty">Inget tips an. Det forsta tipset dyker upp har snart.</div>`;
  }
  const staleNote = stale
    ? `<p class="stale-note">Dagens tips (${esc(today)}) ar pa vag – under tiden visas det senaste.</p>`
    : "";
  const dayConnection = rec.day_connection
    ? `<p class="day-connection"><span class="day-connection-label">Knyter an till idag</span>${esc(rec.day_connection)}</p>`
    : "";
  return `
    <div class="today-banner"><span class="dot"></span>${stale ? "Senaste tipset" : "Dagens tips"} · ${esc(fmtDate(rec.date))}</div>
    <article class="hero">
      <div class="kicker">${esc(rec.show_name)}</div>
      <h2>${esc(rec.episode_title)}</h2>
      <div class="show">${rec.hosts ? "Med " + esc(rec.hosts) : ""}</div>
      <div class="meta">${chips(rec)}</div>
      ${dayConnection}
      <p class="why">${esc(rec.why_great)}</p>
      <div class="actions">${listenButtons(rec.listen_links) || '<span class="muted">Lyssna-lankar saknas</span>'}</div>
      ${sourcesBlock(rec)}
    </article>
    ${staleNote}`;
}

function historyCard(rec) {
  return `
    <a class="card" href="#/avsnitt/${esc(rec.date)}">
      <div class="date">${esc(fmtDate(rec.date))}</div>
      <h3>${esc(rec.episode_title)}</h3>
      <div class="show">${esc(rec.show_name)}</div>
      <div class="mini-meta">${chips(rec)}</div>
    </a>`;
}

// ── Vyer ──────────────────────────────────────────────────────────────────────
async function viewToday() {
  app.innerHTML = `<div class="loading">Laddar dagens tips…</div>`;
  try {
    const data = await loadData();
    const today = todayStockholm();
    const todayRec = data.find((r) => r.date === today);
    if (todayRec) {
      app.innerHTML = heroCard(todayRec, false, today);
    } else {
      app.innerHTML = heroCard(data[0] || null, data.length > 0, today);
    }
  } catch (e) {
    app.innerHTML = `<div class="error-box">Kunde inte ladda dagens tips (${esc(e.message)}).</div>`;
  }
}

let historyState = { search: "", genre: "", language: "" };

async function viewHistory() {
  let data;
  try {
    data = await loadData();
  } catch (e) {
    app.innerHTML = `<div class="error-box">Kunde inte ladda historiken (${esc(e.message)}).</div>`;
    return;
  }

  const genres = [...new Set(data.map((r) => r.genre).filter(Boolean))].sort();

  app.innerHTML = `
    <div class="section-head"><h1>Historik</h1><span class="muted" id="hist-count"></span></div>
    <div class="filters">
      <input id="f-search" class="input" type="search" placeholder="Sok titel, podd, vard…" value="${esc(historyState.search)}" />
      <select id="f-genre" class="select">
        <option value="">Alla genrer</option>
        ${genres.map((g) => `<option value="${esc(g)}"${historyState.genre === g ? " selected" : ""}>${esc(g)}</option>`).join("")}
      </select>
      <select id="f-language" class="select">
        <option value="">Alla sprak</option>
        <option value="sv"${historyState.language === "sv" ? " selected" : ""}>Svenska</option>
        <option value="en"${historyState.language === "en" ? " selected" : ""}>Engelska</option>
      </select>
    </div>
    <div id="hist-list" class="card-list"></div>`;

  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const run = debounce(renderHistory, 200);
  document.getElementById("f-search").addEventListener("input", (e) => { historyState.search = e.target.value.trim(); run(); });
  document.getElementById("f-genre").addEventListener("change", (e) => { historyState.genre = e.target.value; renderHistory(); });
  document.getElementById("f-language").addEventListener("change", (e) => { historyState.language = e.target.value; renderHistory(); });

  renderHistory();
}

function renderHistory() {
  const list = document.getElementById("hist-list");
  const countEl = document.getElementById("hist-count");
  if (!list || !_data) return;
  const q = historyState.search.toLowerCase();
  const items = _data.filter((r) => {
    if (historyState.genre && r.genre !== historyState.genre) return false;
    if (historyState.language && r.language !== historyState.language) return false;
    if (q) {
      const hay = `${r.episode_title} ${r.show_name} ${r.hosts} ${r.why_great}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (countEl) countEl.textContent = `${items.length} tips`;
  list.innerHTML = items.length
    ? items.map(historyCard).join("")
    : `<div class="empty">Inga tips matchar filtret.</div>`;
}

async function viewDetail(date) {
  app.innerHTML = `<div class="loading">Laddar…</div>`;
  try {
    const data = await loadData();
    const rec = data.find((r) => r.date === date);
    app.innerHTML = `
      <a class="back" href="#/historik">← Tillbaka till historiken</a>
      ${rec ? heroCard(rec, false, rec.date) : '<div class="error-box">Avsnittet hittades inte.</div>'}`;
  } catch (e) {
    app.innerHTML = `
      <a class="back" href="#/historik">← Tillbaka</a>
      <div class="error-box">Kunde inte ladda (${esc(e.message)}).</div>`;
  }
}

// ── Statistik (harleds klient-sidan) ─────────────────────────────────────────
function addDays(isoDate, delta) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function computeStreak(datesDesc, today) {
  if (!datesDesc.length) return 0;
  const set = new Set(datesDesc);
  let cursor = set.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (set.has(cursor)) { streak++; cursor = addDays(cursor, -1); }
  return streak;
}

function computeStats(data) {
  const total = data.length;
  const showMap = new Map();
  const genreMap = new Map();
  const langMap = new Map();
  const monthMap = new Map();

  for (const r of data) {
    const sShow = showMap.get(r.show_slug) || { show_slug: r.show_slug, show_name: r.show_name, count: 0 };
    sShow.count++;
    showMap.set(r.show_slug, sShow);
    if (r.genre) genreMap.set(r.genre, (genreMap.get(r.genre) || 0) + 1);
    if (r.language) langMap.set(r.language, (langMap.get(r.language) || 0) + 1);
    const period = String(r.date).slice(0, 7);
    monthMap.set(period, (monthMap.get(period) || 0) + 1);
  }

  const topShows = [...showMap.values()].sort((a, b) => b.count - a.count || a.show_name.localeCompare(b.show_name));
  const byGenre = [...genreMap.entries()].map(([genre, count]) => ({ genre, count })).sort((a, b) => b.count - a.count);
  const byLanguage = [...langMap.entries()].map(([language, count]) => ({ language, count })).sort((a, b) => b.count - a.count);
  const timeline = [...monthMap.entries()].map(([period, count]) => ({ period, count })).sort((a, b) => (a.period < b.period ? -1 : 1));
  const streak = computeStreak(data.map((r) => r.date), todayStockholm());

  return { total, topShows, byGenre, byLanguage, timeline, streak };
}

function bars(items, nameKey, max) {
  if (!items.length) return `<div class="muted">Ingen data an.</div>`;
  return items
    .map((it) => {
      const pct = max ? Math.round((it.count / max) * 100) : 0;
      const name = nameKey === "language" ? langName(it[nameKey]) : it[nameKey];
      return `<div class="bar-row">
        <span class="name" title="${esc(name)}">${esc(name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="val">${it.count}</span>
      </div>`;
    })
    .join("");
}

async function viewStats() {
  app.innerHTML = `<div class="loading">Raknar statistik…</div>`;
  try {
    const data = await loadData();
    const s = computeStats(data);
    if (!s.total) {
      app.innerHTML = `<div class="section-head"><h1>Statistik</h1></div><div class="empty">Ingen statistik an – statistiken vaxer i takt med att tips genereras.</div>`;
      return;
    }
    const maxShow = s.topShows[0]?.count || 1;
    const maxGenre = s.byGenre[0]?.count || 1;
    const maxLang = s.byLanguage[0]?.count || 1;
    const maxTl = s.timeline.reduce((m, t) => Math.max(m, t.count), 1);

    const timeline = s.timeline.length
      ? `<div class="panel">
          <h3>Tidslinje (tips per manad)</h3>
          <div class="timeline">
            ${s.timeline.map((t) => `<div class="tl-bar" style="height:${Math.max(6, Math.round((t.count / maxTl) * 100))}%" title="${esc(t.period)}: ${t.count}"></div>`).join("")}
          </div>
          <div class="tl-axis"><span>${esc(s.timeline[0].period)}</span><span>${esc(s.timeline[s.timeline.length - 1].period)}</span></div>
        </div>`
      : "";

    app.innerHTML = `
      <div class="section-head"><h1>Statistik</h1></div>
      <div class="stat-grid">
        <div class="stat"><div class="num">${s.total}</div><div class="lbl">Tips totalt</div></div>
        <div class="stat"><div class="num">${s.streak}</div><div class="lbl">Dagars streak</div></div>
        <div class="stat"><div class="num">${s.topShows.length}</div><div class="lbl">Unika poddar</div></div>
        <div class="stat"><div class="num">${s.byGenre.length}</div><div class="lbl">Genrer</div></div>
      </div>
      <div class="panel"><h3>Mest rekommenderade poddar</h3>${bars(s.topShows.slice(0, 10), "show_name", maxShow)}</div>
      <div class="panel"><h3>Fordelning per genre</h3>${bars(s.byGenre, "genre", maxGenre)}</div>
      <div class="panel"><h3>Fordelning per sprak</h3>${bars(s.byLanguage, "language", maxLang)}</div>
      ${timeline}`;
  } catch (e) {
    app.innerHTML = `<div class="error-box">Kunde inte ladda statistiken (${esc(e.message)}).</div>`;
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
function setActiveNav(route) {
  document.querySelectorAll(".nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === route);
  });
}

function router() {
  const hash = location.hash.replace(/^#/, "") || "/";
  window.scrollTo(0, 0);
  const detail = hash.match(/^\/avsnitt\/(.+)$/);
  if (detail) {
    setActiveNav("history");
    viewDetail(decodeURIComponent(detail[1]));
  } else if (hash.startsWith("/historik")) {
    setActiveNav("history");
    viewHistory();
  } else if (hash.startsWith("/statistik")) {
    setActiveNav("stats");
    viewStats();
  } else {
    setActiveNav("today");
    viewToday();
  }
}

initTheme();
window.addEventListener("hashchange", router);
router();
