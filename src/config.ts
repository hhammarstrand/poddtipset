// ─────────────────────────────────────────────────────────────────────────────
// KONFIGURATION – andra har for att styra kuratering, sprak och schema.
// ─────────────────────────────────────────────────────────────────────────────

// Vilka sprak far dagens tips vara pa? (ISO 639-1)
export const LANGUAGES = ["sv", "en"] as const;

// Genrer: "all" = inga begransningar. Annars en whitelist/prioritering, t.ex.
//   export const GENRES: "all" | string[] = ["history", "true crime", "science"];
export const GENRES: "all" | string[] = "all";

// Claude-modell for dygnsgenereringen. "claude-opus-4-8" = basta kurateringen.
// Byt till "claude-sonnet-4-6" for lagre kostnad.
export const MODEL = "claude-opus-4-8";

// Hur manga tidigare tips som skickas med i prompten for dedup.
export const DEDUP_COUNT = 60;

// Max antal regenereringsforsok om ett tips ar ogiltigt/dubblett/saknar nabar kalla.
export const MAX_ATTEMPTS = 3;

// Web search ar ett server-side-verktyg; modellen kan pausa (stop_reason: "pause_turn").
// Sa manga ganger ateruppta vi turen innan vi ger upp.
export const MAX_TOOL_ROUNDS = 6;

// Sprak for "darfor ar avsnittet sa bra"-texten. App-publiken ar svensk, sa vi
// skriver alltid pa svenska oavsett avsnittets sprak.
export const WHY_LANG = "sv";

// Tidszon som cron-tiden i wrangler.jsonc ar tankt att motsvara (endast for visning/README).
// Cloudflare-cron kors i UTC: "0 5 * * *" = 06:00 Europe/Stockholm pa vintern.
export const DISPLAY_TIMEZONE = "Europe/Stockholm";

// Hur lange API-svar far cachas i webblasaren (sekunder).
export const TODAY_CACHE_SECONDS = 300;
export const LIST_CACHE_SECONDS = 600;

// Max antal millisekunder vi vantar nar vi verifierar att en kall-URL ar nabar.
export const SOURCE_FETCH_TIMEOUT_MS = 8000;
