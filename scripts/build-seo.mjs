// Dagens Pod – bygg SEO-/delnings-artefakter ur den statiska datafilen.
//
// Korst efter generate.mjs (och vid varje deploy). Lasar public/data/recommendations.json
// och producerar allt som gor sidan synlig for sokmotorer och delningsbar i sociala medier
// – utan att andra applikationslogiken. Deterministiskt: utdata andras BARA nar datan andras
// (inga tidsstamplar som tickar), sa commit-steget blir tyst nar inget nytt tips finns.
//
// Genererar/uppdaterar:
//   public/index.html      – injicerar <title>, meta-description, Open Graph/Twitter-cards,
//                            JSON-LD (WebSite + PodcastEpisode) och en FORRENDERAD hero
//                            (riktigt innehall i HTML for crawlers och no-JS), mellan markorer.
//   public/404.html        – kopia av index.html (SPA-fallback for djuplankar).
//   public/sitemap.xml     – startsida med lastmod = senaste tipsets datum.
//   public/robots.txt      – tillat allt + pekar pa sitemap.
//   public/feed.xml        – RSS-flode over alla tips (egen trafik-/prenumerationskanal).
//   public/manifest.webmanifest – PWA-manifest (installbar, "stora sidor"-kansla).
//
// Inga npm-beroenden. Node 20+.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const DATA_FILE = join(PUBLIC_DIR, "data", "recommendations.json");
const INDEX_FILE = join(PUBLIC_DIR, "index.html");

// Kanonisk publik adress. Overstyrbar via SITE_URL (t.ex. egen doman). Ingen avslutande slash.
const SITE_URL = (process.env.SITE_URL || "https://hhammarstrand.github.io/poddtipset").replace(/\/+$/, "");
const SITE_NAME = "Dagens Pod";
const SITE_TAGLINE = "Ett handplockat poddavsnitt om dagen";
const SITE_DESC =
  "Varje dygn ett dokumenterat hyllat poddavsnitt – handplockat och kallbelagt. " +
  "Se dagens tips, bladdra i historiken och utforska statistiken.";
const OG_IMAGE = `${SITE_URL}/og.png`;

// ── Hjalpare ────────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

// Sakert i JSON-LD <script>: forhindra att "</script>" eller HTML bryter ut.
const jsonLd = (obj) =>
  JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

function clip(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, "").trim() + "…";
}

const LANG_NAMES = { sv: "Svenska", en: "Engelska" };
const langName = (l) => LANG_NAMES[l] || String(l || "").toUpperCase();
const ogLocale = (l) => (l === "en" ? "en_US" : "sv_SE");

function fmtDateSv(d) {
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("sv-SE", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
  } catch { return d; }
}
function fmtDayMonth(d) {
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("sv-SE", { day: "numeric", month: "long" });
  } catch { return d; }
}
function fmtDuration(min) {
  if (!min || min <= 0) return null;
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}
// RFC-822-datum for RSS (12:00 UTC for stabilitet, oberoende av kortid).
function rfc822(d) {
  try { return new Date(d + "T12:00:00Z").toUTCString(); } catch { return new Date().toUTCString(); }
}
// Apple-lankar: tvinga svensk storefront, ta bort sprakparam (samma som frontend).
function appleSe(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)apple\.com$/i.test(u.hostname)) return url;
    u.pathname = u.pathname.replace(/^\/[a-z]{2}\//i, "/se/");
    u.searchParams.delete("l");
    return u.toString();
  } catch { return String(url); }
}

// Byt ut innehallet mellan <!--TAG--> och <!--/TAG--> (behaller markorerna).
function replaceRegion(html, tag, inner) {
  // Tolerera valfria blanksteg i markorerna: <!-- SEO-META --> och <!--SEO-META-->.
  const re = new RegExp(`(<!--\\s*${tag}\\s*-->)([\\s\\S]*?)(<!--\\s*/${tag}\\s*-->)`);
  if (!re.test(html)) throw new Error(`Markor <!--${tag}--> saknas i index.html`);
  return html.replace(re, `$1\n${inner}\n    $3`);
}

// ── Forrenderad hero (speglar app.js heroCard – riktigt innehall i HTML) ───────
function chipsHtml(rec) {
  const out = [];
  if (rec.genre) out.push(`<span class="chip"><b>${esc(rec.genre)}</b></span>`);
  if (rec.language) out.push(`<span class="chip">${esc(langName(rec.language))}</span>`);
  if (rec.year) out.push(`<span class="chip">${esc(rec.year)}</span>`);
  const dur = fmtDuration(rec.duration_minutes);
  if (dur) out.push(`<span class="chip">⏱ ${esc(dur)}</span>`);
  if (rec.hosts) out.push(`<span class="chip">${esc(rec.hosts)}</span>`);
  return out.join("");
}
function listenButtonsHtml(links) {
  const out = [];
  if (links?.apple)
    out.push(`<a class="btn" href="${esc(appleSe(links.apple))}" target="_blank" rel="noopener"><span class="btn-icon"></span>Apple Podcasts</a>`);
  if (links?.spotify)
    out.push(`<a class="btn primary" href="${esc(links.spotify)}" target="_blank" rel="noopener"><span class="btn-icon">▶</span>Spotify</a>`);
  if (links?.web)
    out.push(`<a class="btn" href="${esc(links.web)}" target="_blank" rel="noopener"><span class="btn-icon">🔗</span>Webbspelare</a>`);
  return out.join("");
}
function sourcesHtml(rec) {
  if (!rec.sources || !rec.sources.length) return "";
  const links = rec.sources.slice(0, 2)
    .map((s) => `<a href="${esc(appleSe(s.url))}" target="_blank" rel="noopener">${esc(s.title || "Kalla")}</a>`)
    .join("");
  return `<div class="sources"><span class="label">Varför det räknas som ett av de bästa</span>${links}</div>`;
}
function dayConnectionHtml(rec) {
  if (!rec.day_connection) return "";
  return `<div class="day-connection">
        <span class="day-connection-label">Knyter an till ${esc(fmtDayMonth(rec.date))}</span>
        ${rec.day_occasion ? `<span class="day-occasion">${esc(rec.day_occasion)}</span>` : ""}
        <span class="day-text">${esc(rec.day_connection)}</span>
      </div>`;
}

function prerenderedHero(rec, recent) {
  if (!rec) {
    return `<div class="empty">Inget tips än. Det första tipset dyker upp här snart.</div>`;
  }
  const moreItems = recent
    .filter((r) => r.date !== rec.date)
    .slice(0, 8)
    .map((r) => `<li><a href="#/avsnitt/${esc(r.date)}"><span class="more-date">${esc(fmtDayMonth(r.date))}</span> <span class="more-title">${esc(r.episode_title)}</span> <span class="more-show">${esc(r.show_name)}</span></a></li>`)
    .join("");
  return `<div class="today-banner"><span class="dot"></span>Dagens tips · ${esc(fmtDateSv(rec.date))}</div>
    <article class="hero prerendered">
      <div class="kicker">${esc(rec.show_name)}</div>
      <h2>${esc(rec.episode_title)}</h2>
      <div class="show">${rec.hosts ? "Med " + esc(rec.hosts) : ""}</div>
      <div class="meta">${chipsHtml(rec)}</div>
      ${dayConnectionHtml(rec)}
      <p class="why">${esc(rec.why_great)}</p>
      <div class="actions">${listenButtonsHtml(rec.listen_links) || '<span class="muted">Lyssna-länkar saknas</span>'}</div>
      ${sourcesHtml(rec)}
    </article>
    ${moreItems ? `<nav class="more-tips" aria-label="Fler tips"><h2 class="more-head">Fler tips</h2><ul>${moreItems}</ul></nav>` : ""}`;
}

// ── Meta-block (title/description/OG/Twitter/canonical) ────────────────────────
function metaBlock(rec) {
  const epTitle = rec ? `${rec.episode_title} – ${rec.show_name}` : SITE_TAGLINE;
  const pageTitle = rec ? `${SITE_NAME} · ${epTitle}` : `${SITE_NAME} – ${SITE_TAGLINE}`;
  const desc = rec && rec.why_great ? clip(rec.why_great, 160) : SITE_DESC;
  const lines = [
    `<title>${esc(pageTitle)}</title>`,
    `<meta name="description" content="${esc(desc)}" />`,
    `<link rel="canonical" href="${SITE_URL}/" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(SITE_NAME)}" />`,
    `<meta property="og:title" content="${esc(rec ? epTitle : pageTitle)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:url" content="${SITE_URL}/" />`,
    `<meta property="og:image" content="${OG_IMAGE}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(SITE_NAME)} – ${esc(SITE_TAGLINE)}" />`,
    `<meta property="og:locale" content="${rec ? ogLocale(rec.language) : "sv_SE"}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(rec ? epTitle : pageTitle)}" />`,
    `<meta name="twitter:description" content="${esc(desc)}" />`,
    `<meta name="twitter:image" content="${OG_IMAGE}" />`,
    `<link rel="alternate" type="application/rss+xml" title="${esc(SITE_NAME)} – dagens poddtips" href="${SITE_URL}/feed.xml" />`,
  ];
  return lines.map((l) => `    ${l}`).join("\n");
}

// ── JSON-LD (WebSite + dagens PodcastEpisode) ─────────────────────────────────
function jsonLdBlock(rec, recent) {
  const graph = [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      description: SITE_DESC,
      inLanguage: "sv-SE",
    },
  ];
  if (rec) {
    graph.push({
      "@type": "PodcastEpisode",
      "@id": `${SITE_URL}/#episode-${rec.date}`,
      url: `${SITE_URL}/`,
      name: rec.episode_title,
      datePublished: rec.date,
      inLanguage: rec.language === "en" ? "en" : "sv",
      description: clip(rec.why_great, 280),
      ...(rec.duration_minutes ? { timeRequired: `PT${rec.duration_minutes}M` } : {}),
      partOfSeries: { "@type": "PodcastSeries", name: rec.show_name },
      ...(rec.hosts ? { author: { "@type": "Person", name: rec.hosts } } : {}),
    });
  }
  if (recent && recent.length) {
    graph.push({
      "@type": "ItemList",
      "@id": `${SITE_URL}/#recent`,
      name: "Senaste poddtipsen",
      itemListElement: recent.slice(0, 10).map((r, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: `${r.show_name} – ${r.episode_title}`,
        url: `${SITE_URL}/#/avsnitt/${r.date}`,
      })),
    });
  }
  const doc = { "@context": "https://schema.org", "@graph": graph };
  return `    <script type="application/ld+json">${jsonLd(doc)}</script>`;
}

// ── sitemap / robots / RSS / manifest ─────────────────────────────────────────
function sitemapXml(latestDate) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <lastmod>${esc(latestDate || "")}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
}

function robotsTxt() {
  return `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
}

function feedXml(data) {
  const items = data.slice(0, 60).map((r) => {
    const title = `${r.show_name} – ${r.episode_title}`;
    const link = `${SITE_URL}/#/avsnitt/${r.date}`;
    const desc = clip(r.why_great, 500);
    return `    <item>
      <title>${esc(title)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="false">dagens-pod-${esc(r.date)}</guid>
      <pubDate>${rfc822(r.date)}</pubDate>
      ${r.genre ? `<category>${esc(r.genre)}</category>` : ""}
      <description>${esc(desc)}</description>
    </item>`;
  }).join("\n");
  const latest = data[0]?.date;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(SITE_NAME)} – dagens poddtips</title>
    <link>${SITE_URL}/</link>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml" />
    <description>${esc(SITE_DESC)}</description>
    <language>sv-se</language>
    ${latest ? `<lastBuildDate>${rfc822(latest)}</lastBuildDate>` : ""}
${items}
  </channel>
</rss>
`;
}

function manifest() {
  return JSON.stringify({
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: SITE_DESC,
    start_url: "./",
    scope: "./",
    display: "standalone",
    background_color: "#f6f1e7",
    theme_color: "#8c2f23",
    icons: [
      { src: "./icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  }, null, 2) + "\n";
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  let data = [];
  try {
    data = JSON.parse(await readFile(DATA_FILE, "utf8"));
    if (!Array.isArray(data)) data = [];
  } catch {
    data = [];
  }
  data = data.slice().sort((a, b) => (a.date < b.date ? 1 : -1)); // nyast forst
  const latest = data[0] || null;

  let html = await readFile(INDEX_FILE, "utf8");
  html = replaceRegion(html, "SEO-META", metaBlock(latest));
  html = replaceRegion(html, "SEO-JSONLD", jsonLdBlock(latest, data));
  html = replaceRegion(html, "SEO-HERO", prerenderedHero(latest, data));
  await writeFile(INDEX_FILE, html, "utf8");

  // SPA-fallback: djuplankar (om man byter till path-routing eller skriver in en URL).
  await writeFile(join(PUBLIC_DIR, "404.html"), html, "utf8");

  await writeFile(join(PUBLIC_DIR, "sitemap.xml"), sitemapXml(latest?.date), "utf8");
  await writeFile(join(PUBLIC_DIR, "robots.txt"), robotsTxt(), "utf8");
  await writeFile(join(PUBLIC_DIR, "feed.xml"), feedXml(data), "utf8");
  await writeFile(join(PUBLIC_DIR, "manifest.webmanifest"), manifest(), "utf8");

  console.log(`SEO byggd: ${data.length} tips, senast ${latest?.date || "—"}. Skrev index.html, 404.html, sitemap.xml, robots.txt, feed.xml, manifest.webmanifest.`);
}

main().catch((err) => {
  console.error(`::error::build-seo misslyckades: ${err?.stack || err}`);
  process.exit(1);
});
