// Dagens Pod – dygnsgenerering for GitHub Actions.
// Kors en gang per dygn: gor varierade webbsokningar mot MiniMax server-sidiga
// sok-endpoint (/v1/coding_plan/search) och matar in traffarna i ETT anrop till
// en MiniMax-chattmodell som valjer ETT dokumenterat hyllat avsnitt. Resultatet
// valideras/kallbelaggs och laggs till i den statiska datafilen som GitHub Pages
// serverar. Inget agentiskt verktygs-loop (token-snalt); sokningarna gors
// deterministiskt i koden.
//
// Bade sokningen och modellen kors pa MiniMax infrastruktur – ingen self-hostad
// sokmotor och ingen datacenter-IP som blockas av sokmotorerna (det var det som
// fick den gamla SearXNG-losningen att ge tomma dagar).
//
// Kraver Node 20+ (global fetch, AbortSignal.timeout). Inga npm-beroenden.
// Las MINIMAX_API_KEY fran miljon (GitHub Actions secret).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// KONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const LANGUAGES = ["sv", "en"];
const GENRES = "all"; // "all" eller t.ex. ["history", "true crime"]
// MiniMax-chattmodell. Alternativ: "MiniMax-M3", "MiniMax-M2.5", "MiniMax-M2.1".
const MODEL = process.env.MINIMAX_MODEL || "MiniMax-M2.7";
const DEDUP_COUNT = 60;          // avsnitts-dedup (skickas till modellen)
const MAX_ATTEMPTS = 12;         // forsok per dag (sveper bredare sa fler dagar blir kompletta)
const SEED_RESULTS_PER_QUERY = 8; // traffar per sokning som skickas till modellen
const SNIPPET_LEN = 320;         // max tecken per snippet (langre = fler poddnamn overlever i korpus -> farre falska "podd saknas i resultaten"-underkanningar)
const THEME_HOOKS = 8;           // antal "on this day"-krokar som skickas med
const MAX_TOKENS = 8000;         // tak for modellens svar (rymligt sa MiniMax interleaved thinking + JSON ryms)
const TEMPERATURE = 0.4;         // lagt for att minska pahitt/konfabulering i fakta
const SHOW_HARD_DAYS = 7;        // samma podd far INTE aterkomma inom sa har manga dagar
const SHOW_SOFT_COUNT = 30;      // poddar att be modellen undvika (mjukt)
const WHY_LANG = "sv";
const SOURCE_FETCH_TIMEOUT_MS = 8000;
const SEARCH_TIMEOUT_MS = 20000;
const MINIMAX_TIMEOUT_MS = 180000;
const WIKI_TIMEOUT_MS = 12000;
const LOW_HIT_THRESHOLD = 5;     // under detta antal traffar racker det inte for ett robust forsok
// Sprak for "On this day"-flodet (Wikipedia), i prioritetsordning. Forsta som svarar anvands/merges.
const ONTHISDAY_WIKIS = ["sv", "en"];

// Guardrails (validering)
// Titel-monster som indikerar att avsnittet INTE ar fristaende (uppfoljare/serie/del/finale).
const NON_STANDALONE_RE =
  /\bupdate\b|update:|\buppdatering\b|\bpart\s+(one|two|three|four|five|1|2|3|4|5)\b|\bpt\.?\s*\d+\b|\bdel\s+(en|tva|två|tre|fyra|fem|\d+)\b|\bkapitel\s*\d+\b|\bchapter\s*\d+\b|\bepisode\s*\d+\b|\bavsnitt\s*\d+\b|\bseason\s+(one|two|three|four|five|\d+)\b|\bsäsong\s+(ett|två|tre|fyra|fem|\d+)\b|\b\d+\s*\/\s*\d+\b|\bfinale\b|\bconclusion\b|\bcontinued\b|\bforts\.?\b|\bfortsättning\b|\bprolog|\bepilog/i;
// Icke-latinska tecken (CJK/japanska/koreanska) i textfalt = modellen har bytt sprak
// mitt i (MiniMax-quirk). Sant ar aldrig korrekt for svensk/engelsk text och underkanns.
const NON_LATIN_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
// Sociala/video-lankar belagger INTE att ett avsnitt ar hyllat – kraver minst en riktig kalla.
const SOCIAL_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|fb\.com|twitter\.com|x\.com|threads\.net|pinterest\.com)$/i;
// Citat far inte forekomma i why_great – vi kan inte garantera att de stammer, sa de forbjuds helt.
const QUOTE_RE = /["“”«»]|'[^']*\s[^']*'/;
// Spekulation/gissning – why_great far INTE gissa om avsnittets innehall (t.ex. utifran
// titeln). Sant later osakert och ar inte tidnings-/nyhetsbrevskvalitet.
const SPECULATION_RE =
  /\bkanske\b|\bantyder\b|\bantagligen\b|\bförmodligen\b|\btroligen\b|\bsannolikt\b|\bgissningsvis\b|\blär\s+vara\b|\bverkar\s+(vara|handla)\b|\btycks\b|titeln\s+(antyder|avslöjar|skvallrar|tyder)|man\s+kan\s+anta|\bpresumably\b|\bprobably\b|\blikely\b|\bmight\s+be\b|\bmay\s+be\b|\bcould\s+be\b|seems?\s+to\b|appears?\s+to\b|the\s+title\s+suggests/i;
// Erkannanden i texten om att avsnittet ar del av en serie/sasong (titeln rojer det inte alltid).
const SERIES_ADMISSION_RE =
  /\b(den\s+)?första\s+(delen|avsnittet|episoden)\b|\bförsta\s+delen\s+i\b|\bdel\s*(1|ett)\b|\bfirst\s+(part|episode|installment)\b|\bpart\s+one\b|\bseason\s+(opener|premiere)\b|\bseries\s+opener\b|\bpremiär(avsnitt|avsnittet)\b|\bopening\s+episode\b|\b(två|tre|fyra|fem|sex|sju|åtta|fler)delad\b|\b(multi-?part|two-?part|three-?part)\b|\bdel\s+av\s+en\s+(serie|flerdelad\s+serie)\b|\bfirst\s+in\s+a\s+(series|season)\b|\bden\s+första\s+i\s+en\b|\bkicks?\s+off\s+(the\s+)?(season|series)\b/i;

// MiniMax-endpoints (server-side sok + OpenAI-kompatibel chat). Byt MINIMAX_BASE_URL
// till t.ex. https://api.minimaxi.com om nyckeln tillhor en annan region.
const MINIMAX_BASE = (process.env.MINIMAX_BASE_URL || "https://api.minimax.io").replace(/\/$/, "");
const MINIMAX_CHAT_URL = MINIMAX_BASE + "/v1/chat/completions";
const MINIMAX_SEARCH_URL = MINIMAX_BASE + "/v1/coding_plan/search";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "..", "public", "data", "recommendations.json");

// ─────────────────────────────────────────────────────────────────────────────
// Hjalpare
// ─────────────────────────────────────────────────────────────────────────────
function slugify(input) {
  return String(input)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeTitle(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function todayStockholm(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

async function readData() {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeData(list) {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(list, null, 2) + "\n", "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// MiniMax server-side web_search (/v1/coding_plan/search)
// ─────────────────────────────────────────────────────────────────────────────
// Allt vi faktiskt sett i sokresultat denna korning. Anvands for att garantera att
// modellen bara far kallbelagga med URL:er/poddar som verkligen dök upp – inte pahitt.
const SEEN = [];

function normUrl(u) {
  try {
    const x = new URL(u);
    return (x.host + x.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(u).trim().toLowerCase();
  }
}

function collapse(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

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
    return url;
  }
}

// En sokning mot MiniMax /v1/coding_plan/search. Svaret har formen
// { organic: [{title, link, snippet, date}], related_searches: [...], base_resp: {...} }.
async function minimaxSearch(apiKey, query) {
  try {
    const res = await fetch(MINIMAX_SEARCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ q: query }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) return { query, error: `MiniMax search ${res.status}`, results: [] };
    const data = await res.json();
    if (data?.base_resp && data.base_resp.status_code !== 0) {
      return { query, error: `MiniMax search ${data.base_resp.status_code}: ${data.base_resp.status_msg}`, results: [] };
    }
    const results = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, SEED_RESULTS_PER_QUERY)
      .map((r) => ({
        title: typeof r.title === "string" ? r.title.slice(0, 140) : "",
        url: typeof r.link === "string" ? r.link : "",
        snippet: typeof r.snippet === "string" ? r.snippet.slice(0, SNIPPET_LEN) : "",
      }))
      .filter((r) => /^https?:\/\//i.test(r.url));
    for (const r of results) SEEN.push(r);
    return { query, results };
  } catch (err) {
    return { query, error: err instanceof Error ? err.message : String(err), results: [] };
  }
}

// Bred, varierad pool av sokvinklar (genre/sprak/kalla). Vi roterar urvalet per DAG
// sa att olika poddar dyker upp olika dagar – inte samma "basta genom tiderna" varje dag.
const QUERY_POOL = [
  "best true crime podcast episode of all time",
  "basta svenska poddavsnitt genom tiderna",
  "best comedy podcast episode acclaimed",
  "p3 dokumentar basta avsnitt",
  "best history podcast episode award winning",
  "hyllat svenskt poddavsnitt reddit",
  "best science podcast episode reddit",
  "basta svenska podcast avsnitt lista",
  "best storytelling podcast episode ever",
  "p1 dokumentar basta avsnitt",
  "best investigative journalism podcast episode",
  "basta poddavsnitt samhalle svenska",
  "best interview podcast episode of all time",
  "best sports podcast episode acclaimed",
  "best music podcast episode reddit",
  "peabody award winning podcast episode",
  "podchaser highest rated podcast episodes",
  "most moving podcast episode of all time",
];

function dayIndex(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}

// En sokfras byggd ur dagens "on this day"-krok, sa urvalet styrs mot dagens amne.
function themeQuery(hooks, date, attempt) {
  if (!hooks.length) return null;
  const h = hooks[(dayIndex(date) + attempt - 1) % hooks.length];
  const subj = h.text
    .replace(/\(.*?\)/g, " ")
    .split(/[.,;:–-]/)[0]
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .trim();
  return subj.length >= 4 ? `podcast episode about ${subj}` : null;
}

// 4 spridda vinklar ur poolen (roterar per dag + forsok sa attempten sveper hela
// poolen) + ev. en tema-sokning. Fler vinklar = storre chans till en giltig,
// icke-nyligen-anvand podd, sa fler dagar blir kompletta.
function buildQueries(date, attempt, hooks) {
  const n = QUERY_POOL.length;
  const base = dayIndex(date) + (attempt - 1) * 4;
  const qs = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4)].map((o) => QUERY_POOL[(base + o) % n]);
  const tq = themeQuery(hooks, date, attempt);
  if (tq) qs.push(tq);
  return [...new Set(qs)];
}

async function gatherResults(apiKey, queries) {
  return Promise.all(queries.map((q) => minimaxSearch(apiKey, q)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatSearchResults(searches) {
  const blocks = [];
  for (const s of searches) {
    if (s.error) {
      blocks.push(`Sokning "${s.query}": (fel: ${s.error})`);
      continue;
    }
    if (!s.results.length) {
      blocks.push(`Sokning "${s.query}": (inga traffar)`);
      continue;
    }
    const lines = s.results.map((r) => `- ${r.title}\n  URL: ${r.url}\n  ${r.snippet}`).join("\n");
    blocks.push(`Sokning "${s.query}":\n${lines}`);
  }
  return blocks.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// "On this day" – dagens historiska krokar fran Wikipedia (gratis, nyckellost)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchOnThisDayForWiki(wiki, mm, dd) {
  const url = `https://${wiki}.wikipedia.org/api/rest_v1/feed/onthisday/all/${mm}/${dd}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "DagensPod/1.0 (+https://github.com/hhammarstrand/poddtipset)" },
    signal: AbortSignal.timeout(WIKI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`onthisday ${wiki} ${res.status}`);
  const data = await res.json();
  const hooks = [];
  const take = (arr, kind, n) => {
    for (const it of (Array.isArray(arr) ? arr : []).slice(0, n)) {
      const text = typeof it.text === "string" ? it.text.replace(/\s+/g, " ").trim() : "";
      if (!text) continue;
      hooks.push({ kind, year: typeof it.year === "number" ? it.year : null, text });
    }
  };
  take(data.selected, "handelse", 8);
  take(data.events, "handelse", 5);
  take(data.births, "fodd", 3);
  return hooks;
}

// Hamtar dagens krokar fran konfigurerade wikis och slar ihop dem (dedup pa text).
async function fetchOnThisDay(date) {
  const [, mm, dd] = String(date).split("-");
  if (!mm || !dd) return [];
  const all = [];
  for (const wiki of ONTHISDAY_WIKIS) {
    try {
      const hooks = await fetchOnThisDayForWiki(wiki, mm, dd);
      all.push(...hooks);
    } catch (err) {
      console.log(`On this day (${wiki}) misslyckades: ${err instanceof Error ? err.message : err}`);
    }
  }
  const seen = new Set();
  const uniq = [];
  for (const h of all) {
    const k = collapse(h.text).slice(0, 80);
    if (k && !seen.has(k)) { seen.add(k); uniq.push(h); }
  }
  return uniq.slice(0, 16);
}

function formatThemeBlock(hooks, mm, dd) {
  if (!hooks.length) return "";
  const lines = hooks.slice(0, THEME_HOOKS).map((h) => {
    const y = h.year != null ? `${h.year}` : "okant ar";
    const label = h.kind === "fodd" ? "Fodd" : "Handelse";
    return `- [${label}, ${y}] ${h.text}`;
  });
  return `DAGENS DATUM (${dd}/${mm}) – sa har knyter dagen an i historien (Wikipedia "On this day"):\n${lines.join("\n")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MiniMax chat/completions (OpenAI-kompatibelt) – ETT anrop per forsok (ingen
// agentisk tool-loop). Sokningarna gors deterministiskt i koden och matas in en
// gang, vilket kapar token-forbrukningen drastiskt.
// ─────────────────────────────────────────────────────────────────────────────
async function askModel(apiKey, systemMsg, userMsg) {
  const res = await fetch(MINIMAX_CHAT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userMsg },
      ],
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(MINIMAX_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MiniMax API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("MiniMax-svaret saknade text-innehall.");
  return content;
}

// Plocka ut det sista balanserade JSON-objektet ur en textstrang.
function extractJsonObject(text) {
  // Ta bort modellens resonemang (<think>-block) sa det inte stor JSON-extraktionen.
  const t = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, " ");
  const trimmed = t.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  let depth = 0, start = -1, inString = false, escape = false;
  const candidates = [];
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { if (inString) escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) { candidates.push(t.slice(start, i + 1)); start = -1; }
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryParse(candidates[i]);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt + validering
// ─────────────────────────────────────────────────────────────────────────────
function systemPrompt() {
  const langNames = LANGUAGES.map((l) => (l === "sv" ? "svenska" : l === "en" ? "engelska" : l)).join(" eller ");
  const genreLine = GENRES === "all" ? "Alla genrer ar tillatna." : `Prioritera dessa genrer: ${GENRES.join(", ")}.`;
  return `Du ar en mycket paläst poddredaktor som valjer ut ETT enastaende poddavsnitt som "dagens tips". Tonen och omdomet ska halla samma niva som en redaktionell rekommendation i en kvalitetstidning eller ett valkurerat nyhetsbrev.

Du far en uppsattning sokresultat (titlar, URL:er, utdrag). Du kan INTE soka sjalv – valj ENBART utifran det som star i sokresultaten.

ABSOLUTA REGLER MOT PAHITT (overordnade allt annat):
- Pasta ENDAST saker du kan stodja pa de medskickade sokresultaten. Hitta aldrig pa avsnitt, poddar, vardar, artal, langd, priser eller placeringar.
- INGA CITAT nagonstans i texten. Anvand aldrig citationstecken och tillskriv aldrig en namngiven person ett yttrande. Skriv om i stallet: i stallet for: hon kallade det "ett mastervaerk" -> skriv: det har hyllats som ett mastervaerk. Inga " ' « » far forekomma i why_great eller day_connection.
- Ar du osaker pa ett falt (artal/langd) – satt det till null i stallet for att gissa.
- Poddens namn maste finnas i dina sokresultat. Annars valj en annan podd.
- SPRAK/TECKEN: skriv HELA svaret (alla falt) enbart med latinska bokstaver pa svenska eller engelska. Anvand ALDRIG japanska, kinesiska, koreanska eller andra icke-latinska tecken nagonstans – inte ens i enstaka ord.
- GISSA ALDRIG vad avsnittet handlar om utifran titeln. Skriv bara om avsnittets innehall om sokresultaten FAKTISKT beskriver just det avsnittet (vad det handlar om, vem som medverkar, varfor det hyllas). Anvand aldrig ord som "kanske", "antyder", "titeln antyder", "troligen", "verkar" – sant avslojar att du gissar. Om sokresultaten bara namnger podden men inte beskriver det enskilda avsnittet: valj ett ANNAT avsnitt som verkligen beskrivs i resultaten.
- Anvand poddens namn EXAKT som det skrivs i sokresultaten (t.ex. inte "An Infinite Monkey Cage" om resultaten sager "The Infinite Monkey Cage").

KRAV PA AVSNITTET:
- Dokumenterat hyllat: aterkommer pa "basta avsnitt"-listor, hogt rankat pa Podchaser/Reddit, prisbelont, eller mycket delat/citerat. Valj det avsnitt i sokresultaten som har STARKAST belagg for att vara hyllat – inte bara nagot som rakar namnas.
- Sprak: ${langNames}. Vaxla garna sprak och genre fran dag till dag for variation.
- ${genreLine}

EPISODE_TITLE MASTE VARA ETT SPECIFIKT AVSNITT:
- "episode_title" ar titeln pa det enskilda avsnittet, INTE namnet pa podden. Det ska sakta vad just detta avsnitt handlar om (t.ex. gasten, fallet, amnet).
- Skriv ALDRIG samma sak i "episode_title" som i "show_name", och anvand inte poddens slogan/undertitel som avsnittstitel. Om sokresultaten bara ger poddens namn men inget specifikt avsnitt – valj ett annat avsnitt dar avsnittstiteln framgar.

VARIERA POODARNA:
- Du far en lista pa nyligen anvanda poddar. Valj helst en podd som INTE star pa listan – undvik att samma podd aterkommer ofta.

FRISTAENDE AVSNITT (viktigt):
- Avsnittet MASTE vara fristaende och fungera som en ingang i sig sjalvt – det ska ga att lyssna pa utan att ha hort nagot annat avsnitt.
- Valj ALDRIG ett uppfoljnings- eller serie-avsnitt: inget "Part 2", "Del 3", "Chapter/Kapitel N", numrerat avsnitt, "Update:", finale, "fortsattning" eller nagot som bygger vidare pa en tidigare del. Om titeln eller innehallet forutsatter ett tidigare avsnitt – valj nagot annat.
- OBS: aven det FORSTA avsnittet i en flerdelad serie/sasong (ett "premiar-" eller "season opener"-avsnitt) raknas som serie-avsnitt och ar INTE fristaende, aven om titeln saknar siffra. Valj bara avsnitt som ar en komplett historia i sig sjalva.
- Satt faltet "standalone" till true bara om detta verkligen galler.

KOPPLING TILL DAGENS DATUM (valfritt – nastan alltid tomt):
- Lat INTE dagens datum styra vilket avsnitt du valjer. Valj alltid det basta hyllade avsnittet forst. Kopplingen ar bara en bonus i de sallsynta fall den ar uppenbar.
- Fyll BARA i en koppling om avsnittet DIREKT handlar om exakt samma sak som star i dagens lista: samma namngivna person, samma specifika handelse, samma plats. Avsnittet ska kunna sammanfattas som "ett avsnitt OM [det som hande/foddes denna dag]".
- En vag tematisk likhet RACKER INTE och ar forbjuden. FORBJUDNA (krystade) exempel: ett avsnitt om farger kopplat till att en konstnar foddes idag; ett avsnitt om ett mord kopplat till att en annan person dog idag; "handlar ocksa om en man" / "ocksa pa 1970-talet". Sant ska lamnas TOMT.
- OK exempel (direkt): listan sager "Sigvard Bernadotte foddes 1907" OCH avsnittet handlar om Sigvard Bernadotte.
- I de allra flesta fall finns INGEN sadan direkt koppling. Da lamnar du bade "day_occasion" och "day_connection" som tom strang "". Det ar det normala och helt ratt – en tom koppling ar alltid battre an en krystad.

KALLOR (viktigt):
- Du MASTE ange minst en kall-URL i "sources", och varje sadan URL MASTE vara en URL som ORDAGRANT forekom i de medskickade sokresultaten. Hitta ALDRIG pa en URL och andra den inte. Valj en kalla som verkligen belagger hyllningen (lista, artikel, prismotivering, Podchaser-sida, upproostad Reddit-trad).

LYSSNA-LANKAR:
- Ange bara listen_links (apple/spotify/web) som du faktiskt sett i sokresultaten. Hitta ALDRIG pa en Spotify-/Apple-URL eller ett avsnitts-ID. Ar du osaker – utelamna lanken (lat den vara borta) i stallet for att gissa.

SKRIV "DARFOR AR DET BRA"-TEXTEN SOM EN MANNISKA:
- ${WHY_LANG === "sv" ? "Skriv pa svenska." : "Skriv pa engelska."}
- 2-4 meningar, konkret och specifik om just detta avsnitt (vad hander, vem medverkar, vad gor det minnesvart) – men bara sant som stods av kallorna.
- Skriv som en redaktor som faktiskt lyssnat: borja inte alla meningar likadant, vaxla meningslangd, var konkret om innehallet i stallet for svepande.
- Inga floskler, inga AI-klichéer ("dyk ner i", "en fascinerande resa", "vare sig du ar...", "maste-lyssning"). Inga citat. Lat det lata som en kunnig redaktor, inte en generator.

SVARSFORMAT:
Svara med ENBART JSON-objektet – inget resonemang, ingen forklarande text, inga <think>-taggar, inga markdown-staket. ETT rent JSON-objekt med exakt dessa falt:
{
  "episode_title": string,
  "show_name": string,
  "hosts": string,
  "genre": string,
  "language": string,              // "${LANGUAGES.join('" eller "')}"
  "year": number | null,
  "duration_minutes": number | null,
  "standalone": boolean,           // true endast om avsnittet ar fristaende (inte serie/uppfoljare)
  "day_occasion": string,          // vad som hande/foddes denna dag (ur listan), annars ""
  "day_connection": string,        // kort mening om hur avsnittet knyter an till det, annars ""
  "why_great": string,
  "listen_links": { "apple": string?, "spotify": string?, "web": string? },
  "sources": [ { "title": string, "url": string } ]
}`;
}

function userPrompt(dedupList, avoidShows, searchBlock, themeBlock, lastError) {
  const dedup = dedupList.length ? dedupList.map((d) => `- ${d}`).join("\n") : "(historiken ar tom)";
  const avoid = avoidShows.length ? avoidShows.map((s) => `- ${s}`).join("\n") : "(inga an)";
  const retry = lastError
    ? `\n\nFOREGAENDE FORSOK UNDERKANDES: ${lastError}\nValj ett ANNAT avsnitt (garna en annan podd) som uppfyller alla krav.\n`
    : "";
  return `Valj ETT poddavsnitt enligt instruktionerna, enbart utifran sokresultaten nedan.

Det far INTE vara nagot av dessa redan rekommenderade avsnitt:
${dedup}

UNDVIK HELST dessa nyligen anvanda poddar (valj en annan podd om mojligt):
${avoid}

${themeBlock || "(ingen dagskoppling tillganglig – valj fritt bland hyllade avsnitt)"}

SOKRESULTAT ATT UTGA FRAN (detta ar allt du har – du kan inte soka mer):
${searchBlock || "(inga sokresultat – avsta hellre an att hitta pa)"}${retry}`;
}

function validateTip(raw, recentKeys, seen, hardShowSlugs = new Set()) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Kunde inte tolka nagot JSON-objekt ur svaret." };
  const str = (v) => (typeof v === "string" ? v.trim() : "");

  const episode_title = str(raw.episode_title);
  const show_name = str(raw.show_name);
  const hosts = str(raw.hosts);
  const genre = str(raw.genre);
  const language = str(raw.language).toLowerCase();
  const why_great = str(raw.why_great);

  const missing = [];
  if (!episode_title) missing.push("episode_title");
  if (!show_name) missing.push("show_name");
  if (!genre) missing.push("genre");
  if (!language) missing.push("language");
  if (!why_great) missing.push("why_great");
  if (missing.length) return { ok: false, error: `Saknade/tomma falt: ${missing.join(", ")}.` };

  if (!LANGUAGES.includes(language)) {
    return { ok: false, error: `language "${language}" ar inte tillatet (tillatna: ${LANGUAGES.join(", ")}).` };
  }

  // Guardrail: inga icke-latinska tecken nagonstans (modellen far inte byta sprak mitt i).
  if (NON_LATIN_RE.test(`${episode_title} ${show_name} ${hosts} ${genre} ${why_great} ${str(raw.day_connection)} ${str(raw.day_occasion)}`)) {
    return { ok: false, error: "Svaret innehaller icke-latinska tecken (modellen bytte sprak) – skriv om pa svenska/engelska." };
  }

  // Guardrail: fristaende avsnitt – inga uppfoljare/serie/del/finale.
  if (raw.standalone !== true) {
    return { ok: false, error: "Modellen bekraftade inte att avsnittet ar fristaende (standalone=true kravs)." };
  }
  if (NON_STANDALONE_RE.test(episode_title)) {
    return { ok: false, error: `Avsnittet ser ut att vara en uppfoljare/del/serie utifran titeln: "${episode_title}".` };
  }

  // Guardrail: episode_title maste vara ett specifikt avsnitt – inte poddens namn/slogan.
  const epC = collapse(episode_title);
  const showCheck = collapse(show_name);
  if (epC && showCheck && (epC === showCheck || epC.startsWith(showCheck + " with ") || epC.startsWith(showCheck + " med "))) {
    return { ok: false, error: `episode_title "${episode_title}" ar poddens namn, inte ett specifikt avsnitt.` };
  }

  // Guardrail: inga citat i why_great (kan inte garanteras stamma).
  if (QUOTE_RE.test(why_great)) {
    return { ok: false, error: "why_great far inte innehalla citat eller citationstecken." };
  }

  // Guardrail: ingen spekulation/gissning i why_great. Om modellen gissar avsnittets
  // innehall (t.ex. "titeln antyder", "kanske") sa har den inte riktig info om avsnittet.
  if (SPECULATION_RE.test(why_great)) {
    return { ok: false, error: "why_great spekulerar/gissar om avsnittet (t.ex. 'kanske'/'titeln antyder') – valj ett avsnitt vars innehall faktiskt beskrivs i sokresultaten." };
  }

  // Dagskoppling ar valfri (stark preferens, inte tvang). Inga citat; kort.
  let day_connection = str(raw.day_connection);
  if (day_connection && QUOTE_RE.test(day_connection)) {
    return { ok: false, error: "day_connection far inte innehalla citat eller citationstecken." };
  }
  if (day_connection.length > 240) {
    // Trimma vid ordgrans (inte mitt i ett ord) och avsluta snyggt.
    day_connection = day_connection.slice(0, 240).replace(/\s+\S*$/, "").trim() + "…";
  }

  // Vad som hande denna dag (visas ovanfor kopplingen). Tom om ingen koppling.
  let day_occasion = str(raw.day_occasion);
  if (day_occasion && QUOTE_RE.test(day_occasion)) {
    return { ok: false, error: "day_occasion far inte innehalla citat eller citationstecken." };
  }
  if (day_occasion.length > 160) day_occasion = day_occasion.slice(0, 160).trim();
  if (!day_connection) day_occasion = "";

  // Guardrail: fanga serie-/sasongsavsnitt som titeln inte rojer men texten erkanner
  // (t.ex. "den forsta delen i ...", "season opener"). Skyddar fristaende-kravet.
  if (SERIES_ADMISSION_RE.test(`${episode_title} ${why_great} ${day_connection}`)) {
    return { ok: false, error: "Texten antyder att avsnittet ar del av en serie/sasong (inte fristaende)." };
  }

  // Guardrail: kallor maste komma ur sokresultat vi faktiskt sett (inga pahittade URL:er).
  const seenList = Array.isArray(seen) ? seen : [];
  const seenUrls = new Set(seenList.map((r) => normUrl(r.url)));
  const corpus = collapse(seenList.map((r) => `${r.title} ${r.snippet}`).join(" "));

  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .map((s) => ({ title: str(s?.title) || "Kalla", url: str(s?.url) }))
        .filter((s) => /^https?:\/\//i.test(s.url) && seenUrls.has(normUrl(s.url)))
    : [];
  if (!sources.length) {
    return { ok: false, error: "Ingen kall-URL kom fran sokresultaten (modellen maste citera en URL den faktiskt sokte fram)." };
  }

  // Guardrail: minst en kalla maste vara en riktig sida (inte bara YouTube/Instagram/TikTok).
  // En social/video-lank belagger inte att avsnittet ar dokumenterat hyllat.
  const hasRealSource = sources.some((s) => {
    try { return !SOCIAL_HOST_RE.test(new URL(s.url).hostname); } catch { return false; }
  });
  if (!hasRealSource) {
    return { ok: false, error: "Endast sociala/video-lankar som kalla – kraver minst en riktig kalla (lista/artikel/pris/Podchaser) som belagger hyllningen." };
  }

  // Guardrail: poddens namn maste forekomma i sokresultaten (poddar far inte hittas pa).
  const showC = collapse(show_name);
  if (corpus && showC && !corpus.includes(showC)) {
    return { ok: false, error: `show_name "${show_name}" forekom inte i sokresultaten.` };
  }

  const show_slug = slugify(show_name);
  if (hardShowSlugs.has(show_slug)) {
    return { ok: false, error: `Podden "${show_name}" anvandes for nyligen – valj en annan podd.` };
  }

  const key = `${show_slug}::${normalizeTitle(episode_title)}`;
  if (recentKeys.has(key)) {
    return { ok: false, error: `Avsnittet finns redan i historiken: "${show_name} – ${episode_title}".` };
  }

  const links = {};
  if (raw.listen_links && typeof raw.listen_links === "object") {
    for (const [k, v] of Object.entries(raw.listen_links)) {
      if (typeof v === "string" && /^https?:\/\//i.test(v)) links[k] = k === "apple" ? appleSe(v) : v;
    }
  }

  return {
    ok: true,
    tip: {
      episode_title,
      show_name,
      show_slug: slugify(show_name),
      hosts,
      genre,
      language,
      year: typeof raw.year === "number" ? raw.year : null,
      duration_minutes: typeof raw.duration_minutes === "number" ? raw.duration_minutes : null,
      day_occasion,
      day_connection,
      why_great,
      listen_links: links,
      sources,
    },
  };
}

// Sorterar kallor sa att de som svarar (< 400) hamnar forst – utan att underkanna
// nagot. Kallorna ar redan akta (kom ur sokresultaten); detta ar bara kosmetik sa
// att den mest direkt klickbara lanken visas overst i kortet.
async function sourcesReachableFirst(sources) {
  const checked = await Promise.all(
    sources.map(async (s) => ({ s, ok: await isReachable(s.url) }))
  );
  return [...checked.filter((c) => c.ok), ...checked.filter((c) => !c.ok)].map((c) => c.s);
}

// Behall bara lyssna-lankar som faktiskt gar att na (rensar bort pahittade URL:er).
async function filterReachableLinks(links) {
  const out = {};
  for (const [k, v] of Object.entries(links || {})) {
    if (await isReachable(v)) out[k] = v;
    else console.log(`Lyssna-lank (${k}) oatkomlig, tas bort: ${v}`);
  }
  return out;
}

async function isReachable(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
      headers: { "user-agent": "DagensPod/1.0 (+https://github.com/hhammarstrand/poddtipset)" },
    });
    return res.status < 400;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lyssna-lankar: garantera ALLTID minst Apple + Spotify (utan att hitta pa URL:er)
// ─────────────────────────────────────────────────────────────────────────────
// Honest fallback: en sok-deeplänk ar ingen pahittad avsnitts-URL utan en riktig
// sokning som tar lyssnaren ratt. Anvands bara nar vi inte kan sla upp en exakt URL.
function appleSearchLink(term) {
  return `https://podcasts.apple.com/se/search?term=${encodeURIComponent(term)}`;
}
function spotifySearchLink(term) {
  return `https://open.spotify.com/search/${encodeURIComponent(term)}`;
}

// Luddig matchning sa vi inte rakar lanka fel podd/avsnitt fran iTunes-traffar.
function looseMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" ").filter(Boolean));
  const tb = new Set(nb.split(" ").filter(Boolean));
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let hit = 0;
  for (const w of small) if (big.has(w)) hit++;
  return small.size > 0 && hit / small.size >= 0.6;
}

// Slar upp en VERKLIG Apple Podcasts-URL via iTunes Search API (gratis, nyckellost).
// Forst pa avsnittsniva, annars poddniva. null om inget sakert traffar.
async function itunesAppleUrl(showName, episodeTitle) {
  const query = (entity, term) => {
    const u = new URL("https://itunes.apple.com/search");
    u.searchParams.set("media", "podcast");
    u.searchParams.set("entity", entity);
    u.searchParams.set("limit", "8");
    u.searchParams.set("country", "SE");
    u.searchParams.set("term", term);
    return u;
  };
  const get = async (u) => {
    const res = await fetch(u, {
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
      headers: { "user-agent": "DagensPod/1.0 (+https://github.com/hhammarstrand/poddtipset)" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  };
  try {
    // 1) Exakt avsnitt: bade podd- och avsnittsnamn maste matcha.
    for (const r of await get(query("podcastEpisode", `${showName} ${episodeTitle}`))) {
      if (looseMatch(r.collectionName || "", showName) && looseMatch(r.trackName || "", episodeTitle)) {
        const url = r.trackViewUrl || r.episodeUrl || r.collectionViewUrl;
        if (url) return appleSe(url);
      }
    }
    // 2) Faller tillbaka pa poddens sida.
    for (const r of await get(query("podcast", showName))) {
      if (looseMatch(r.collectionName || "", showName) && r.collectionViewUrl) {
        return appleSe(r.collectionViewUrl);
      }
    }
  } catch {
    /* nat-/parsfel – faller igenom till null sa sok-deeplänk anvands */
  }
  return null;
}

// Garanterar att tipset alltid har minst en Apple- och en Spotify-lank.
// Behaller redan nabara modell-lankar; fyller bara i det som saknas.
// Exporteras sa att enrich-links.mjs kan efter-fylla aldre poster med samma logik.
export async function ensureListenLinks(links, showName, episodeTitle) {
  const out = { ...(links || {}) };
  const term = `${showName} ${episodeTitle}`.trim();
  if (!out.apple) {
    out.apple = (await itunesAppleUrl(showName, episodeTitle)) || appleSearchLink(term);
  }
  if (!out.spotify) {
    out.spotify = spotifySearchLink(term);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Huvudflode
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    console.error("::error::MINIMAX_API_KEY saknas – kan inte generera.");
    process.exit(0);
  }

  const date = process.env.GENERATE_DATE || todayStockholm();
  const force = ["1", "true", "yes"].includes(String(process.env.GENERATE_FORCE || "").toLowerCase());
  let data = await readData();

  if (data.some((r) => r.date === date)) {
    if (force) {
      console.log(`Tvingar omgenerering av ${date} (GENERATE_FORCE).`);
      data = data.filter((r) => r.date !== date);
    } else {
      console.log(`Tips for ${date} finns redan – idempotent no-op.`);
      return;
    }
  }

  // Dedup raknas pa DATUMFONSTER runt maldatumet (inte globalt senaste), sa det
  // funkar aven nar man bakat-genererar gamla datum.
  const tIdx = dayIndex(date);
  const near = (r, n) => Math.abs(dayIndex(r.date) - tIdx) <= n;
  // Episod-dedup: aldrig upprepa samma avsnitt (hela historiken).
  const recentKeys = new Set(data.map((r) => `${slugify(r.show_name)}::${normalizeTitle(r.episode_title)}`));
  // Podd-dedup: hard sparr om samma podd anvants inom +/- SHOW_HARD_DAYS dagar.
  const hardShowSlugs = new Set(data.filter((r) => near(r, SHOW_HARD_DAYS)).map((r) => slugify(r.show_name)));
  // Mjuk lista: poddar i ett bredare fonster runt datumet.
  const avoidShows = [...new Set(data.filter((r) => near(r, SHOW_SOFT_COUNT)).map((r) => r.show_name))];
  const dedupList = data
    .filter((r) => r.date !== date)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, DEDUP_COUNT)
    .map((r) => `${r.date} | ${r.show_name} | ${r.episode_title}`);

  // Dagens tema-krokar fran Wikipedia "On this day" (stark preferens, inte tvang).
  const [, mm, dd] = date.split("-");
  const hooks = await fetchOnThisDay(date);
  const themeBlock = formatThemeBlock(hooks, mm, dd);
  console.log(`On this day ${dd}/${mm}: ${hooks.length} krokar hamtade.`);

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      SEEN.length = 0; // nollstall sedda sokresultat per forsok
      const queries = buildQueries(date, attempt, hooks);
      console.log(`Forsok ${attempt}: sokningar [${queries.join(" | ")}]`);
      const searches = await gatherResults(apiKey, queries);
      const searchBlock = formatSearchResults(searches);
      const hitCount = searches.reduce((n, s) => n + (s.results?.length || 0), 0);
      const searchErrors = searches.filter((s) => s.error).map((s) => `"${s.query}": ${s.error}`);
      console.log(`Forsok ${attempt}: ${hitCount} sokresultat${searchErrors.length ? ` (fel: ${searchErrors.join("; ")})` : ""}`);
      if (hitCount < LOW_HIT_THRESHOLD) {
        lastError = "For fa sokresultat for att garantera en kallbelagd, icke-pahittad rekommendation.";
        console.log(`Forsok ${attempt} hoppar over modellanrop: bara ${hitCount} sokresultat.`);
        continue;
      }
      const text = await askModel(apiKey, systemPrompt(), userPrompt(dedupList, avoidShows, searchBlock, themeBlock, lastError));
      const v = validateTip(extractJsonObject(text), recentKeys, SEEN, hardShowSlugs);
      if (!v.ok) { lastError = v.error; console.log(`Forsok ${attempt} underkant: ${v.error}`); continue; }

      // Ingen separat reachability-koll pa kallor: de ar redan garanterat akta (de
      // MASTE ordagrant ha kommit ur MiniMax sokresultat, se validateTip). En extra
      // live-fetch foll bara pa bot-skyddade sajter (Reddit/nyhetssajter blockar
      // datacenter-IP) och underkande korrekta tips. Sorterar reachable forst sa den
      // mest klickbara kallan visas overst, men underkanner inte langre pa det.
      v.tip.sources = await sourcesReachableFirst(v.tip.sources);

      // Rensa bort lyssna-lankar som inte gar att na (t.ex. pahittade Spotify-URL:er),
      // och garantera sedan att Apple + Spotify alltid finns (iTunes-API + sok-deeplänk).
      v.tip.listen_links = await filterReachableLinks(v.tip.listen_links);
      v.tip.listen_links = await ensureListenLinks(v.tip.listen_links, v.tip.show_name, v.tip.episode_title);

      const record = { date, ...v.tip, created_at: new Date().toISOString() };
      const next = [record, ...data].sort((a, b) => (a.date < b.date ? 1 : -1));
      await writeData(next);
      console.log(`✓ Skapade tips for ${date}: ${record.show_name} – ${record.episode_title}`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.log(`Forsok ${attempt} fel: ${lastError}`);
    }
  }

  // Misslyckades efter alla forsok: lamna dagen tom (frontend visar gardagens tips).
  console.error(`::error::Kunde inte generera ett giltigt tips for ${date} efter ${MAX_ATTEMPTS} forsok: ${lastError}`);
  process.exit(0);
}

// Kor bara nar filen startas direkt (node scripts/generate.mjs), inte vid import (tester).
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`::error::Ovantat fel: ${err?.stack || err}`);
    process.exit(0);
  });
}

export { validateTip, extractJsonObject, NON_STANDALONE_RE, QUOTE_RE, SERIES_ADMISSION_RE, normUrl, collapse, SEEN, fetchOnThisDay, formatThemeBlock, minimaxSearch };
