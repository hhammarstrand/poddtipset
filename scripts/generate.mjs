// Dagens Pod – dygnsgenerering for GitHub Actions.
// Kors en gang per dygn: valjer ETT dokumenterat hyllat poddavsnitt via Claude
// (med web_search), validerar och kallbelagger det, och lagger till det i den
// statiska datafilen som GitHub Pages serverar.
//
// Kraver Node 20+ (global fetch, AbortSignal.timeout). Inga npm-beroenden.
// Las ANTHROPIC_API_KEY fran miljon (GitHub Actions secret).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// KONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const LANGUAGES = ["sv", "en"];
const GENRES = "all"; // "all" eller t.ex. ["history", "true crime"]
const MODEL = "claude-opus-4-8";
const DEDUP_COUNT = 60;
const MAX_ATTEMPTS = 3;
const MAX_TOOL_ROUNDS = 6;
const WHY_LANG = "sv";
const SOURCE_FETCH_TIMEOUT_MS = 8000;

const API_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "") + "/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

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
// Claude Messages API (web_search + pause_turn-loop)
// ─────────────────────────────────────────────────────────────────────────────
async function runWebSearchPrompt(apiKey, prompt) {
  const messages = [{ role: "user", content: prompt }];
  let lastText = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        tools: [{ type: "web_search_20260209", name: "web_search" }],
        messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Claude API ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = await res.json();
    lastText = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }
    return lastText;
  }
  return lastText;
}

// Plocka ut det sista balanserade JSON-objektet ur en textstrang.
function extractJsonObject(text) {
  const trimmed = text.trim();
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
function buildPrompt(dedupList, lastError) {
  const langNames = LANGUAGES.map((l) => (l === "sv" ? "svenska" : l === "en" ? "engelska" : l)).join(" eller ");
  const genreLine = GENRES === "all" ? "Alla genrer ar tillatna." : `Prioritera dessa genrer: ${GENRES.join(", ")}.`;
  const dedup = dedupList.length ? dedupList.map((d) => `- ${d}`).join("\n") : "(historiken ar tom)";
  const retry = lastError
    ? `\n\nFOREGAENDE FORSOK UNDERKANDES: ${lastError}\nValj ett ANNAT avsnitt som uppfyller alla krav.\n`
    : "";

  return `Du ar en mycket paläst poddredaktor. Anvand webbsokverktyget for att hitta ETT enastaende poddavsnitt att rekommendera som "dagens tips".

KRAV PA AVSNITTET:
- Det ska vara dokumenterat hyllat: aterkommer pa "basta avsnitt"-listor, ar hogt rankat pa Podchaser eller Reddit, prisbelont, eller mycket delat/citerat. Sok aktivt efter belagg.
- Sprak: ${langNames}.
- ${genreLine}
- Det far INTE vara nagot av dessa redan rekommenderade avsnitt:
${dedup}

KALLOR:
- Bifoga minst en verifierbar, publik URL som faktiskt belagger varfor avsnittet raknas som utomordentligt (en lista, artikel, prismotivering, Podchaser-sida, eller en hogt upproostad Reddit-trad). URL:en ska vara nabar just nu.

SKRIV "DARFOR AR DET BRA"-TEXTEN SOM EN MANNISKA:
- ${WHY_LANG === "sv" ? "Skriv pa svenska." : "Skriv pa engelska."}
- 2-4 meningar, konkret och specifik om just detta avsnitt (vad hander, vem medverkar, vad gor det minnesvart).
- Inga floskler, inga AI-klichéer ("dyk ner i", "en fascinerande resa", "vare sig du ar..."). Lat det lata som en kunnig redaktor, inte en generator.

SVARSFORMAT:
Avsluta ditt svar med ETT rent JSON-objekt (och inget efter det) med exakt dessa falt:
{
  "episode_title": string,
  "show_name": string,
  "hosts": string,
  "genre": string,
  "language": string,              // "${LANGUAGES.join('" eller "')}"
  "year": number | null,
  "duration_minutes": number | null,
  "why_great": string,
  "listen_links": { "apple": string?, "spotify": string?, "web": string? },
  "sources": [ { "title": string, "url": string } ]
}${retry}`;
}

function validateTip(raw, recentKeys) {
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

  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .map((s) => ({ title: str(s?.title) || "Kalla", url: str(s?.url) }))
        .filter((s) => /^https?:\/\//i.test(s.url))
    : [];
  if (!sources.length) return { ok: false, error: "Minst en giltig http(s)-kall-URL kravs i 'sources'." };

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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("::error::ANTHROPIC_API_KEY saknas – kan inte generera.");
    process.exit(0);
  }

  const date = process.env.GENERATE_DATE || todayStockholm();
  const data = await readData();

  if (data.some((r) => r.date === date)) {
    console.log(`Tips for ${date} finns redan – idempotent no-op.`);
    return;
  }

  const recent = data.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, DEDUP_COUNT);
  const dedupList = recent.map((r) => `${r.date} | ${r.show_name} | ${r.episode_title}`);
  const recentKeys = new Set(recent.map((r) => `${slugify(r.show_name)}::${normalizeTitle(r.episode_title)}`));

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const text = await runWebSearchPrompt(apiKey, buildPrompt(dedupList, lastError));
      const v = validateTip(extractJsonObject(text), recentKeys);
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

main().catch((err) => {
  console.error(`::error::Ovantat fel: ${err?.stack || err}`);
  process.exit(0);
});
