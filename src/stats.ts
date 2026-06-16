import type { Env } from "./types";
import { todayStockholm } from "./db";

export interface StatsResponse {
  total: number;
  streak: number;
  topShows: { show_slug: string; show_name: string; count: number }[];
  byGenre: { genre: string; count: number }[];
  byLanguage: { language: string; count: number }[];
  timeline: { period: string; count: number }[]; // per manad (YYYY-MM)
  firstDate: string | null;
  lastDate: string | null;
}

export async function getStats(env: Env): Promise<StatsResponse> {
  const total =
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM recommendations`).first<{ n: number }>())
      ?.n ?? 0;

  const topShows =
    (
      await env.DB.prepare(
        `SELECT show_slug, MAX(show_name) AS show_name, COUNT(*) AS count
           FROM recommendations
          GROUP BY show_slug
          ORDER BY count DESC, show_name ASC
          LIMIT 20`
      ).all<{ show_slug: string; show_name: string; count: number }>()
    ).results ?? [];

  const byGenre =
    (
      await env.DB.prepare(
        `SELECT genre, COUNT(*) AS count
           FROM recommendations
          WHERE genre <> ''
          GROUP BY genre
          ORDER BY count DESC, genre ASC`
      ).all<{ genre: string; count: number }>()
    ).results ?? [];

  const byLanguage =
    (
      await env.DB.prepare(
        `SELECT language, COUNT(*) AS count
           FROM recommendations
          WHERE language <> ''
          GROUP BY language
          ORDER BY count DESC, language ASC`
      ).all<{ language: string; count: number }>()
    ).results ?? [];

  // Tidslinje per manad (YYYY-MM).
  const timeline =
    (
      await env.DB.prepare(
        `SELECT substr(date, 1, 7) AS period, COUNT(*) AS count
           FROM recommendations
          GROUP BY period
          ORDER BY period ASC`
      ).all<{ period: string; count: number }>()
    ).results ?? [];

  // Alla datum (sorterade fallande) for att rakna ut aktuell streak.
  const dateRows =
    (
      await env.DB.prepare(
        `SELECT date FROM recommendations ORDER BY date DESC`
      ).all<{ date: string }>()
    ).results ?? [];

  const dates = dateRows.map((r) => r.date);
  const streak = computeStreak(dates, todayStockholm());

  return {
    total,
    streak,
    topShows,
    byGenre,
    byLanguage,
    timeline,
    firstDate: dates.length ? dates[dates.length - 1] : null,
    lastDate: dates.length ? dates[0] : null,
  };
}

// Aktuell streak = antal sammanhangande dagar bakat fran idag (eller fran
// senaste tipset om dagens annu inte genererats).
export function computeStreak(datesDesc: string[], today: string): number {
  if (datesDesc.length === 0) return 0;
  const set = new Set(datesDesc);

  // Startpunkt: idag om det finns ett tips idag, annars gar vi tillbaka en dag
  // sa att en obruten serie som slutar igar fortfarande raknas.
  let cursor = set.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (set.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

function addDays(isoDate: string, delta: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
