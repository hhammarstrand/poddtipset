# Dagens Pod 🎧

En webbapp som varje dygn automatiskt väljer ut **ETT** dokumenterat hyllat poddavsnitt och
presenterar det som "dagens tips". Användaren ser dagens avsnitt, bläddrar i historik och ser
statistik över vilka poddar som rekommenderats oftast.

Hostas helt på **GitHub Pages** (statisk frontend) + **GitHub Actions** (schemalagt jobb). Ingen
server, ingen databas, ingen inloggning, ingen tracking. Mobil först, mörkt/ljust läge.

## Så fungerar det

Brief'ens separation – **schemalagt jobb → persistens → läs-API → frontend** – behålls, med
en ren GitHub-stack:

```
GitHub Actions (cron, dagligen 03:00 Europe/Stockholm)
        │  node scripts/generate.mjs
        ▼
Claude (Anthropic Messages API)  ──►  söker själv på webben via det server-sidiga
        │                              web_search-verktyget, validering & källkontroll
        ▼
public/data/recommendations.json   ← committas tillbaka i repot (persistensen)
        │
        ▼
GitHub Pages serverar public/  ──►  frontend laser JSON och visar
                                     dagens tips / historik / statistik (allt klient-sidan)
```

Sökningen körs på **Anthropics infrastruktur**, inte på GitHub-runnern: Claudes inbyggda
`web_search`-verktyg gör de faktiska webbsökningarna server-side. Det betyder att runnerns
datacenter-IP aldrig är i sökloopen – tidigare löste vi sökningen med en self-hostad SearXNG vars
IP ofta blockades av uppströms-sökmotorer, vilket fick genereringen att tyst ge noll träffar (och
sidan slutade uppdateras fast workflowen lyste grönt). Nu krävs bara en **Anthropic API-nyckel**;
ingen container, inget separat sök-API.

- **Schemalagt jobb:** [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) kör en gång per
  dygn (samt manuellt via "Run workflow").
- **Kurering:** [`scripts/generate.mjs`](scripts/generate.mjs) anropar Claude med det server-sidiga
  **web_search**-verktyget. Modellen söker själv (flera vinklar) och ombeds välja ETT avsnitt som är
  dokumenterat hyllat (bästa-listor, högt på Podchaser/Reddit, prisbelönt, mycket delat), på svenska
  eller engelska, som **inte** redan finns i historiken (senaste ~60 skickas med för dedup).
  Generatorn fångar de sökresultat modellen faktiskt såg och validerar svaret hårt mot dem
  (guardrails mot påhitt):
  - alla fält ifyllda, rätt språk, ingen dubblett;
  - **minst en käll-URL som faktiskt sågs i sökresultaten** *och* går att nå (`fetch` < 400) –
    modellen får inte hitta på eller ändra en URL;
  - **poddens namn måste förekomma i sökresultaten** (inga påhittade poddar);
  - **inga citat** i "varför den är bra"-texten (kan inte garanteras stämma, så de förbjuds helt);
  - **fristående avsnitt** – uppföljare/serie-delar/"Update:"/finale m.m. underkänns (regex + modellen
    måste sätta `standalone: true`).

  Underkänt → regenereras (max 4 försök), annars lämnas dagen tom (frontend visar gårdagens tips).
- **Koppling till dagens datum:** generatorn hämtar Wikipedias "On this day"-flöde (sv + en,
  nyckellöst) för dagens datum och matar in händelser/födslar som dagens tema. Modellen försöker
  gärna välja ett hyllat avsnitt som knyter an till något av detta och fyller då fältet
  `day_connection` (visas i kortet) – men det är en **stark preferens, inte ett krav**: hittas inget
  genuint hyllat avsnitt som passar väljs ett bra utan koppling (aldrig en påhittad koppling).
- **Persistens:** det godkända tipset läggs till i `public/data/recommendations.json` och committas
  tillbaka av workflowen. Idempotent: finns dagens datum redan görs ingenting.
- **Frontend:** `public/` (vanilla HTML/CSS/JS, inget byggsteg) läser JSON-filen och gör
  historik-sök/filter och all statistik (topplista, fördelningar, streak, tidslinje) i webbläsaren.

## Datamodell (`public/data/recommendations.json`)

En array, nyast först. Varje post:

`date` (YYYY-MM-DD, unik) · `episode_title` · `show_name` · `show_slug` (normaliserad för
gruppering) · `hosts` · `genre` · `language` · `year` · `duration_minutes` · `why_great` ·
`listen_links` ({apple,spotify,web}) · `sources` ([{title,url}]) · `created_at`.

## Konfiguration

Ändra högst upp i [`scripts/generate.mjs`](scripts/generate.mjs):
`LANGUAGES` (`["sv","en"]`), `GENRES` (`"all"` eller en lista), `MODEL` (`claude-sonnet-4-6`),
`WEB_SEARCH_TOOL`, `WEB_SEARCH_MAX_USES`, `DEDUP_COUNT`, `MAX_ATTEMPTS`, `MAX_TOOL_ROUNDS`,
`MAX_TOKENS`, `SHOW_HARD_DAYS`/`SHOW_SOFT_COUNT` (podd-dedup), `THEME_HOOKS`, `WHY_LANG`.

**Modellval:** `MODEL` är satt till `claude-sonnet-4-6` – stark redaktionell omdömesförmåga
till låg kostnad, och stöder det moderna `web_search_20260209` (dynamisk filtrering). Vill du ha
absolut bästa omdöme, byt till `claude-opus-4-8`. Vill du ha billigast möjliga, byt till
`claude-haiku-4-5` **och** sätt samtidigt `WEB_SEARCH_TOOL = "web_search_20250305"` (Haiku stöder
bara den enklare sök-varianten). Vid ~1 anrop/dygn är kostnadsskillnaden försumbar, så Sonnet är en
bra standard. Endpoint kan överstyras med miljövariabeln `ANTHROPIC_BASE_URL`.
Cron-tiden ändras i `.github/workflows/deploy.yml` (`schedule.cron`, UTC).

---

## Aktivera (engångssteg)

Det mesta är redan klart i repot. Tre saker behöver göras i GitHub-inställningarna:

1. **Lägg till Anthropic API-nyckel som secret** (krävs för genereringen):
   *Settings → Secrets and variables → Actions → New repository secret*
   - Namn: `ANTHROPIC_API_KEY`
   - Värde: din nyckel från Anthropic (Console → Settings → API keys). Webbsök måste vara
     aktiverat för organisationen: *Console → Settings → Privacy → Enable web search*.

2. **Slå på GitHub Pages med Actions som källa:**
   *Settings → Pages → Build and deployment → Source = **GitHub Actions***
   (Workflowen försöker även slå på detta automatiskt via `configure-pages`.)

3. **Aktivera den dagliga körningen:** schemalagda workflows kör bara från
   **standardbranchen**. Mergea den här branchen till `main` (eller sätt den som standardbranch).
   Vid push och vid `main` deployar Pages automatiskt.

### Seeda första tipset direkt

Vänta inte på cron – kör workflowen manuellt:
*Actions → "Bygg och deploya (GitHub Pages)" → Run workflow.*
Den genererar dagens tips, committar det och deployar sidan. Kör igen samma dygn → fortfarande
bara ett tips (idempotent). Vid manuell körning kan du ange ett **datum** och kryssa i **force**
för att tvinga om-generering av just det datumet (t.ex. för att byta ut ett redan publicerat tips).

Sidan blir nåbar på `https://<användarnamn>.github.io/poddtipset/`.

## Lokal utveckling

```bash
# Generera ett tips lokalt (skriver till public/data/recommendations.json)
ANTHROPIC_API_KEY=... npm run generate

# Servera frontend lokalt
npx --yes http-server public -p 8090 -c-1
```

`GENERATE_DATE=YYYY-MM-DD` kan sättas för att seeda ett specifikt datum.
`ANTHROPIC_BASE_URL` kan sättas för att peka på en annan Messages API-kompatibel endpoint.

## Noter

- **Tidszon:** GitHub-cron körs i UTC. `"0 1 * * *"` = 02:00 på vintern (CET) / 03:00 på sommaren
  (CEST) i Europe/Stockholm. Justera i workflowen om du vill ha en annan tid.
- **Inga hemligheter i koden:** `ANTHROPIC_API_KEY` finns bara som GitHub Actions-secret.
- **Kostnad:** Claudes webbsök kostar ca $10 per 1 000 sökningar plus vanliga token-kostnader. Vid
  ett fåtal sökningar per dygn handlar det om någon krona i månaden.
- **Sökkvalitet:** sökningen körs på Anthropics infrastruktur, så runnerns IP blockas inte av
  sökmotorerna (vilket var det som fick den gamla SearXNG-lösningen att ge tomma dagar). Skulle ett
  försök ändå underkännas görs nya försök; misslyckas allt lämnas dagen tom och frontend visar
  gårdagens tips.
- **Subväg:** frontend använder relativa sökvägar och fungerar därför både på
  `<user>.github.io/poddtipset/` och under egen domän.
