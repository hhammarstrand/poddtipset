// Engangs-/underhallsskript: ser till att ALLA befintliga tips i datafilen har
// minst en Apple- och en Spotify-lank, med samma deterministiska logik som
// dygnsgenereringen (iTunes Search API + sok-deeplänk). Kors lokalt eller i CI:
//   node scripts/enrich-links.mjs
// Andrar bara poster som saknar nagon av lankarna; ror inte ovrigt innehall.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureListenLinks } from "./generate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "..", "public", "data", "recommendations.json");

const data = JSON.parse(await readFile(DATA_FILE, "utf8"));
let changed = 0;
for (const r of data) {
  const before = JSON.stringify(r.listen_links || {});
  r.listen_links = await ensureListenLinks(r.listen_links, r.show_name, r.episode_title);
  const after = JSON.stringify(r.listen_links);
  if (after !== before) changed++;
  console.log(`${r.date}  apple:${r.listen_links.apple ? "✓" : "✗"}  spotify:${r.listen_links.spotify ? "✓" : "✗"}  ${r.show_name}`);
}
await writeFile(DATA_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`\nUppdaterade ${changed} av ${data.length} poster.`);
