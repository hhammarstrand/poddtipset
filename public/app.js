"use strict";

// ── Hjalpare ────────────────────────────────────────────────────────────────
const app = document.getElementById("app");

const SITE_NAME = "Dagens Pod";

// ── Tema (morkt/ljust) ───────────────────────────────────────────────────────
// Inget val sparat = folj systemet (CSS prefers-color-scheme). Knappen overstyr
// och sparas i localStorage. <meta name="theme-color"> uppdateras till aktivt tema.
const THEME_COLORS = { light: "#8c2f23", dark: "#0f0d0c" };

function resolvedTheme() {
  const saved = document.documentElement.dataset.theme;
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLORS[resolvedTheme()]);
}

function initTheme() {
  applyThemeColor();
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = resolvedTheme() === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("theme", next); } catch (e) {}
      applyThemeColor();
    });
  }
  // Folj systembyte sa lange anvandaren inte gjort ett eget val.
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (!document.documentElement.dataset.theme) applyThemeColor(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
}

// Per-vy: uppdatera <title> + meta-description sa varje vy har ratt SEO/delning.
function setMeta(title, description) {
  document.title = title;
  if (description) {
    const m = document.querySelector('meta[name="description"]');
    if (m) m.setAttribute("content", description);
  }
}

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

// ── Komponenter ───────────────────────────────────────────────────────────────
// Tvinga svensk storefront pa Apple Podcasts-lankar OCH ta bort sprakparametern
// (annars kan sidan oppnas pa fel sprak, t.ex. ?l=ar -> arabiska).
function appleSe(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)apple\.com$/i.test(u.hostname)) return url;
    u.pathname = u.pathname.replace(/^\/[a-z]{2}\//i, "/se/");
    u.searchParams.delete("l");
    return u.toString();
  } catch {
    return String(url);
  }
}

// Kort datum, t.ex. "17 juni".
function fmtDayMonth(d) {
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("sv-SE", { day: "numeric", month: "long" });
  } catch {
    return d;
  }
}

function listenButtons(links) {
  const out = [];
  if (links?.apple)
    out.push(`<a class="btn" href="${esc(appleSe(links.apple))}" target="_blank" rel="noopener"><span class="btn-icon"></span>Apple Podcasts</a>`);
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
    .map((s) => `<a href="${esc(appleSe(s.url))}" target="_blank" rel="noopener">${esc(s.title || "Kalla")}</a>`)
    .join("");
  return `<div class="sources"><span class="label">Varför det räknas som ett av de bästa</span>${links}</div>`;
}

function heroCard(rec, stale, today) {
  if (!rec) {
    return `<div class="empty">Inget tips än. Det första tipset dyker upp här snart.</div>`;
  }
  const staleNote = stale
    ? `<p class="stale-note">Dagens tips (${esc(today)}) är på väg – under tiden visas det senaste.</p>`
    : "";
  const dayConnection = rec.day_connection
    ? `<div class="day-connection">
        <span class="day-connection-label">Knyter an till ${esc(fmtDayMonth(rec.date))}</span>
        ${rec.day_occasion ? `<span class="day-occasion">${esc(rec.day_occasion)}</span>` : ""}
        <span class="day-text">${esc(rec.day_connection)}</span>
      </div>`
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
      <div class="actions">${listenButtons(rec.listen_links) || '<span class="muted">Lyssna-länkar saknas</span>'}</div>
      ${sourcesBlock(rec)}
    </article>
    ${staleNote}`;
}

// Forrenderad/klient-delad "Fler tips"-lista under dagens hero (rikare startsida).
function moreTipsHtml(data, excludeDate) {
  const items = data
    .filter((r) => r.date !== excludeDate)
    .slice(0, 8)
    .map((r) => `<li><a href="#/avsnitt/${esc(r.date)}"><span class="more-date">${esc(fmtDayMonth(r.date))}</span> <span class="more-title">${esc(r.episode_title)}</span> <span class="more-show">${esc(r.show_name)}</span></a></li>`)
    .join("");
  if (!items) return "";
  return `<nav class="more-tips" aria-label="Fler tips"><h2 class="more-head">Fler tips</h2><ul>${items}</ul></nav>`;
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
  // Behall den forrenderade hero:n (riktigt innehall fran build-steget) under
  // tiden datan laddas – ingen "Laddar"-blink. Visa bara spinner om inget finns.
  if (!app.querySelector(".hero.prerendered")) {
    app.innerHTML = `<div class="loading">Laddar dagens tips…</div>`;
  }
  try {
    const data = await loadData();
    const today = todayStockholm();
    const todayRec = data.find((r) => r.date === today);
    const rec = todayRec || data[0] || null;
    app.innerHTML = heroCard(rec, !todayRec && data.length > 0, today) + (rec ? moreTipsHtml(data, rec.date) : "");
    if (rec) {
      setMeta(`${SITE_NAME} · ${rec.episode_title} – ${rec.show_name}`,
        String(rec.why_great || "").replace(/\s+/g, " ").trim().slice(0, 160));
    } else {
      setMeta(`${SITE_NAME} – Ett handplockat poddavsnitt om dagen`);
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
  setMeta(`Historik · ${SITE_NAME}`, `Alla tidigare poddtips från ${SITE_NAME} – ${data.length} dokumenterat hyllade avsnitt att bläddra och söka bland.`);

  app.innerHTML = `
    <div class="section-head"><h1>Historik</h1><span class="muted" id="hist-count"></span></div>
    <div class="filters">
      <input id="f-search" class="input" type="search" placeholder="Sök titel, podd, värd…" value="${esc(historyState.search)}" />
      <select id="f-genre" class="select">
        <option value="">Alla genrer</option>
        ${genres.map((g) => `<option value="${esc(g)}"${historyState.genre === g ? " selected" : ""}>${esc(g)}</option>`).join("")}
      </select>
      <select id="f-language" class="select">
        <option value="">Alla språk</option>
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
    if (rec) {
      setMeta(`${rec.episode_title} – ${rec.show_name} · ${SITE_NAME}`,
        String(rec.why_great || "").replace(/\s+/g, " ").trim().slice(0, 160));
    }
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
function computeStats(data) {
  const total = data.length;
  const showMap = new Map();
  const genreMap = new Map();
  const langMap = new Map();

  for (const r of data) {
    const sShow = showMap.get(r.show_slug) || { show_slug: r.show_slug, show_name: r.show_name, count: 0 };
    sShow.count++;
    showMap.set(r.show_slug, sShow);
    if (r.genre) genreMap.set(r.genre, (genreMap.get(r.genre) || 0) + 1);
    if (r.language) langMap.set(r.language, (langMap.get(r.language) || 0) + 1);
  }

  const topShows = [...showMap.values()].sort((a, b) => b.count - a.count || a.show_name.localeCompare(b.show_name));
  const byGenre = [...genreMap.entries()].map(([genre, count]) => ({ genre, count })).sort((a, b) => b.count - a.count);
  const byLanguage = [...langMap.entries()].map(([language, count]) => ({ language, count })).sort((a, b) => b.count - a.count);

  return { total, topShows, byGenre, byLanguage };
}

function bars(items, nameKey, max) {
  if (!items.length) return `<div class="muted">Ingen data än.</div>`;
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
  app.innerHTML = `<div class="loading">Räknar statistik…</div>`;
  setMeta(`Statistik · ${SITE_NAME}`, `Statistik över ${SITE_NAME}: mest rekommenderade poddar, fördelning per genre och språk.`);
  try {
    const data = await loadData();
    const s = computeStats(data);
    if (!s.total) {
      app.innerHTML = `<div class="section-head"><h1>Statistik</h1></div><div class="empty">Ingen statistik än – statistiken växer i takt med att tips genereras.</div>`;
      return;
    }
    const maxShow = s.topShows[0]?.count || 1;
    const maxGenre = s.byGenre[0]?.count || 1;
    const maxLang = s.byLanguage[0]?.count || 1;

    app.innerHTML = `
      <div class="section-head"><h1>Statistik</h1></div>
      <div class="stat-grid">
        <div class="stat"><div class="num">${s.total}</div><div class="lbl">Tips totalt</div></div>
        <div class="stat"><div class="num">${s.topShows.length}</div><div class="lbl">Unika poddar</div></div>
        <div class="stat"><div class="num">${s.byGenre.length}</div><div class="lbl">Genrer</div></div>
      </div>
      <div class="panel"><h3>Mest rekommenderade poddar</h3>${bars(s.topShows.slice(0, 10), "show_name", maxShow)}</div>
      <div class="panel"><h3>Fördelning per genre</h3>${bars(s.byGenre.slice(0, 10), "genre", maxGenre)}</div>
      <div class="panel"><h3>Fördelning per språk</h3>${bars(s.byLanguage, "language", maxLang)}</div>`;
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

window.addEventListener("hashchange", router);
initTheme();
router();
