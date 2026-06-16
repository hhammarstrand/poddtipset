# Dagens Pod 🎧

En deployad webbapp som varje dygn automatiskt väljer ut **ETT** dokumenterat hyllat
poddavsnitt och presenterar det som "dagens tips". Användaren ser dagens avsnitt, bläddrar
i historik över tidigare tips och ser statistik över vilka poddar som rekommenderats oftast.

Ingen inloggning, ingen tracking. Mobil först, mörkt/ljust läge.

## Hur kurateringen fungerar

Det finns inget rent API för "bästa poddavsnitten". Lösningen:

- Ett **schemalagt jobb** (Cloudflare Cron) körs en gång per dygn.
- Det anropar **Claude-API:t** (`claude-opus-4-8`) **med web_search-verktyget aktiverat**.
- Prompten ber modellen välja ETT avsnitt som är dokumenterat hyllat (återkommer på
  "bästa avsnitt"-listor, högt på Podchaser/Reddit, prisbelönt, mycket delat), matchar
  inställd språk-/genrepreferens och **inte** redan finns i historiken (de senaste ~60 tipsen
  skickas med för dedup).
- Svaret valideras: alla fält ifyllda, rätt språk, ingen dubblett och **minst en käll-URL som
  faktiskt går att nå** (`fetch` < 400). Tips som inte uppfyller kraven förkastas och regenereras
  (max 3 försök). Annars lämnas dagen tom och frontend visar gårdagens tips + "nytt tips snart".

## Arkitektur

```
Cron (06:00 Europe/Stockholm)
        │
        ▼
Cloudflare Worker  ── scheduled() ──►  Claude API (web_search)  ──►  validering  ──►  D1
        │                                                                              │
        └── fetch() ── /api/* (JSON-API)  ◄───────────────────────────────────────────┘
                    └── allt annat → statisk frontend (Workers Static Assets)
```

Allt ligger i **ett** deploybart Worker-projekt. Frontend (vanilla HTML/CSS/JS, inget byggsteg)
serveras som statiska assets från samma Worker som exponerar JSON-API:t.

| Fil | Ansvar |
|-----|--------|
| `wrangler.jsonc` | Worker-config: cron, D1-binding, assets-binding |
| `migrations/0001_init.sql` | Tabellen `recommendations` + index |
| `src/index.ts` | Router (`fetch`) + schemalagt jobb (`scheduled`) |
| `src/config.ts` | **Konfiguration överst** – språk, genrer, modell m.m. |
| `src/generate.ts` | Dygnsflödet: dedup, Claude-anrop, validering, retry, spara |
| `src/claude.ts` | Claude Messages API via `fetch` (web_search + pause_turn + JSON-parse) |
| `src/db.ts` | D1-queries (idempotent insert, historik, dedup) |
| `src/stats.ts` | Härledd statistik (topplista, fördelningar, streak, tidslinje) |
| `public/` | Frontend: `index.html`, `styles.css`, `app.js` |

## Konfiguration

Allt ändras högst upp i [`src/config.ts`](src/config.ts):

- `LANGUAGES` – tillåtna språk, just nu `["sv", "en"]`.
- `GENRES` – `"all"` eller en whitelist, t.ex. `["history", "true crime"]`.
- `MODEL` – `"claude-opus-4-8"` (byt till `"claude-sonnet-4-6"` för lägre kostnad).
- `DEDUP_COUNT`, `MAX_ATTEMPTS`, `MAX_TOOL_ROUNDS`, `WHY_LANG` m.m.

Cron-tiden ändras i `wrangler.jsonc` under `triggers.crons`.

## Datamodell (D1, tabell `recommendations`)

`id` · `date` (UNIQUE, YYYY-MM-DD) · `episode_title` · `show_name` · `show_slug` (normaliserad
för gruppering) · `hosts` · `genre` · `language` · `year` · `duration_minutes` · `why_great` ·
`listen_links` (JSON) · `sources` (JSON: `[{title,url}]`) · `created_at`. Statistik härleds med
`GROUP BY` på `show_slug` / `genre` / `language`.

---

## Deploy

> **Status i detta repo:** D1-databasen är redan skapad och migrerad i Cloudflare-kontot
> (via Cloudflare-integrationen). `wrangler.jsonc` pekar redan på rätt `database_id`
> (`6e7c4f7d-18c8-4f48-ba69-59162418c2c4`). Det som återstår är att **sätta secrets** och
> **deploya Worker-koden** – de stegen kräver en autentiserad `wrangler` (en Cloudflare-token
> eller `wrangler login`), vilket inte kunde göras automatiskt i byggmiljön.

### Förutsättningar
- Node 20+ och npm.
- Ett Cloudflare-konto.
- En Claude API-nyckel (https://platform.claude.com).

### Steg

```bash
# 1. Installera beroenden
npm install

# 2. Logga in mot Cloudflare (öppnar webbläsare)
npx wrangler login
#    – eller, i CI/headless: exportera CLOUDFLARE_API_TOKEN och CLOUDFLARE_ACCOUNT_ID

# 3. Secrets (sparas krypterat hos Cloudflare, hamnar ALDRIG i koden)
npx wrangler secret put ANTHROPIC_API_KEY      # klistra in din Claude API-nyckel
npx wrangler secret put GENERATE_TOKEN         # valfri lång slumpsträng som skyddar /api/generate

# 4. Deploya Workern (frontend + API + cron i ett)
npx wrangler deploy
```

> **D1 från scratch?** Om du deployar i ett annat konto: kör
> `npx wrangler d1 create poddtipset`, klistra in det nya `database_id` i `wrangler.jsonc`,
> och kör `npx wrangler d1 migrations apply poddtipset --remote`. (Migrationen använder
> `IF NOT EXISTS` och är säker att köra om mot en redan migrerad databas.)

### Seeda det första tipset

Cron kör 06:00 Europe/Stockholm. För att inte vänta – trigga en generering direkt mot den
deployade Workern (`$GENERATE_TOKEN` = värdet du satte ovan, `$URL` = din workers.dev-URL):

```bash
curl -X POST "$URL/api/generate" -H "x-generate-token: $GENERATE_TOKEN"
```

Svaret blir `{"status":"created", ...}` vid lyckad generering, `{"status":"exists"}` om dagens
tips redan finns (idempotent), eller `{"status":"failed", "error": "..."}` om alla 3 försök
underkändes. Kör samma kommando två gånger samma dygn → fortfarande bara ett tips.

## Lokal utveckling

```bash
cp .dev.vars.example .dev.vars      # fyll i ANTHROPIC_API_KEY + GENERATE_TOKEN
npx wrangler d1 migrations apply poddtipset --local
npm run dev                         # http://127.0.0.1:8787
```

`.dev.vars` är gitignorerad – lägg aldrig riktiga nycklar i versionshantering.

## API

| Metod & väg | Beskrivning |
|-------------|-------------|
| `GET /api/today` | Dagens tips. Saknas det returneras senaste tipset med `stale: true`. |
| `GET /api/history?search=&genre=&language=&show=` | Alla tips, nyast först, sökbart/filtrerbart. |
| `GET /api/recommendation/:id` | Detalj per `id` eller `:date` (YYYY-MM-DD). |
| `GET /api/stats` | Topplista, fördelning per genre/språk, totalt, streak, tidslinje. |
| `POST /api/generate` | Manuell körning/seed. Kräver header `x-generate-token`. |

## Noter

- **Tidszon:** Cloudflare-cron körs i UTC. `"0 5 * * *"` = 06:00 på vintern (CET) och 07:00 på
  sommaren (CEST) i Europe/Stockholm. Justera i `wrangler.jsonc` om du vill ha exakt 06:00 året runt.
- **Kostnad:** ett Claude-anrop per dygn (web_search) – försumbart.
- **Inga hemligheter i koden:** `ANTHROPIC_API_KEY` och `GENERATE_TOKEN` sätts som Worker-secrets.
