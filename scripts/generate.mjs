// Dagens Pod – dygnsgenerering for GitHub Actions.
// Kors en gang per dygn: valjer ETT dokumenterat hyllat poddavsnitt med hjalp av
// en LLM (Qwen via Staik, OpenAI-kompatibelt API) som soker pa webben via en
// sjalv-hostad SearXNG-instans (klient-sidigt web_search-verktyg). Resultatet
// valideras och kallbelaggs, och laggs till i den statiska datafilen som GitHub
// Pages serverar.
//
// Kraver Node 20+ (global fetch, AbortSignal.timeout). Inga npm-beroenden.
// Las STAIK_API_KEY fran miljon (GitHub Actions secret) och SEARXNG_URL
// (default http://localhost:8080, satts av workflowen).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// KONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const LANGUAGES = ["sv", "en"];
const GENRES = "all"; // "all" eller t.ex. ["history", "true crime"]
const MODEL = "qwen3.6:35b-a3b"; // Staik-modell. Alternativ: "qwen3.5:9b", "gemma4:31b".
const DEDUP_COUNT = 60;
const MAX_ATTEMPTS = 4; // fler forsok eftersom guardrails underkanner mer
const MAX_TOOL_ROUNDS = 5; // hur manga ganger modellen far anropa web_search per forsok
const SEED_RESULTS_PER_QUERY = 6; // antal traffar som skickas tillbaka per sokning
const TEMPERATURE = 0.4; // lagt for att minska pahitt/konfabulering i fakta
const WHY_LANG = "sv";
const SOURCE_FETCH_TIMEOUT_MS = 8000;
const SEARXNG_TIMEOUT_MS = 12000;
const STAIK_TIMEOUT_MS = 120000;
const WIKI_TIMEOUT_MS = 12000;
// Sprak for "On this day"-flodet (Wikipedia), i prioritetsordning. Forsta som svarar anvands/merges.
const ONTHISDAY_WIKIS = ["sv", "en"];

// Guardrails (validering)
// Titel-monster som indikerar att avsnittet INTE ar fristaende (uppfoljare/serie/del/finale).
const NON_STANDALONE_RE =
  /\bupdate\b|update:|\buppdatering\b|\bpart\s+(one|two|three|four|five|1|2|3|4|5)\b|\bpt\.?\s*\d+\b|\bdel\s+(en|tva|två|tre|fyra|fem|\d+)\b|\bkapitel\s*\d+\b|\bchapter\s*\d+\b|\bepisode\s*\d+\b|\bavsnitt\s*\d+\b|\b\d+\s*\/\s*\d+\b|\bfinale\b|\bconclusion\b|\bcontinued\b|\bforts\.?\b|\bfortsättning\b|\bprolog|\bepilog/i;
// Citat far inte forekomma i why_great – vi kan inte garantera att de stammer, sa de forbjuds helt.
const QUOTE_RE = /["“”«»]|'[^']*\s[^']*'/;

const STAIK_URL =
  (process.env.STAIK_BASE_URL || "https://api.staik.se/v1").replace(/\/$/, "") + "/chat/completions";
const SEARXNG_URL = (process.env.SEARXNG_URL || "http://localhost:8080").replace(/\/$/, "");

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
// SearXNG – gratis, nyckellost web_search (self-hostad i workflowen)
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

async function searxngSearch(query) {
  const url = new URL("/search", SEARXNG_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "all");
  url.searchParams.set("safesearch", "0");
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "DagensPod/1.0 (+https://github.com/hhammarstrand/poddtipset)",
      },
      signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
    });
    if (!res.ok) return { query, error: `SearXNG svarade ${res.status}`, results: [] };
    const data = await res.json();
    const results = (Array.isArray(data.results) ? data.results : [])
      .slice(0, SEED_RESULTS_PER_QUERY)
      .map((r) => ({
        title: typeof r.title === "string" ? r.title : "",
        url: typeof r.url === "string" ? r.url : "",
        snippet: typeof r.content === "string" ? r.content.slice(0, 400) : "",
      }))
      .filter((r) => /^https?:\/\//i.test(r.url));
    for (const r of results) SEEN.push(r);
    return { query, results };
  } catch (err) {
    return { query, error: err instanceof Error ? err.message : String(err), results: [] };
  }
}

// Kor ett par bredsokningar for att alltid ge modellen riktigt material att utga fran.
function seedQueries(attempt) {
  const pool = [
    "best podcast episodes of all time",
    "basta poddavsnitt genom tiderna",
    "award winning podcast episode",
    "most acclaimed podcast episodes reddit",
    "arets basta poddavsnitt lista",
    "podchaser best podcast episodes",
  ];
  // Rotera urvalet per forsok sa retries far andra ingangar.
  const offset = ((attempt - 1) * 2) % pool.length;
  return [pool[offset], pool[(offset + 1) % pool.length]];
}

async function gatherSeedResults(attempt) {
  const queries = seedQueries(attempt);
  const searches = await Promise.all(queries.map((q) => searxngSearch(q)));
  return searches;
}

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
  take(data.selected, "handelse", 12);
  take(data.events, "handelse", 10);
  take(data.births, "fodd", 8);
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
  return uniq.slice(0, 24);
}

function formatThemeBlock(hooks, mm, dd) {
  if (!hooks.length) return "";
  const lines = hooks.map((h) => {
    const y = h.year != null ? `${h.year}` : "okant ar";
    const label = h.kind === "fodd" ? "Fodd" : "Handelse";
    return `- [${label}, ${y}] ${h.text}`;
  });
  return `DAGENS DATUM (${dd}/${mm}) – sa har knyter dagen an i historien (Wikipedia "On this day"):\n${lines.join("\n")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Staik chat/completions (OpenAI-kompatibelt) med klient-sidigt web_search-verktyg
// ─────────────────────────────────────────────────────────────────────────────
const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Sok pa webben for att hitta och belagga hyllade poddavsnitt. Returnerar titlar, URL:er och utdrag.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Sokfrasen, t.ex. 'best true crime podcast episode award'." },
      },
      required: ["query"],
    },
  },
};

async function staikChat(apiKey, messages) {
  const res = await fetch(STAIK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: [WEB_SEARCH_TOOL],
      tool_choice: "auto",
      temperature: 0.7,
      max_tokens: 3000,
    }),
    signal: AbortSignal.timeout(STAIK_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Staik API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error("Staik-svaret saknade 'choices'.");
  return choice;
}

// Driv modellen: den kan anropa web_search flera ganger, sedan returnerar vi sluttexten.
async function runAgent(apiKey, systemPrompt, userPrompt) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const choice = await staikChat(apiKey, messages);
    const msg = choice.message || {};
    messages.push(msg);

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (choice.finish_reason === "tool_calls" || toolCalls.length) {
      for (const tc of toolCalls) {
        let query = "";
        try {
          query = JSON.parse(tc.function?.arguments || "{}").query || "";
        } catch {
          query = "";
        }
        const result = query ? await searxngSearch(query) : { query: "", error: "tom sokfras", results: [] };
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    return typeof msg.content === "string" ? msg.content : "";
  }

  // Slut pa tool-rundor: be om ett avslutande svar utan fler verktyg.
  messages.push({
    role: "user",
    content: "Avsluta nu med ENBART JSON-objektet enligt instruktionen. Anropa inga fler verktyg.",
  });
  const final = await staikChat(apiKey, messages);
  return typeof final.message?.content === "string" ? final.message.content : "";
}

// Plocka ut det sista balanserade JSON-objektet ur en textstrang.
function extractJsonObject(text) {
  const trimmed = String(text || "").trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  let depth = 0, start = -1, inString = false, escape = false;
  const candidates = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { if (inString) escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) { candidates.push(text.slice(start, i + 1)); start = -1; }
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
  return `Du ar en mycket paläst poddredaktor som valjer ut ETT enastaende poddavsnitt som "dagens tips".

Du har verktyget web_search. Anvand det for att hitta och belagga hyllade avsnitt – sok flera ganger med olika fraser om det behovs. Du far redan en uppsattning sokresultat att utga fran.

ABSOLUTA REGLER MOT PAHITT (overordnade allt annat):
- Pasta ENDAST saker du kan stodja pa de sokresultat du faktiskt sett. Hitta aldrig pa avsnitt, poddar, vardar, artal, langd, priser eller placeringar.
- INGA CITAT. Skriv aldrig nagot citat och tillskriv aldrig en namngiven person en asikt eller ett yttrande (t.ex. "X kallade den..."). Citat far overhuvudtaget inte forekomma i texten.
- Ar du osaker pa ett falt (artal/langd) – satt det till null i stallet for att gissa.
- Poddens namn maste finnas i dina sokresultat. Annars valj en annan podd.

KRAV PA AVSNITTET:
- Dokumenterat hyllat: aterkommer pa "basta avsnitt"-listor, hogt rankat pa Podchaser/Reddit, prisbelont, eller mycket delat/citerat.
- Sprak: ${langNames}.
- ${genreLine}

FRISTAENDE AVSNITT (viktigt):
- Avsnittet MASTE vara fristaende och fungera som en ingang i sig sjalvt – det ska ga att lyssna pa utan att ha hort nagot annat avsnitt.
- Valj ALDRIG ett uppfoljnings- eller serie-avsnitt: inget "Part 2", "Del 3", "Chapter/Kapitel N", numrerat avsnitt, "Update:", finale, "fortsattning" eller nagot som bygger vidare pa en tidigare del. Om titeln eller innehallet forutsatter ett tidigare avsnitt – valj nagot annat.
- Satt faltet "standalone" till true bara om detta verkligen galler.

KOPPLING TILL DAGENS DATUM (stark preferens, inte tvang):
- Du far en lista pa vad som hande / vem som foddes denna dag i historien. Forsok GARNA hitta ett dokumenterat hyllat, fristaende avsnitt som genuint knyter an till nagot av detta (ett tema, en handelse, en person, en arsdag).
- Hittar du ett sant avsnitt: fyll i "day_connection" med EN kort mening (svenska) om hur avsnittet hanger ihop med dagen.
- Hittar du INGET genuint hyllat avsnitt som passar: valj anda det basta hyllade avsnittet utan koppling, och lamna "day_connection" som tom strang "". Hitta ALDRIG pa en koppling och tvinga inte fram en krystad sadan – kvaliteten gar fore temat.

KALLOR (viktigt):
- Du MASTE ange minst en kall-URL i "sources", och varje sadan URL MASTE vara en URL som ORDAGRANT forekom i dina web_search-resultat. Hitta ALDRIG pa en URL och andra den inte. Valj en kalla som verkligen belagger hyllningen (lista, artikel, prismotivering, Podchaser-sida, upproostad Reddit-trad).

SKRIV "DARFOR AR DET BRA"-TEXTEN SOM EN MANNISKA:
- ${WHY_LANG === "sv" ? "Skriv pa svenska." : "Skriv pa engelska."}
- 2-4 meningar, konkret och specifik om just detta avsnitt (vad hander, vem medverkar, vad gor det minnesvart) – men bara sant som stods av kallorna.
- Inga floskler, inga AI-klichéer ("dyk ner i", "en fascinerande resa", "vare sig du ar..."). Inga citat. Lat det lata som en kunnig redaktor, inte en generator.

SVARSFORMAT:
Nar du ar klar, avsluta med ETT rent JSON-objekt (och inget efter det) med exakt dessa falt:
{
  "episode_title": string,
  "show_name": string,
  "hosts": string,
  "genre": string,
  "language": string,              // "${LANGUAGES.join('" eller "')}"
  "year": number | null,
  "duration_minutes": number | null,
  "standalone": boolean,           // true endast om avsnittet ar fristaende (inte serie/uppfoljare)
  "day_connection": string,        // kort mening om kopplingen till dagens datum, annars ""
  "why_great": string,
  "listen_links": { "apple": string?, "spotify": string?, "web": string? },
  "sources": [ { "title": string, "url": string } ]
}`;
}

function userPrompt(dedupList, searchBlock, themeBlock, lastError) {
  const dedup = dedupList.length ? dedupList.map((d) => `- ${d}`).join("\n") : "(historiken ar tom)";
  const retry = lastError
    ? `\n\nFOREGAENDE FORSOK UNDERKANDES: ${lastError}\nValj ett ANNAT avsnitt som uppfyller alla krav.\n`
    : "";
  return `Valj ETT poddavsnitt enligt instruktionerna.

Det far INTE vara nagot av dessa redan rekommenderade avsnitt:
${dedup}

${themeBlock || "(ingen dagskoppling tillganglig – valj fritt bland hyllade avsnitt)"}

SOKRESULTAT ATT UTGA FRAN (du kan soka mer med web_search):
${searchBlock || "(inga sokresultat annu – anvand web_search)"}${retry}`;
}

function validateTip(raw, recentKeys, seen) {
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

  // Guardrail: fristaende avsnitt – inga uppfoljare/serie/del/finale.
  if (raw.standalone !== true) {
    return { ok: false, error: "Modellen bekraftade inte att avsnittet ar fristaende (standalone=true kravs)." };
  }
  if (NON_STANDALONE_RE.test(episode_title)) {
    return { ok: false, error: `Avsnittet ser ut att vara en uppfoljare/del/serie utifran titeln: "${episode_title}".` };
  }

  // Guardrail: inga citat i why_great (kan inte garanteras stamma).
  if (QUOTE_RE.test(why_great)) {
    return { ok: false, error: "why_great far inte innehalla citat eller citationstecken." };
  }

  // Dagskoppling ar valfri (stark preferens, inte tvang). Inga citat; kort.
  let day_connection = str(raw.day_connection);
  if (day_connection && QUOTE_RE.test(day_connection)) {
    return { ok: false, error: "day_connection far inte innehalla citat eller citationstecken." };
  }
  if (day_connection.length > 240) day_connection = day_connection.slice(0, 240).trim();

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

  // Guardrail: poddens namn maste forekomma i sokresultaten (poddar far inte hittas pa).
  const showC = collapse(show_name);
  if (corpus && showC && !corpus.includes(showC)) {
    return { ok: false, error: `show_name "${show_name}" forekom inte i sokresultaten.` };
  }

  const key = `${slugify(show_name)}::${normalizeTitle(episode_title)}`;
  if (recentKeys.has(key)) {
    return { ok: false, error: `Avsnittet finns redan i historiken: "${show_name} – ${episode_title}".` };
  }

  const links = {};
  if (raw.listen_links && typeof raw.listen_links === "object") {
    for (const [k, v] of Object.entries(raw.listen_links)) {
      if (typeof v === "string" && /^https?:\/\//i.test(v)) links[k] = v;
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
      day_connection,
      why_great,
      listen_links: links,
      sources,
    },
  };
}

async function hasReachableSource(sources) {
  for (const s of sources) {
    if (await isReachable(s.url)) return true;
  }
  return false;
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
// Huvudflode
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const apiKey = process.env.STAIK_API_KEY;
  if (!apiKey) {
    console.error("::error::STAIK_API_KEY saknas – kan inte generera.");
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

  const recent = data.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, DEDUP_COUNT);
  const dedupList = recent.map((r) => `${r.date} | ${r.show_name} | ${r.episode_title}`);
  const recentKeys = new Set(recent.map((r) => `${slugify(r.show_name)}::${normalizeTitle(r.episode_title)}`));

  // Dagens tema-krokar fran Wikipedia "On this day" (stark preferens, inte tvang).
  const [, mm, dd] = date.split("-");
  const hooks = await fetchOnThisDay(date);
  const themeBlock = formatThemeBlock(hooks, mm, dd);
  console.log(`On this day ${dd}/${mm}: ${hooks.length} krokar hamtade.`);

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      SEEN.length = 0; // nollstall sedda sokresultat per forsok
      const searches = await gatherSeedResults(attempt);
      const searchBlock = formatSearchResults(searches);
      const text = await runAgent(apiKey, systemPrompt(), userPrompt(dedupList, searchBlock, themeBlock, lastError));
      const v = validateTip(extractJsonObject(text), recentKeys, SEEN);
      if (!v.ok) { lastError = v.error; console.log(`Forsok ${attempt} underkant: ${v.error}`); continue; }

      if (!(await hasReachableSource(v.tip.sources))) {
        lastError = "Ingen av kall-URL:erna gick att na (status >= 400 eller timeout).";
        console.log(`Forsok ${attempt} underkant: ${lastError}`);
        continue;
      }

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

export { validateTip, NON_STANDALONE_RE, QUOTE_RE, normUrl, collapse, SEEN, fetchOnThisDay, formatThemeBlock };
