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
MiniMax  ──►  webbsökningar server-side (/v1/coding_plan/search) +
        │      en MiniMax-modell väljer ETT avsnitt (chat/completions),
        │      validering & källkontroll
        ▼
public/data/recommendations.json   ← committas tillbaka i repot (persistensen)
        │
        ▼
node scripts/build-seo.mjs   ← forrenderar dagens tips i index.html + bygger
        │                        sitemap.xml / robots.txt / feed.xml / manifest
        ▼
GitHub Pages serverar public/  ──►  frontend laser JSON och visar
                                     dagens tips / historik / statistik (allt klient-sidan)
```

Både sökningen och modellen körs på **MiniMax infrastruktur**, inte på GitHub-runnern. Generatorn gör
först några varierade webbsökningar mot MiniMax server-sidiga sök-endpoint
(`/v1/coding_plan/search`) och matar in träffarna i **ett** anrop till en MiniMax-chattmodell som
väljer avsnittet. Eftersom sökningen sker server-side är runnerns datacenter-IP aldrig i sökloopen –
tidigare löste vi sökningen med en self-hostad SearXNG vars IP ofta blockades av uppströms-sökmotorer,
vilket fick genereringen att tyst ge noll träffar (och sidan slutade uppdateras fast workflowen lyste
grönt). Nu krävs bara en **MiniMax API-nyckel** (token/coding plan); ingen container, inget separat
sök-API, och samma nyckel används för både sök och LLM.

- **Schemalagt jobb:** [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) kör en gång per
  dygn (samt manuellt via "Run workflow").
- **Kurering:** [`scripts/generate.mjs`](scripts/generate.mjs) gör flera varierade webbsökningar (olika
  vinklar: genre/språk/källa) mot MiniMax sök-endpoint och ber sedan en MiniMax-modell välja ETT avsnitt
  som är dokumenterat hyllat (bästa-listor, högt på Podchaser/Reddit, prisbelönt, mycket delat), på
  svenska eller engelska, som **inte** redan finns i historiken (senaste ~60 skickas med för dedup).
  Modellen får bara välja utifrån de medskickade sökträffarna, och svaret valideras hårt mot dem
  (guardrails mot påhitt):
  - alla fält ifyllda, rätt språk, ingen dubblett;
  - **minst en käll-URL som ordagrant kom ur sökträffarna** – och **minst en källa måste namnge
    podden** (modellen får inte hitta på eller para ihop en URL med fel podd);
  - **poddens namn måste förekomma i sökresultaten** (inga påhittade poddar);
  - **inga citat** och **ingen spekulation** ("kanske"/"titeln antyder") i "varför den är bra"-texten,
    och **inga icke-latinska tecken** (modellen får inte byta språk mitt i);
  - **bara riktiga källor** – enbart sociala/video-länkar (YouTube/Instagram m.fl.) underkänns;
  - **fristående avsnitt** – uppföljare/serie-delar/säsonger/"Update:"/finale m.m. underkänns (regex +
    modellen måste sätta `standalone: true`).

  Underkänt → regenereras (max 12 försök), annars lämnas dagen tom (frontend visar gårdagens tips).
- **Koppling till dagens datum:** generatorn hämtar Wikipedias "On this day"-flöde (sv + en,
  nyckellöst) för dagens datum och matar in händelser/födslar som dagens tema. Modellen försöker
  gärna välja ett hyllat avsnitt som knyter an till något av detta och fyller då fältet
  `day_connection` (visas i kortet) – men det är en **stark preferens, inte ett krav**: hittas inget
  genuint hyllat avsnitt som passar väljs ett bra utan koppling (aldrig en påhittad koppling).
- **Persistens:** det godkända tipset läggs till i `public/data/recommendations.json` och committas
  tillbaka av workflowen. Idempotent: finns dagens datum redan görs ingenting.
- **Frontend:** `public/` (vanilla HTML/CSS/JS, inget byggsteg) läser JSON-filen och gör
  historik-sök/filter och all statistik (topplista, fördelningar, streak, tidslinje) i webbläsaren.
  Redaktionell tidskrifts-design (Fraunces + Inter, självhostade), **mörkt/ljust läge** (följer
  systemet + manuell knapp, sparas i `localStorage`, ingen FOUC), premium "dagens-kort", mobil först
  och tillgänglighet (skip-länk, fokusmarkeringar, `prefers-reduced-motion`).

### SEO & delning (`scripts/build-seo.mjs`)

Sidan är en hash-router-SPA, så för att sökmotorer och sociala medier ska se **riktigt innehåll**
(inte bara ett tomt skal) bygger [`scripts/build-seo.mjs`](scripts/build-seo.mjs) om följande varje
gång ett nytt tips genereras (och vid varje deploy – deterministiskt, så det skapar inget commit-brus):

- **Förrenderar dagens tips** direkt i `index.html` (mellan `<!--SEO-HERO-->`-markörer) plus en
  "Fler tips"-lista – crawlers och no-JS-besökare får hela innehållet i HTML:en.
- **`<title>` + meta-description**, **Open Graph** och **Twitter Card** (`summary_large_image`) satta
  till dagens avsnitt, samt **canonical** och `og:image` → `og.png`.
- **JSON-LD** (`schema.org`): `WebSite` + dagens `PodcastEpisode` + en `ItemList` över de senaste
  tipsen (rik-resultat-kandidat i Google).
- **`sitemap.xml`**, **`robots.txt`** (pekar på sitemap), **`feed.xml`** (RSS över alla tips – egen
  prenumerations-/trafikkanal) och **`manifest.webmanifest`** (installbar PWA).
- **`404.html`** = kopia av `index.html` (SPA-fallback för djuplänkar).
- Per vy uppdaterar frontend `document.title` + meta-description (Dagens/Historik/Statistik/avsnitt).

Delningsbilden **`og.png`** (1200×630, varumärkesbärande) och **podd-omslaget `podcast-cover.png`**
(1500×1500) byggs separat och statiskt med [`scripts/build-og.mjs`](scripts/build-og.mjs)
(Playwright/Chromium) och committas – de körs alltså *inte* i CI. Vill du ändra dem: `npm run build:og`.

### Podd-RSS (`scripts/build-podcast.mjs`)

Förutom artikel-flödet `feed.xml` (för RSS-läsare) byggs ett **riktigt podd-RSS-flöde `podcast.xml`**
som går att lägga in i valfri poddspelare (Apple Podcasts, Pocket Casts, Overcast …):

- **Spelbarhets-gate:** varje tips slås upp i Apples avsnitts-index – är det ingen äkta podd-episod
  (t.ex. en tidningsartikel eller "bästa-lista") underkänns det och kommer aldrig in.
- **Riktig ljud-enclosure:** vid genereringen slås avsnittets **egna ljud-URL** upp ur poddens RSS och
  sparas i fältet `audio` (`{url,type,length,durationSec}`). Podd-flödet pekar med `<enclosure>` på den
  URL:en, så ljudet streamas från **utgivarens egen host** – nedladdning, statistik och annonser stannar
  hos dem; vi re-hostar inget. Avsnitt utan upplösbar enclosure (t.ex. gamla som ramlat ur poddens flöde)
  utelämnas (best-effort, ~90 % täckning).
- `itunes:`-taggar, omslag (`podcast-cover.png`) och kategori finns; **ingen privat e-post exponeras**
  (sätt `PODCAST_OWNER_EMAIL` om du vill registrera flödet i Apple Podcasts-katalogen).
- Varje avsnitt länkar tillbaka till sajten (driver trafik). Flödet deklareras även i `<head>` och som
  `PodcastSeries` i JSON-LD för upptäckbarhet.

Äldre poster efterfylls med enclosure via `npm run backfill:enclosures`.

Den publika adressen styrs av `SITE_URL` (default `https://hhammarstrand.github.io/poddtipset`); sätt
miljövariabeln om du flyttar till egen domän så uppdateras canonical/OG/sitemap/RSS automatiskt.

## Datamodell (`public/data/recommendations.json`)

En array, nyast först. Varje post:

`date` (YYYY-MM-DD, unik) · `episode_title` · `show_name` · `show_slug` (normaliserad för
gruppering) · `hosts` · `genre` · `language` · `year` · `duration_minutes` · `why_great` ·
`listen_links` ({apple,spotify,web}) · `sources` ([{title,url}]) · `created_at`.

## Konfiguration

Ändra högst upp i [`scripts/generate.mjs`](scripts/generate.mjs):
`LANGUAGES` (`["sv","en"]`), `GENRES` (`"all"` eller en lista), `MODEL` (`MiniMax-M3`),
`DEDUP_COUNT`, `MAX_ATTEMPTS`, `MAX_TOKENS`, `SEED_RESULTS_PER_QUERY`,
`SHOW_HARD_DAYS`/`SHOW_SOFT_COUNT` (podd-dedup), `THEME_HOOKS`, `WHY_LANG`.

**Modellval:** `MODEL` är satt till `MiniMax-M3`, som ger renare svensk prosa och stabilare JSON än
`MiniMax-M2.7` (som ibland bytte språk mitt i svaret). Modellen kan överstyras med miljövariabeln
`MINIMAX_MODEL`, och endpoint-basen med `MINIMAX_BASE_URL` (t.ex. `https://api.minimaxi.com` för en
annan region). Cron-tiden ändras i `.github/workflows/deploy.yml` (`schedule.cron`, UTC).

---

## Aktivera (engångssteg)

Det mesta är redan klart i repot. Tre saker behöver göras i GitHub-inställningarna:

1. **Lägg till MiniMax API-nyckel som secret** (krävs för genereringen):
   *Settings → Secrets and variables → Actions → New repository secret*
   - Namn: `MINIMAX_API_KEY`
   - Värde: din nyckel från MiniMax (platform.minimax.io). En token-/coding-plan-nyckel räcker –
     samma nyckel används för både sök-endpointen och chat-modellen.
   - **Lägg ALDRIG en nyckel direkt i chatt, kod eller commits** – bara via secret-rutan ovan.
     Om en nyckel av misstag exponerats någonstans: rotera/återkalla den omedelbart på
     platform.minimax.io innan du lägger in den nya.

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
MINIMAX_API_KEY=... npm run generate

# Bygg om SEO-/delningsartefakter (index.html-meta, sitemap, robots, RSS, manifest)
npm run build:seo

# Bygg om delningsbilden og.png (kräver Playwright + Chromium)
npm run build:og

# End-to-end-verifiera den byggda sidan i en riktig webbläsare (rendering, vyer,
# mörkt läge, alla SEO-artefakter) – tar även skärmbilder i verify-shots/
npm run verify

# Servera frontend lokalt
npx --yes http-server public -p 8090 -c-1
```

`GENERATE_DATE=YYYY-MM-DD` kan sättas för att seeda ett specifikt datum.
`MINIMAX_MODEL` kan sättas för att testa en annan MiniMax-modell, `MINIMAX_BASE_URL` för en annan region.

## Noter

- **Tidszon:** GitHub-cron körs i UTC. `"0 1 * * *"` = 02:00 på vintern (CET) / 03:00 på sommaren
  (CEST) i Europe/Stockholm. Justera i workflowen om du vill ha en annan tid.
- **Inga hemligheter i koden:** `MINIMAX_API_KEY` finns bara som GitHub Actions-secret.
- **Kostnad:** både sök och LLM ingår i MiniMax token-/coding-plan, så ett fåtal körningar per dygn
  kostar marginellt. (Varje dag gör som mest ~12 försök à 4–5 sökningar + ett modellanrop.)
- **Sökkvalitet:** sökningen körs på MiniMax infrastruktur, så runnerns IP blockas inte av
  sökmotorerna (vilket var det som fick den gamla SearXNG-lösningen att ge tomma dagar). Skulle ett
  försök ändå underkännas görs nya försök; misslyckas allt lämnas dagen tom och frontend visar
  gårdagens tips.
- **Subväg:** frontend använder relativa sökvägar och fungerar därför både på
  `<user>.github.io/poddtipset/` och under egen domän.
