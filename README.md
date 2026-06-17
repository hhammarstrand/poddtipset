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
        │  node scripts/generate.mjs
        ▼
Claude API (claude-opus-4-8 + web_search)  ──►  validering & källkontroll
        │
        ▼
public/data/recommendations.json   ← committas tillbaka i repot (persistensen)
        │
        ▼
GitHub Pages serverar public/  ──►  frontend laser JSON och visar
                                     dagens tips / historik / statistik (allt klient-sidan)
```

- **Schemalagt jobb:** [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) kör en gång per
  dygn (samt manuellt via "Run workflow").
- **Kurering:** [`scripts/generate.mjs`](scripts/generate.mjs) anropar Claude med **web_search**,
  ber modellen välja ETT avsnitt som är dokumenterat hyllat (bästa-listor, högt på Podchaser/Reddit,
  prisbelönt, mycket delat), på svenska eller engelska, som **inte** redan finns i historiken
  (senaste ~60 skickas med för dedup). Svaret valideras: alla fält ifyllda, rätt språk, ingen
  dubblett, och **minst en käll-URL som faktiskt går att nå** (`fetch` < 400). Underkänt → regenereras
  (max 3 försök), annars lämnas dagen tom (frontend visar gårdagens tips).
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
`LANGUAGES` (`["sv","en"]`), `GENRES` (`"all"` eller en lista), `MODEL` (`claude-opus-4-8`, byt
till `claude-sonnet-4-6` för lägre kostnad), `DEDUP_COUNT`, `MAX_ATTEMPTS`, `WHY_LANG`.
Cron-tiden ändras i `.github/workflows/deploy.yml` (`schedule.cron`, UTC).

---

## Aktivera (engångssteg)

Det mesta är redan klart i repot. Tre saker behöver göras i GitHub-inställningarna:

1. **Lägg till Claude API-nyckel som secret** (krävs för genereringen):
   *Settings → Secrets and variables → Actions → New repository secret*
   - Namn: `ANTHROPIC_API_KEY`
   - Värde: din nyckel från https://platform.claude.com

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
bara ett tips (idempotent).

Sidan blir nåbar på `https://<användarnamn>.github.io/poddtipset/`.

## Lokal utveckling

```bash
# Generera ett tips lokalt (skriver till public/data/recommendations.json)
ANTHROPIC_API_KEY=sk-ant-... npm run generate

# Servera frontend lokalt
npm run serve   # http://localhost:8080
```

`GENERATE_DATE=YYYY-MM-DD` kan sättas för att seeda ett specifikt datum.

## Noter

- **Tidszon:** GitHub-cron körs i UTC. `"0 5 * * *"` = 06:00 på vintern (CET) / 07:00 på sommaren
  (CEST) i Europe/Stockholm. Justera i workflowen om du vill ha exakt 06:00 året runt.
- **Inga hemligheter i koden:** `ANTHROPIC_API_KEY` finns bara som GitHub Actions-secret.
- **Kostnad:** ett Claude-anrop per dygn (web_search) – försumbart.
- **Subväg:** frontend använder relativa sökvägar och fungerar därför både på
  `<user>.github.io/poddtipset/` och under egen domän.
