// Reports that read a site like a match: who's attacking right now (momentum), which pages and sources set up the
// goals (assists), how each page played (player ratings), what's hurting visitors (injuries), where they click and how
// far they read (heatmaps), what each source earned (revenue), and what changed between two periods.
import type pg from "pg";
import type { Site } from "./stats.ts";

const q = async (pool: pg.Pool, sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;

// Momentum: new visits in each five minutes of the last two hours against the same time a week before (above the line
// is better than usual), and each source's arrivals in the last half hour against the half hour before.
export async function momentum(pool: pg.Pool, site: Pick<Site, "id">) {
  const [now, before, sources] = await Promise.all([
    q(pool, `select floor(extract(epoch from now() - started_at) / 300)::int as ago, count(*)::int as n from sessions
               where project_id = $1 and started_at > now() - interval '2 hours' group by 1`, [site.id]),
    q(pool, `select floor(extract(epoch from (now() - interval '7 days') - started_at) / 300)::int as ago, count(*)::int as n from sessions
               where project_id = $1 and started_at > now() - interval '7 days 2 hours' and started_at <= now() - interval '7 days' group by 1`, [site.id]),
    q(pool, `select source, (count(*) filter (where started_at > now() - interval '30 minutes'))::int as now,
                    (count(*) filter (where started_at <= now() - interval '30 minutes'))::int as before
               from sessions where project_id = $1 and started_at > now() - interval '1 hour'
              group by 1 order by 2 desc, 3 desc, 1 limit 8`, [site.id]),
  ]);
  const at = (rows: { ago: number; n: number }[]) => new Map(rows.map((r) => [r.ago, r.n]));
  const a = at(now), b = at(before);
  // Oldest first; the last five minutes are the last bucket.
  const wave = Array.from({ length: 24 }, (_, i) => 23 - i).map((ago) => ({ ago, now: a.get(ago) ?? 0, before: b.get(ago) ?? 0 }));
  return { wave, sources: sources.map((s) => ({ source: s.source as string, now: s.now as number, before: s.before as number })) };
}
