import type { Env, GeneratedTip, Recommendation, Source } from "./types";
import {
  LANGUAGES,
  GENRES,
  DEDUP_COUNT,
  MAX_ATTEMPTS,
  WHY_LANG,
  SOURCE_FETCH_TIMEOUT_MS,
} from "./config";
import { runWebSearchPrompt, extractJsonObject } from "./claude";
import { getByDate, getRecent, insertRecommendation, slugify, todayStockholm } from "./db";

export interface GenerateResult {
  status: "created" | "exists" | "failed";
  date: string;
  recommendation?: GeneratedTip;
  error?: string;
  attempts?: number;
}

/**
 * Dygnsflodet. Idempotent: finns redan ett tips for datumet -> no-op.
 * Annars: hamta dedup-lista, anropa Claude (web_search), validera, regenerera
 * vid behov (max MAX_ATTEMPTS), och spara.
 */
export async function runGeneration(
  env: Env,
  opts: { date?: string } = {}
): Promise<GenerateResult> {
  const date = opts.date ?? todayStockholm();

  const existing = await getByDate(env, date);
  if (existing) return { status: "exists", date };

  const recent = await getRecent(env, DEDUP_COUNT);
  const dedupList = recent.map(
    (r) => `${r.date} | ${r.show_name} | ${r.episode_title}`
  );
  const recentKeys = new Set(
    recent.map((r) => `${slugify(r.show_name)}::${normalizeTitle(r.episode_title)}`)
  );

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const prompt = buildPrompt(dedupList, lastError);
      const text = await runWebSearchPrompt(env.ANTHROPIC_API_KEY, prompt);
      const raw = extractJsonObject(text);

      const validation = validateTip(raw, recentKeys);
      if (!validation.ok) {
        lastError = validation.error;
        continue;
      }
      const tip = validation.tip;

      // Minst en nabar kall-URL kravs.
      const reachable = await hasReachableSource(tip.sources);
      if (!reachable) {
        lastError =
          "Ingen av kall-URL:erna gick att na (status >= 400 eller timeout). Valj ett avsnitt med minst en publik, fungerande kalla som belagger hyllningen.";
        continue;
      }

      const created = await insertRecommendation(env, date, tip);
      if (!created) {
        // Nagon hann skapa raden parallellt – idempotent.
        return { status: "exists", date };
      }
      return { status: "created", date, recommendation: tip, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { status: "failed", date, error: lastError, attempts: MAX_ATTEMPTS };
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function buildPrompt(dedupList: string[], lastError: string): string {
  const langNames = LANGUAGES.map((l) =>
    l === "sv" ? "svenska" : l === "en" ? "engelska" : l
  ).join(" eller ");
  const genreLine =
    GENRES === "all"
      ? "Alla genrer ar tillatna."
      : `Prioritera dessa genrer: ${(GENRES as string[]).join(", ")}.`;

  const dedup =
    dedupList.length > 0
      ? dedupList.map((d) => `- ${d}`).join("\n")
      : "(historiken ar tom)";

  const retry = lastError
    ? `\n\nFoREGAENDE FORSOK UNDERKANDES: ${lastError}\nValj ett ANNAT avsnitt som uppfyller alla krav.\n`
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
  "hosts": string,                 // vard(ar), kommaseparerat; "" om okant
  "genre": string,                 // en kort genre, t.ex. "history", "true crime", "samhalle"
  "language": string,              // "${LANGUAGES.join('" eller "')}"
  "year": number | null,           // utgivningsar
  "duration_minutes": number | null,
  "why_great": string,
  "listen_links": { "apple": string?, "spotify": string?, "web": string? },
  "sources": [ { "title": string, "url": string } ]
}${retry}`;
}

interface ValidationOk {
  ok: true;
  tip: GeneratedTip;
}
interface ValidationFail {
  ok: false;
  error: string;
}

function validateTip(raw: unknown, recentKeys: Set<string>): ValidationOk | ValidationFail {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Kunde inte tolka nagot JSON-objekt ur svaret." };
  }
  const o = raw as Record<string, unknown>;

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const episode_title = str(o.episode_title);
  const show_name = str(o.show_name);
  const hosts = str(o.hosts);
  const genre = str(o.genre);
  const language = str(o.language).toLowerCase();
  const why_great = str(o.why_great);

  const missing: string[] = [];
  if (!episode_title) missing.push("episode_title");
  if (!show_name) missing.push("show_name");
  if (!genre) missing.push("genre");
  if (!language) missing.push("language");
  if (!why_great) missing.push("why_great");
  if (missing.length) {
    return { ok: false, error: `Saknade/tomma falt: ${missing.join(", ")}.` };
  }

  if (!(LANGUAGES as readonly string[]).includes(language)) {
    return {
      ok: false,
      error: `language "${language}" ar inte tillatet (tillatna: ${LANGUAGES.join(", ")}).`,
    };
  }

  // Sources: minst en med giltig http(s)-URL.
  const sources: Source[] = Array.isArray(o.sources)
    ? (o.sources as unknown[])
        .map((s) => {
          const so = (s ?? {}) as Record<string, unknown>;
          return { title: str(so.title) || "Kalla", url: str(so.url) };
        })
        .filter((s) => /^https?:\/\//i.test(s.url))
    : [];
  if (sources.length === 0) {
    return { ok: false, error: "Minst en giltig http(s)-kall-URL kravs i 'sources'." };
  }

  // Dedup mot historiken.
  const key = `${slugify(show_name)}::${normalizeTitle(episode_title)}`;
  if (recentKeys.has(key)) {
    return { ok: false, error: `Avsnittet finns redan i historiken: "${show_name} – ${episode_title}".` };
  }

  const listen_links =
    o.listen_links && typeof o.listen_links === "object"
      ? (o.listen_links as Record<string, unknown>)
      : {};
  const links: Record<string, string> = {};
  for (const [k, v] of Object.entries(listen_links)) {
    if (typeof v === "string" && /^https?:\/\//i.test(v)) links[k] = v;
  }

  const year = typeof o.year === "number" ? o.year : null;
  const duration_minutes = typeof o.duration_minutes === "number" ? o.duration_minutes : null;

  return {
    ok: true,
    tip: {
      episode_title,
      show_name,
      hosts,
      genre,
      language,
      year,
      duration_minutes,
      why_great,
      listen_links: links,
      sources,
    },
  };
}

// Returnerar true om minst en kalla svarar med status < 400 inom timeout.
async function hasReachableSource(sources: Source[]): Promise<boolean> {
  for (const s of sources) {
    if (await isReachable(s.url)) return true;
  }
  return false;
}

async function isReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
  try {
    // En del servrar svarar inte pa HEAD -> anvand GET men las inte hela bodyn.
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "DagensPod/1.0 (+https://github.com/hhammarstrand/poddtipset)" },
    });
    return res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type { Recommendation };
