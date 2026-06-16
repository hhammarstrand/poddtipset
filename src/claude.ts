import { MODEL, MAX_TOOL_ROUNDS } from "./config";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Minimal typning av det vi bryr oss om i svaret.
interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}
interface MessagesResponse {
  role: string;
  content: ContentBlock[];
  stop_reason: string | null;
  [key: string]: unknown;
}

/**
 * Kor ett Claude-anrop med web_search aktiverat och hanterar pause_turn-loopen
 * (server-side-verktyg kan pausa turen for att soka pa webben). Returnerar all
 * sammanlagd text fran modellens textblock.
 */
export async function runWebSearchPrompt(apiKey: string, prompt: string): Promise<string> {
  const messages: { role: string; content: unknown }[] = [
    { role: "user", content: prompt },
  ];

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

    const data = (await res.json()) as MessagesResponse;

    // Samla textblocken fran detta svar.
    lastText = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();

    // Server-side-verktyget bad om att fa fortsatta -> skicka tillbaka assistant-content.
    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }

    // end_turn / annat avslut.
    return lastText;
  }

  // Slut pa rundor – returnera det vi har (validering far avgora om det racker).
  return lastText;
}

/**
 * Plockar ut det sista balanserade JSON-objektet ur en textstrang. Modellen
 * ombeds avsluta med ett rent JSON-objekt, men kan ramla in motivering runt
 * det – darfor extraherar vi tolerant.
 */
export function extractJsonObject(text: string): unknown | null {
  // Forsta: hela strangen ar redan ren JSON.
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  // Annars: skanna efter det sista balanserade { ... }-blocket.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  const candidates: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  // Prova kandidaterna fran sist till forst (sista objektet ar oftast svaret).
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryParse(candidates[i]);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
