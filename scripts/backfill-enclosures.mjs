// Engangs-/underhallsskript: fyller i fältet "audio" (ljud-enclosure ur poddens
// egna RSS) for poster som saknar det. Kors lokalt. Idempotent – hoppar over
// poster som redan har audio. Anvands for att efter-fylla aldre poster sa de kan
// ingar i podd-RSS:en (nya poster far audio direkt vid genereringen).

import { readFile, writeFile } from "node:fs/promises";
import { resolveEnclosure } from "./generate.mjs";

const FILE = new URL("../public/data/recommendations.json", import.meta.url);
const data = JSON.parse(await readFile(FILE, "utf8"));

let added = 0, missing = 0;
for (const r of data) {
  if (r.audio && r.audio.url) continue;
  const audio = await resolveEnclosure(r.show_name, r.episode_title);
  if (audio) {
    r.audio = audio;
    added++;
    console.log(`✅ ${r.date}  ${r.show_name} — enclosure: ${audio.url.slice(0, 70)}`);
  } else {
    missing++;
    console.log(`❌ ${r.date}  ${r.show_name} — ingen enclosure i poddens RSS (utelamnas ur podd-RSS)`);
  }
}

await writeFile(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`\nKlart: ${added} fick enclosure, ${missing} saknar. ${data.length} poster totalt.`);
