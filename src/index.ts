import type { Env } from "./types";
import { TODAY_CACHE_SECONDS, LIST_CACHE_SECONDS } from "./config";
import {
  getByDate,
  getById,
  getLatest,
  getHistory,
  todayStockholm,
  type HistoryFilter,
} from "./db";
import { getStats } from "./stats";
import { runGeneration } from "./generate";

export default {
  // Schemalagt jobb (cron) – genererar dagens tips.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runGeneration(env).then((r) => {
        console.log(`[cron] generering: ${r.status} (${r.date})${r.error ? " – " + r.error : ""}`);
      })
    );
  },

  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: msg }, 500);
      }
    }

    // Allt annat -> statiska assets (SPA). Okanda vagar faller tillbaka pa index.html
    // (konfigureras av Workers Static Assets via not_found-hantering).
    return env.ASSETS.fetch(req);
  },
};

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;

  // GET /api/today
  if (req.method === "GET" && pathname === "/api/today") {
    const date = todayStockholm();
    const today = await getByDate(env, date);
    if (today) {
      return json({ recommendation: today, stale: false, today: date }, 200, TODAY_CACHE_SECONDS);
    }
    // Inget tips an idag -> visa senaste + markera som "inaktuellt".
    const latest = await getLatest(env);
    return json(
      { recommendation: latest, stale: true, today: date },
      200,
      // Kortare cache nar vi vantar pa dagens tips.
      60
    );
  }

  // GET /api/history?search=&genre=&language=&show=&limit=&offset=
  if (req.method === "GET" && pathname === "/api/history") {
    const f: HistoryFilter = {
      search: url.searchParams.get("search") || undefined,
      genre: url.searchParams.get("genre") || undefined,
      language: url.searchParams.get("language") || undefined,
      show: url.searchParams.get("show") || undefined,
      limit: numParam(url, "limit"),
      offset: numParam(url, "offset"),
    };
    const items = await getHistory(env, f);
    return json({ items, count: items.length }, 200, LIST_CACHE_SECONDS);
  }

  // GET /api/recommendation/:id  (id = numeriskt) eller :date (YYYY-MM-DD)
  const detail = pathname.match(/^\/api\/recommendation\/(.+)$/);
  if (req.method === "GET" && detail) {
    const key = decodeURIComponent(detail[1]);
    const rec = /^\d+$/.test(key)
      ? await getById(env, Number(key))
      : await getByDate(env, key);
    if (!rec) return json({ error: "Hittades inte" }, 404);
    return json({ recommendation: rec }, 200, LIST_CACHE_SECONDS);
  }

  // GET /api/stats
  if (req.method === "GET" && pathname === "/api/stats") {
    const stats = await getStats(env);
    return json(stats, 200, LIST_CACHE_SECONDS);
  }

  // POST /api/generate  – manuell korning/seed (skyddad med GENERATE_TOKEN)
  if (req.method === "POST" && pathname === "/api/generate") {
    const token = req.headers.get("x-generate-token");
    if (!env.GENERATE_TOKEN || token !== env.GENERATE_TOKEN) {
      return json({ error: "Obehorig" }, 401);
    }
    // Tillat valfritt datum i body for att seeda specifika dagar.
    let date: string | undefined;
    try {
      const body = (await req.json()) as { date?: string };
      if (body?.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) date = body.date;
    } catch {
      // tom body ar ok
    }
    const result = await runGeneration(env, { date });
    const status = result.status === "failed" ? 502 : 200;
    return json(result, status);
  }

  return json({ error: "Okand endpoint" }, 404);
}

function numParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function json(data: unknown, status = 200, cacheSeconds = 0): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (cacheSeconds > 0) {
    headers["cache-control"] = `public, max-age=${cacheSeconds}`;
  } else {
    headers["cache-control"] = "no-store";
  }
  return new Response(JSON.stringify(data), { status, headers });
}
