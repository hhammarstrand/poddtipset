import type { Env, Recommendation, RecommendationRow, GeneratedTip } from "./types";

// Normalisera ett show-namn till en slug for gruppering i statistiken.
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // ta bort diakritiska tecken (e -> e)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseRow(row: RecommendationRow): Recommendation {
  let listen_links = {};
  let sources: Recommendation["sources"] = [];
  try {
    listen_links = JSON.parse(row.listen_links || "{}");
  } catch {
    listen_links = {};
  }
  try {
    sources = JSON.parse(row.sources || "[]");
  } catch {
    sources = [];
  }
  return { ...row, listen_links, sources };
}

// Dagens datum i Europe/Stockholm som YYYY-MM-DD (cron/visning ar lokal).
export function todayStockholm(now: Date = new Date()): string {
  // sv-SE ger redan YYYY-MM-DD-format.
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export async function getByDate(env: Env, date: string): Promise<Recommendation | null> {
  const row = await env.DB.prepare(`SELECT * FROM recommendations WHERE date = ?`)
    .bind(date)
    .first<RecommendationRow>();
  return row ? parseRow(row) : null;
}

export async function getById(env: Env, id: number): Promise<Recommendation | null> {
  const row = await env.DB.prepare(`SELECT * FROM recommendations WHERE id = ?`)
    .bind(id)
    .first<RecommendationRow>();
  return row ? parseRow(row) : null;
}

export async function getLatest(env: Env): Promise<Recommendation | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM recommendations ORDER BY date DESC LIMIT 1`
  ).first<RecommendationRow>();
  return row ? parseRow(row) : null;
}

// De senaste N raderna – anvands for dedup-listan i prompten.
export async function getRecent(env: Env, limit: number): Promise<Recommendation[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM recommendations ORDER BY date DESC LIMIT ?`
  )
    .bind(limit)
    .all<RecommendationRow>();
  return (results ?? []).map(parseRow);
}

export interface HistoryFilter {
  search?: string;
  genre?: string;
  language?: string;
  show?: string; // show_slug
  limit?: number;
  offset?: number;
}

export async function getHistory(env: Env, f: HistoryFilter): Promise<Recommendation[]> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (f.search) {
    where.push(`(episode_title LIKE ? OR show_name LIKE ? OR hosts LIKE ? OR why_great LIKE ?)`);
    const like = `%${f.search}%`;
    binds.push(like, like, like, like);
  }
  if (f.genre) {
    where.push(`genre = ?`);
    binds.push(f.genre);
  }
  if (f.language) {
    where.push(`language = ?`);
    binds.push(f.language);
  }
  if (f.show) {
    where.push(`show_slug = ?`);
    binds.push(f.show);
  }

  const limit = Math.min(Math.max(f.limit ?? 200, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);

  const sql =
    `SELECT * FROM recommendations` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : ``) +
    ` ORDER BY date DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<RecommendationRow>();
  return (results ?? []).map(parseRow);
}

// Spara idempotent: en rad per datum. Returnerar true om en ny rad skapades.
export async function insertRecommendation(
  env: Env,
  date: string,
  tip: GeneratedTip
): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT INTO recommendations
       (date, episode_title, show_name, show_slug, hosts, genre, language,
        year, duration_minutes, why_great, listen_links, sources, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO NOTHING`
  )
    .bind(
      date,
      tip.episode_title,
      tip.show_name,
      slugify(tip.show_name),
      tip.hosts ?? "",
      tip.genre ?? "",
      tip.language ?? "",
      tip.year ?? null,
      tip.duration_minutes ?? null,
      tip.why_great,
      JSON.stringify(tip.listen_links ?? {}),
      JSON.stringify(tip.sources ?? []),
      new Date().toISOString()
    )
    .run();
  // D1 returnerar meta.changes; 0 betyder att raden redan fanns (ON CONFLICT).
  return (res.meta?.changes ?? 0) > 0;
}
