# Dagens Pod 🎧

En webbapp som varje dygn automatiskt väljer ut **ETT** dokumenterat hyllat poddavsnitt och
presenterar det som "dagens tips". Användaren ser dagens avsnitt, bläddrar i historik och ser
statistik över vilka poddar som rekommenderats oftast.

Hostas helt på **GitHub Pages** (statisk frontend) + **GitHub Actions** (schemalagt jobb). Ingen
server, ingen databas, ingen inloggning, ingen tracking. Mobil först, mörkt/ljust läge.

## Så fungerar det

Brief'ens separation – **schemalagt jobb → persistens → läs-API → frontend** – behålls, men med
en ren GitHub-stack:

```
GitHub Actions (cron, dagligen 06:00 Europe/Stockholm)
        │  startar tillfällig SearXNG-container (gratis, nyckellös web_search)
        │  node scripts/generate.mjs
        ▼
Qwen via Staik (api.staik.se, OpenAI-kompatibelt)  ──►  söker via SearXNG, validering & källkontroll
        │
        ▼
public/data/recommendations.json   ← committas tillbaka i repot (persistensen)
        │
        ▼
GitHub Pages serverar public/  ──►  frontend laser JSON och visar
                                     dagens tips / historik / statistik (allt klient-sidan)
```

Sökningen är **gratis och nyckellös**: en tillfällig SearXNG-instans startas i workflowen på
`localhost:8080` och rivs ner när jobbet är klart. Modellen (Qwen) körs via Staik. Ingen
Anthropic-nyckel och inget betalt sök-API krävs – bara en Staik-nyckel.

- **Schemalagt jobb:** [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) kör en gång per
  dygn (samt manuellt via "Run workflow"). Det startar SearXNG som en Docker-container innan
  genereringen.
- **Kurering:** [`scripts/generate.mjs`](scripts/generate.mjs) anropar Qwen via Staik med ett
  klient-sidigt **web_search**-verktyg som söker mot den lokala SearXNG-instansen. Generatorn
  pre-seedar ett par bredsökningar så modellen alltid har riktiga träffar att utgå från, och ber den
  välja ETT avsnitt som är dokumenterat hyllat (bästa-listor, högt på Podchaser/Reddit,
  prisbelönt, mycket delat), på svenska eller engelska, som **inte** redan finns i historiken
  (senaste ~60 skickas med för dedup). Svaret valideras hårt (guardrails mot påhitt):
  - alla fält ifyllda, rätt språk, ingen dubblett;
  - **minst en käll-URL som faktiskt sågs i sökresultaten** *och* går att nå (`fetch` < 400) –
    modellen får inte hitta på eller ändra en URL;
  - **poddens namn måste förekomma i sökresultaten** (inga påhittade poddar);
  - **inga citat** i "varför den är bra"-texten (kan inte garanteras stämma, så de förbjuds helt);
  - **fristående avsnitt** – uppföljare/serie-delar/"Update:"/finale m.m. underkänns (regex + modellen
    måste sätta `standalone: true`).

  Underkänt → regenereras (max 4 försök), annars lämnas dagen tom (frontend visar gårdagens tips).
  Modellen körs med låg temperatur för att minska konfabulering.
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
`LANGUAGES` (`["sv","en"]`), `GENRES` (`"all"` eller en lista), `MODEL` (`qwen3.6:35b-a3b`, byt
till t.ex. `qwen3.5:9b` eller `gemma4:31b`), `DEDUP_COUNT`, `MAX_ATTEMPTS`, `MAX_TOOL_ROUNDS`,
`WHY_LANG`. Staik-endpoint kan överstyras med miljövariabeln `STAIK_BASE_URL`.
Cron-tiden ändras i `.github/workflows/deploy.yml` (`schedule.cron`, UTC).

---

## Aktivera (engångssteg)

Det mesta är redan klart i repot. Tre saker behöver göras i GitHub-inställningarna:

1. **Lägg till Staik API-nyckel som secret** (krävs för genereringen):
   *Settings → Secrets and variables → Actions → New repository secret*
   - Namn: `STAIK_API_KEY`
   - Värde: din nyckel från Staik (`sk-st-…`)

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
# Starta en lokal SearXNG (gratis web_search) – behövs av generatorn
docker run -d --name searxng -p 8080:8080 \
  -v "$PWD/searxng:/etc/searxng:ro" searxng/searxng:latest

# Generera ett tips lokalt (skriver till public/data/recommendations.json)
STAIK_API_KEY=sk-st-... SEARXNG_URL=http://localhost:8080 npm run generate

# Servera frontend lokalt (välj en annan port än SearXNG:s 8080)
npx --yes http-server public -p 8090 -c-1
```

`GENERATE_DATE=YYYY-MM-DD` kan sättas för att seeda ett specifikt datum.
`STAIK_BASE_URL` kan sättas för att peka på en annan Staik-kompatibel endpoint.

## Noter

- **Tidszon:** GitHub-cron körs i UTC. `"0 5 * * *"` = 06:00 på vintern (CET) / 07:00 på sommaren
  (CEST) i Europe/Stockholm. Justera i workflowen om du vill ha exakt 06:00 året runt.
- **Inga hemligheter i koden:** `STAIK_API_KEY` finns bara som GitHub Actions-secret.
- **Kostnad:** sökningen är gratis (self-hostad SearXNG). Den enda eventuella kostnaden är
  Staik-anropen – ett fåtal per dygn (modellen kan söka i flera rundor).
- **Sökkvalitet:** SearXNG hämtar från publika sökmotorer som ibland blockar datacenter-IP:n, så
  enstaka körningar kan ge tunna träffar. Generatorn gör då nya försök; misslyckas allt lämnas dagen
  tom och frontend visar gårdagens tips.
- **Subväg:** frontend använder relativa sökvägar och fungerar därför både på
  `<user>.github.io/poddtipset/` och under egen domän.
