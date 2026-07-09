// Manadsvis lank-halsokoll: lankar ruttnar med tiden (avsnitt flyttas/tas bort,
// hostar byter CDN). Gar igenom alla poster och:
//   1. audio.url (podd-flodets enclosure): dod -> forsok resolva om ur poddens
//      RSS; gar det inte -> ta bort audio (avsnittet utelamnas ur podcast.xml
//      i stallet for att ligga dott i en poddspelare).
//   2. listen_links.apple/web: doda lankar tas bort och Apple-lanken efter-fylls
//      via iTunes-uppslag/sok-deeplänk (ensureListenLinks). Spotify-lankarna ar
//      sok-deeplänkar och kan inte do.
// sources[] kollas MEDVETET inte: manga kall-sajter blockar datacenter-IP (bot-
// skydd) och doda kallor ar historiskt normala – de far sta kvar som referens.
// Kors av .github/workflows/link-health.yml (manadsvis) eller manuellt:
//   node scripts/link-health.mjs

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveEnclosure, ensureListenLinks } from "./generate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "..", "public", "data", "recommendations.json");
const TIMEOUT_MS = 15000;

// Nabar = 2xx/3xx (foljer redirects; Range-GET sa vi inte laddar hela ljudfiler).
async function reachable(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Range: "bytes=0-1",
        "user-agent": "DagensPodd/1.0 (+https://github.com/hhammarstrand/poddtipset)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.status < 400;
  } catch {
    return false;
  }
}

const data = JSON.parse(await readFile(DATA_FILE, "utf8"));
let audioFixed = 0, audioDropped = 0, linksFixed = 0, ok = 0;

for (const r of data) {
  let changed = false;

  // 1) Podd-flodets ljud-enclosure.
  if (r.audio?.url) {
    if (await reachable(r.audio.url)) {
      // frisk
    } else {
      const fresh = await resolveEnclosure(r.show_name, r.episode_title);
      if (fresh && (await reachable(fresh.url))) {
        r.audio = fresh;
        audioFixed++;
        changed = true;
        console.log(`🔧 ${r.date}  ljud-enclosure om-resolvad: ${r.show_name}`);
      } else {
        delete r.audio;
        audioDropped++;
        changed = true;
        console.log(`🗑  ${r.date}  ljud-enclosure dod och kunde inte resolvas om – avsnittet lamnar podd-flodet: ${r.show_name}`);
      }
    }
  }

  // 2) Lyssna-lankar (apple/web; spotify ar sok-deeplänk och kollas inte).
  const links = { ...(r.listen_links || {}) };
  for (const k of ["apple", "web"]) {
    if (links[k] && !(await reachable(links[k]))) {
      console.log(`🔗 ${r.date}  dod ${k}-lank tas bort: ${links[k].slice(0, 70)}`);
      delete links[k];
      changed = true;
    }
  }
  if (changed || !links.apple || !links.spotify) {
    const filled = await ensureListenLinks(links, r.show_name, r.episode_title);
    if (JSON.stringify(filled) !== JSON.stringify(r.listen_links)) {
      r.listen_links = filled;
      linksFixed++;
      changed = true;
    }
  }

  if (!changed) ok++;
}

await writeFile(DATA_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`\nLank-halsokoll klar: ${ok} friska · ${audioFixed} enclosures om-resolvade · ${audioDropped} enclosures borttagna · ${linksFixed} lyssna-lankar lagade (${data.length} poster).`);
