// Genererar den statiska delningsbilden public/og.png (1200×630) som visas nar
// sidan delas i sociala medier / chattar. Renderas en gang med Playwright/Chromium
// ur ett HTML-kort med sidans egna typsnitt och farger, och committas. Statisk och
// varumarkesbarande (inte per avsnitt) – darfor stabil och utan CI-beroende.
//
// Kor: node scripts/build-og.mjs   (kraver att playwright + chromium finns lokalt)

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const FONTS = join(PUBLIC_DIR, "fonts");

async function b64(file) {
  return (await readFile(file)).toString("base64");
}

async function main() {
  const fraunces = await b64(join(FONTS, "fraunces-latin-wght-normal.woff2"));
  const inter = await b64(join(FONTS, "inter-latin-wght-normal.woff2"));

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @font-face { font-family:"Fraunces"; font-weight:100 900; src:url(data:font/woff2;base64,${fraunces}) format("woff2"); }
    @font-face { font-family:"InterVar"; font-weight:100 900; src:url(data:font/woff2;base64,${inter}) format("woff2"); }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { width:1200px; height:630px; }
    .card {
      width:1200px; height:630px; position:relative; overflow:hidden;
      background:#f6f1e7; color:#1c1815;
      padding:84px 96px; display:flex; flex-direction:column; justify-content:space-between;
    }
    .top-bar { position:absolute; top:0; left:0; right:0; height:10px; background:#8c2f23; }
    .eyebrow { font-family:"InterVar"; font-size:26px; font-weight:600; letter-spacing:.32em; text-transform:uppercase; color:#8c2f23; }
    .title { font-family:"Fraunces"; font-weight:600; font-size:150px; line-height:.96; letter-spacing:-.02em; margin-top:18px; }
    .tagline { font-family:"Fraunces"; font-style:italic; font-size:50px; color:#4f463c; margin-top:30px; }
    .foot { display:flex; align-items:center; gap:22px; }
    .foot .url { font-family:"InterVar"; font-size:28px; letter-spacing:.04em; color:#8a7f70; }
    .badge { position:absolute; right:96px; top:120px; width:190px; height:190px; }
    .badge rect { fill:#8c2f23; }
    .badge g { stroke:#f6f1e7; }
  </style></head><body>
    <div class="card">
      <div class="top-bar"></div>
      <svg class="badge" viewBox="0 0 512 512">
        <rect width="512" height="512" rx="112"/>
        <g fill="none" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
          <rect x="206" y="118" width="100" height="170" rx="50"/>
          <path d="M150 250a106 106 0 0 0 212 0"/>
          <line x1="256" y1="356" x2="256" y2="408"/>
          <line x1="206" y1="408" x2="306" y2="408"/>
        </g>
      </svg>
      <div>
        <div class="eyebrow">Dagens tips</div>
        <div class="title">Dagens<br>Pod</div>
        <div class="tagline">Ett handplockat poddavsnitt om dagen.</div>
      </div>
      <div class="foot">
        <span class="url">Dokumenterat hyllat · källbelagt · varje dygn</span>
      </div>
    </div>
  </body></html>`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const el = await page.$(".card");
    await el.screenshot({ path: join(PUBLIC_DIR, "og.png") });
    console.log("Skrev public/og.png (1200×630).");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`::error::build-og misslyckades: ${err?.stack || err}`);
  process.exit(1);
});
