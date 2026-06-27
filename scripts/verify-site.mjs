// End-to-end-verifiering av den byggda sidan med Playwright/Chromium.
// Startar en lokal statisk server pa public/, laddar sidan i en riktig webblasare
// och kontrollerar bade design (rendering, vyer, morkt lage) och SEO/delning
// (title, meta, OG, JSON-LD, sitemap, robots, RSS, manifest). Tar ocksa skarmbilder.
//
// Kor: node scripts/verify-site.mjs   (kraver playwright + chromium)
// Exit 0 = allt gront, exit 1 = minst en kontroll foll.

import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const SHOT_DIR = join(__dirname, "..", "verify-shots");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };
const bad = (name, detail) => { fail++; console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ""}`); };
function check(name, cond, detail) { cond ? ok(name) : bad(name, detail); }

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/" || p.endsWith("/")) p += "index.html";
      const filePath = normalize(join(PUBLIC_DIR, p));
      if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
      res.end(body);
    } catch {
      try {
        const fallback = await readFile(join(PUBLIC_DIR, "404.html"));
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end(fallback);
      } catch { res.writeHead(404); res.end("not found"); }
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  const shots = [];
  try {
    const ctx = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // ── Startsida / Dagens ──────────────────────────────────────────────────
    console.log("\n[Dagens / startsida]");
    const resp = await ctx.goto(`${base}/`, { waitUntil: "networkidle" });
    check("HTTP 200", resp.status() === 200, `status ${resp.status()}`);
    const rawHtml = await resp.text();
    check("Forrenderad hero finns i RAA HTML (crawler ser innehall)", /class="hero prerendered"/.test(rawHtml));
    check("Forrenderad hero har riktig avsnittstitel", /<h2>[^<]{3,}<\/h2>/.test(rawHtml));

    await ctx.waitForSelector(".hero");
    check("Hero renderas i webblasaren", await ctx.$(".hero") != null);
    const heroTitle = (await ctx.textContent(".hero h2"))?.trim();
    check("Hero har en titel", !!heroTitle, heroTitle);
    check("<title> innehaller avsnittet", (await ctx.title()).includes(heroTitle || "###"));
    check("meta description ifylld", ((await ctx.getAttribute('meta[name="description"]', "content")) || "").length > 30);
    check("canonical satt", ((await ctx.getAttribute('link[rel="canonical"]', "href")) || "").startsWith("http"));
    check("og:image satt", ((await ctx.getAttribute('meta[property="og:image"]', "content")) || "").endsWith("og.png"));
    check("twitter:card = summary_large_image", (await ctx.getAttribute('meta[name="twitter:card"]', "content")) === "summary_large_image");
    check("RSS alternate-lank i <head>", await ctx.$('link[type="application/rss+xml"]') != null);

    // JSON-LD parsar och innehaller ratt typer.
    const ld = await ctx.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent));
    let types = [];
    try { types = (JSON.parse(ld[0])["@graph"] || []).map((n) => n["@type"]); } catch {}
    check("JSON-LD parsar", ld.length === 1 && types.length > 0, types.join(","));
    check("JSON-LD har WebSite", types.includes("WebSite"));
    check("JSON-LD har PodcastEpisode", types.includes("PodcastEpisode"));
    check('"Fler tips"-lista forrenderad', await ctx.$(".more-tips a") != null);

    await ctx.screenshot({ path: join(SHOT_DIR, "01-dagens-ljus.png"), fullPage: true });
    shots.push(join(SHOT_DIR, "01-dagens-ljus.png"));

    // ── Morkt lage ──────────────────────────────────────────────────────────
    console.log("\n[Morkt lage]");
    await ctx.click("#theme-toggle");
    await ctx.waitForTimeout(200);
    check("data-theme=dark efter klick", (await ctx.getAttribute("html", "data-theme")) === "dark");
    check("theme-color uppdaterad till mork", (await ctx.getAttribute('meta[name="theme-color"]', "content")) !== "#8c2f23");
    const savedTheme = await ctx.evaluate(() => localStorage.getItem("theme"));
    check("temat sparat i localStorage", savedTheme === "dark", savedTheme);
    await ctx.screenshot({ path: join(SHOT_DIR, "02-dagens-mork.png"), fullPage: true });
    shots.push(join(SHOT_DIR, "02-dagens-mork.png"));
    await ctx.click("#theme-toggle"); // tillbaka till ljust
    await ctx.waitForTimeout(150);
    check("tillbaka till ljust", (await ctx.getAttribute("html", "data-theme")) === "light");

    // ── Historik ────────────────────────────────────────────────────────────
    console.log("\n[Historik]");
    await ctx.goto(`${base}/#/historik`, { waitUntil: "networkidle" });
    await ctx.waitForSelector(".card-list .card");
    const cardCount = await ctx.$$eval(".card-list .card", (e) => e.length);
    check("Historik listar kort", cardCount > 0, `${cardCount} kort`);
    check("Titel = Historik", (await ctx.title()).startsWith("Historik"));
    // Sokfilter minskar listan.
    await ctx.fill("#f-search", "zzzznotreal");
    await ctx.waitForTimeout(300);
    const afterSearch = await ctx.$$eval(".card-list .card", (e) => e.length);
    check("Sokfilter funkar (0 traffar pa nonsens)", afterSearch === 0, `${afterSearch}`);
    await ctx.screenshot({ path: join(SHOT_DIR, "03-historik.png"), fullPage: true });
    // visa historiken igen utan filter for skarmbild
    await ctx.fill("#f-search", "");
    await ctx.waitForTimeout(250);

    // ── Detalj ──────────────────────────────────────────────────────────────
    console.log("\n[Avsnittsdetalj]");
    await ctx.click(".card-list .card");
    await ctx.waitForSelector(".hero");
    check("Detaljvy visar hero", await ctx.$(".hero") != null);
    check("Tillbaka-lank finns", await ctx.$("a.back") != null);

    // ── Statistik ───────────────────────────────────────────────────────────
    console.log("\n[Statistik]");
    await ctx.goto(`${base}/#/statistik`, { waitUntil: "networkidle" });
    await ctx.waitForSelector(".bar-row");
    check("Statistik renderar staplar", (await ctx.$$eval(".bar-row", (e) => e.length)) > 0);
    check("Statistik har totalsiffror", (await ctx.$$eval(".stat .num", (e) => e.length)) >= 3);
    await ctx.screenshot({ path: join(SHOT_DIR, "04-statistik.png"), fullPage: true });
    shots.push(join(SHOT_DIR, "04-statistik.png"));

    // ── Mobil-vy (skarmbild) ────────────────────────────────────────────────
    console.log("\n[Mobil]");
    const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await mob.goto(`${base}/`, { waitUntil: "networkidle" });
    await mob.waitForSelector(".hero");
    check("Mobil renderar hero", await mob.$(".hero") != null);
    await mob.screenshot({ path: join(SHOT_DIR, "05-mobil-dagens.png"), fullPage: true });
    shots.push(join(SHOT_DIR, "05-mobil-dagens.png"));
    await mob.close();

    // ── SEO-artefakter ────────────────────────────────────────────────────────
    console.log("\n[SEO-artefakter]");
    const get = async (path) => {
      const r = await ctx.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
      return { status: r.status(), body: await r.text(), ct: r.headers()["content-type"] || "" };
    };
    const robots = await get("/robots.txt");
    check("robots.txt 200 + Sitemap-rad", robots.status === 200 && /Sitemap:\s*http/.test(robots.body));
    const sitemap = await get("/sitemap.xml");
    check("sitemap.xml giltig", sitemap.status === 200 && /<urlset/.test(sitemap.body) && /<loc>http/.test(sitemap.body));
    const feed = await get("/feed.xml");
    check("feed.xml RSS giltig + har items", feed.status === 200 && /<rss/.test(feed.body) && /<item>/.test(feed.body));
    const manifest = await get("/manifest.webmanifest");
    let mok = false; try { mok = !!JSON.parse(manifest.body).name; } catch {}
    check("manifest.webmanifest parsar", manifest.status === 200 && mok);

    // ── Podd-RSS ──────────────────────────────────────────────────────────────
    console.log("\n[Podd-RSS]");
    const pod = await get("/podcast.xml");
    const podItems = (pod.body.match(/<item>/g) || []).length;
    const podEnc = (pod.body.match(/<enclosure\b/g) || []).length;
    check("podcast.xml serveras + itunes-namespace", pod.status === 200 && /xmlns:itunes=/.test(pod.body));
    check("podcast.xml har itunes:image + kategori", /<itunes:image\b/.test(pod.body) && /<itunes:category\b/.test(pod.body));
    check("podcast.xml har items med enclosure", podItems > 0 && podEnc === podItems, `${podItems} items, ${podEnc} enclosures`);
    check("podcast.xml lacker inte privat gmail", !/hhammarstrand@gmail\.com/i.test(pod.body));
    // Omslaget nabart (samma origin, hamtas i Node).
    let coverStatus = 0; try { coverStatus = (await fetch(`${base}/podcast-cover.png`)).status; } catch {}
    check("podcast-cover.png serveras (1500×1500)", coverStatus === 200, `status ${coverStatus}`);
    // Forsta enclosure-ljudet ska faktiskt vara nabart (extern URL – hamtas i Node, ingen CORS).
    const firstEnc = (pod.body.match(/<enclosure[^>]*url=["']([^"']+)["']/i) || [])[1];
    if (firstEnc) {
      let encStatus = 0;
      try {
        const r = await fetch(firstEnc, { method: "GET", headers: { Range: "bytes=0-1" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
        encStatus = r.status;
      } catch (e) { encStatus = String(e?.message || e); }
      check("forsta enclosure-ljudet ar nabart (riktig lank)", encStatus === 200 || encStatus === 206, `status ${encStatus} (${firstEnc.slice(0, 50)})`);
    } else {
      bad("ingen enclosure-URL att kontrollera");
    }
    check("podd-flode lankat i <head>", /href="[^"]*podcast\.xml"/.test(rawHtml));
    const og = await ctx.goto(`${base}/og.png`, { waitUntil: "domcontentloaded" });
    check("og.png serveras", og.status() === 200);
    const r404 = await ctx.goto(`${base}/finns-inte-xyz`, { waitUntil: "domcontentloaded" });
    check("404-fallback laddar SPA-skal", (await r404.text()).includes('id="app"'));

    // ── Konsolfel ────────────────────────────────────────────────────────────
    console.log("\n[Konsol]");
    const errs = [];
    ctx.on("pageerror", (e) => errs.push(e.message));
    ctx.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
    await ctx.goto(`${base}/`, { waitUntil: "networkidle" });
    await ctx.waitForTimeout(300);
    check("Inga JS-konsolfel pa startsidan", errs.length === 0, errs.join(" | "));
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${"─".repeat(48)}\nRESULTAT: ${pass} grona, ${fail} roda.`);
  if (shots.length) console.log("Skarmbilder: " + shots.map((s) => s.replace(join(__dirname, ".."), ".")).join(", "));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(`::error::verify-site kraschade: ${err?.stack || err}`);
  process.exit(1);
});
