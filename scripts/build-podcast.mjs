// Bygger ett RIKTIGT podd-RSS-flode (public/podcast.xml) som gar att lagga in i
// valfri poddspelare. Varje avsnitt pekar med <enclosure> pa poddens EGNA ljud-URL
// (lagrad i fältet "audio"), sa ljudet streamas fran utgivarens host – nedladdning,
// statistik och annonser stannar hos dem; vi re-hostar inget. Avsnitt utan
// upplosbar enclosure utelamnas (best-effort). Varje item lankar tillbaka till
// sajten (driver trafik). Korst som en del av byggsteget; ingen natverk kravs
// (allt las fran datafilen).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const DATA_FILE = join(PUBLIC_DIR, "data", "recommendations.json");

const SITE_URL = (process.env.SITE_URL || "https://hhammarstrand.github.io/poddtipset").replace(/\/+$/, "");
const SITE_NAME = "Dagens Podd";
const AUTHOR = "Dagens Podd";
const OWNER_EMAIL = process.env.PODCAST_OWNER_EMAIL || ""; // tom = utelamnas (exponera inte privat mejl)
const CATEGORY = "Society & Culture";
const DESC =
  "Ett handplockat, dokumenterat hyllat poddavsnitt om dagen – kurerat av Dagens Podd. " +
  "Varje dag lyfter vi fram ett enastaende avsnitt och lankar dig direkt till det. " +
  "Avsnitten spelas fran respektive podds eget flode.";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cdata = (s) => `<![CDATA[${String(s ?? "").replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;

function rfc822(d) {
  try { return new Date(d + "T08:00:00Z").toUTCString(); } catch { return new Date().toUTCString(); }
}
function hhmmss(sec) {
  if (!sec || sec <= 0) return null;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

async function main() {
  let data = [];
  try { data = JSON.parse(await readFile(DATA_FILE, "utf8")); if (!Array.isArray(data)) data = []; } catch { data = []; }
  data = data.slice().sort((a, b) => (a.date < b.date ? 1 : -1));

  const playable = data.filter((r) => r.audio && typeof r.audio.url === "string" && /^https?:\/\//i.test(r.audio.url));
  const skipped = data.length - playable.length;

  const items = playable.map((r) => {
    const page = `${SITE_URL}/#/avsnitt/${r.date}`;
    const dur = hhmmss(r.audio.durationSec);
    const title = `${r.show_name} – ${r.episode_title}`;
    const body =
      `<p><strong>${esc(r.show_name)} – ${esc(r.episode_title)}</strong></p>` +
      `<p>${esc(r.why_great || "")}</p>` +
      `<p>Dagens tips ${esc(r.date)} fran Dagens Podd. Las mer och se kallor: <a href="${esc(page)}">${esc(page)}</a></p>`;
    return `    <item>
      <title>${esc(title)}</title>
      <link>${esc(page)}</link>
      <guid isPermaLink="false">dagens-pod-${esc(r.date)}</guid>
      <pubDate>${rfc822(r.date)}</pubDate>
      <description>${cdata(body)}</description>
      <content:encoded>${cdata(body)}</content:encoded>
      <itunes:title>${esc(r.episode_title)}</itunes:title>
      <itunes:author>${esc(r.show_name)}</itunes:author>
      <itunes:summary>${esc((r.why_great || "").replace(/\s+/g, " ").trim())}</itunes:summary>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>false</itunes:explicit>
      <itunes:image href="${SITE_URL}/podcast-cover.jpg" />
      ${dur ? `<itunes:duration>${dur}</itunes:duration>` : ""}
      <enclosure url="${esc(r.audio.url)}" type="${esc(r.audio.type || "audio/mpeg")}"${r.audio.length ? ` length="${esc(r.audio.length)}"` : ""} />
    </item>`;
  }).join("\n");

  const lastBuild = playable[0] ? rfc822(playable[0].date) : new Date(0).toUTCString();
  const owner = OWNER_EMAIL
    ? `    <itunes:owner>\n      <itunes:name>${esc(AUTHOR)}</itunes:name>\n      <itunes:email>${esc(OWNER_EMAIL)}</itunes:email>\n    </itunes:owner>\n`
    : "";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(SITE_NAME)}</title>
    <link>${SITE_URL}/</link>
    <atom:link href="${SITE_URL}/podcast.xml" rel="self" type="application/rss+xml" />
    <language>sv-se</language>
    <description>${esc(DESC)}</description>
    <itunes:author>${esc(AUTHOR)}</itunes:author>
    <itunes:summary>${esc(DESC)}</itunes:summary>
    <itunes:type>episodic</itunes:type>
    <itunes:explicit>false</itunes:explicit>
    <itunes:image href="${SITE_URL}/podcast-cover.jpg" />
    <itunes:category text="${esc(CATEGORY)}" />
${owner}    <image>
      <url>${SITE_URL}/podcast-cover.jpg</url>
      <title>${esc(SITE_NAME)}</title>
      <link>${SITE_URL}/</link>
    </image>
    <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
  </channel>
</rss>
`;

  await writeFile(join(PUBLIC_DIR, "podcast.xml"), xml, "utf8");
  console.log(`Podd-RSS byggd: ${playable.length} spelbara avsnitt i podcast.xml (${skipped} utan ljud-enclosure utelamnade).`);
}

main().catch((err) => {
  console.error(`::error::build-podcast misslyckades: ${err?.stack || err}`);
  process.exit(1);
});
