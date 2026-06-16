"use strict";

// ── Hjalpare ────────────────────────────────────────────────────────────────
const app = document.getElementById("app");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const LANG_NAMES = { sv: "Svenska", en: "Engelska" };
const langName = (l) => LANG_NAMES[l] || (l || "").toUpperCase();

async function api(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
    out.push(
      `<a class="btn" href="${esc(links.apple)}" target="_blank" rel="noopener"><span class="btn-icon"></span>Apple Podcasts</a>`
    );
  if (links?.spotify)
    out.push(
      `<a class="btn primary" href="${esc(links.spotify)}" target="_blank" rel="noopener"><span class="btn-icon">▶</span>Spotify</a>`
    );
  if (links?.web)
    out.push(
      `<a class="btn" href="${esc(links.web)}" target="_blank" rel="noopener"><span class="btn-icon">🔗</span>Webbspelare</a>`
    );
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
    .map(
      (s) =>
        `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || "Kalla")}</a>`
    )
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
  return `
    <div class="today-banner"><span class="dot"></span>${stale ? "Senaste tipset" : "Dagens tips"} · ${esc(fmtDate(rec.date))}</div>
    <article class="hero">
      <div class="kicker">${esc(rec.show_name)}</div>
      <h2>${esc(rec.episode_title)}</h2>
      <div class="show">${rec.hosts ? "Med " + esc(rec.hosts) : ""}</div>
      <div class="meta">${chips(rec)}</div>
      <p class="why">${esc(rec.why_great)}</p>
      <div class="actions">${listenButtons(rec.listen_links) || '<span class="muted">Lyssna-lankar saknas</span>'}</div>
      ${sourcesBlock(rec)}
    </article>
    ${staleNote}`;
}

function historyCard(rec) {
  return `
    <a class="card" href="#/avsnitt/${esc(rec.id)}">
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
    const data = await api("/api/today");
    app.innerHTML = heroCard(data.recommendation, data.stale, data.today);
  } catch (e) {
    app.innerHTML = `<div class="error-box">Kunde inte ladda dagens tips (${esc(e.message)}).</div>`;
  }
}

let historyState = { search: "", genre: "", language: "", show: "" };

async function viewHistory() {
  app.innerHTML = `
    <div class="section-head"><h1>Historik</h1><span class="muted" id="hist-count"></span></div>
    <div class="filters">
      <input id="f-search" class="input" type="search" placeholder="Sok titel, podd, vard…" value="${esc(historyState.search)}" />
      <select id="f-genre" class="select"><option value="">Alla genrer</option></select>
      <select id="f-language" class="select">
        <option value="">Alla sprak</option>
        <option value="sv"${historyState.language === "sv" ? " selected" : ""}>Svenska</option>
        <option value="en"${historyState.language === "en" ? " selected" : ""}>Engelska</option>
      </select>
    </div>
    <div id="hist-list" class="card-list"><div class="loading">Laddar…</div></div>`;

  // Fyll genre-filter fran statistiken (sa det speglar faktisk data).
  try {
    const stats = await api("/api/stats");
    const sel = document.getElementById("f-genre");
    for (const g of stats.byGenre) {
      const opt = document.createElement("option");
      opt.value = g.genre;
      opt.textContent = `${g.genre} (${g.count})`;
      if (historyState.genre === g.genre) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch {
    /* genre-filter ar valfritt */
  }

  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  const run = debounce(loadHistory, 250);
  document.getElementById("f-search").addEventListener("input", (e) => {
    historyState.search = e.target.value.trim();
    run();
  });
  document.getElementById("f-genre").addEventListener("change", (e) => {
    historyState.genre = e.target.value;
    loadHistory();
  });
  document.getElementById("f-language").addEventListener("change", (e) => {
    historyState.language = e.target.value;
    loadHistory();
  });

  loadHistory();
}

async function loadHistory() {
  const list = document.getElementById("hist-list");
  const countEl = document.getElementById("hist-count");
  if (!list) return;
  const qs = new URLSearchParams();
  if (historyState.search) qs.set("search", historyState.search);
  if (historyState.genre) qs.set("genre", historyState.genre);
  if (historyState.language) qs.set("language", historyState.language);
  if (historyState.show) qs.set("show", historyState.show);
  try {
    const data = await api(`/api/history?${qs.toString()}`);
    if (countEl) countEl.textContent = `${data.count} tips`;
    list.innerHTML = data.items.length
      ? data.items.map(historyCard).join("")
      : `<div class="empty">Inga tips matchar filtret.</div>`;
  } catch (e) {
    list.innerHTML = `<div class="error-box">Kunde inte ladda historiken (${esc(e.message)}).</div>`;
  }
}

async function viewDetail(id) {
  app.innerHTML = `<div class="loading">Laddar…</div>`;
  try {
    const data = await api(`/api/recommendation/${encodeURIComponent(id)}`);
    const rec = data.recommendation;
    app.innerHTML = `
      <a class="back" href="#/historik">← Tillbaka till historiken</a>
      ${heroCard(rec, false, rec.date)}`;
  } catch (e) {
    app.innerHTML = `
      <a class="back" href="#/historik">← Tillbaka</a>
      <div class="error-box">Avsnittet hittades inte.</div>`;
  }
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
    const s = await api("/api/stats");
    const maxShow = s.topShows[0]?.count || 1;
    const maxGenre = s.byGenre[0]?.count || 1;
    const maxLang = s.byLanguage[0]?.count || 1;
    const maxTl = s.timeline.reduce((m, t) => Math.max(m, t.count), 1);

    const timeline = s.timeline.length
      ? `<div class="panel">
          <h3>Tidslinje (tips per manad)</h3>
          <div class="timeline">
            ${s.timeline
              .map(
                (t) =>
                  `<div class="tl-bar" style="height:${Math.max(6, Math.round((t.count / maxTl) * 100))}%" title="${esc(t.period)}: ${t.count}"></div>`
              )
              .join("")}
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
    viewDetail(detail[1]);
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
