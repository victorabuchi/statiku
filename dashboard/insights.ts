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

// The goals in a period: each goal event (one of the site's goals, or anything that earned money) on a website visit,
// with its visitor and day. A visitor is the same visitor only within a UTC day (their code changes daily), so that
// day is as far back as a goal can be traced.
const GOALS = `
  select row_number() over () as id, session_id, visitor, ts, (ts at time zone 'utc')::date::timestamp at time zone 'utc' as day_start
    from events where project_id = $1 and ts >= $2 and ts < $3 and session_id is not null and visitor is not null
     and (name = any($4) or revenue_minor is not null)
   limit 20000`;

// Assists: for every goal, the pages the visitor saw that day up to it, and the visits that day: the visit it came in
// (it scored), earlier ones (they assisted), and the first (where it started).
export async function assists(pool: pg.Pool, site: Pick<Site, "id">, from: Date, to: Date, goals: string[]) {
  const p = [site.id, from, to, goals];
  const [[count], pages, sources, campaigns] = await Promise.all([
    q(pool, `with g as (${GOALS}),
               touches as (select g.id, count(*) as n from g join sessions s on s.project_id = $1 and s.visitor = g.visitor
                             and s.started_at <= g.ts and s.started_at >= g.day_start group by 1)
             select (select count(*) from g)::int as goals, (select count(*) from touches where n > 1)::int as "multiVisit"`, p),
    q(pool, `with g as (${GOALS})
             select pv.path as label, count(distinct g.id)::int as v from g
               join events pv on pv.project_id = $1 and pv.visitor = g.visitor and pv.name = 'pageview' and pv.ts <= g.ts and pv.ts >= g.day_start
              group by 1 order by 2 desc, 1 limit 200`, p),
    ...["source", "utm_campaign"].map((column) => q(pool, `with g as (${GOALS}),
               touches as (
                 select g.id, s.${column} as label, s.id = g.session_id as scoring, row_number() over (partition by g.id order by s.started_at) as nth
                   from g join sessions s on s.project_id = $1 and s.visitor = g.visitor and s.started_at <= g.ts and s.started_at >= g.day_start),
               per as (select id, label, bool_or(scoring) as scored, bool_or(not scoring) as before, bool_or(nth = 1) as opened from touches where label is not null group by 1, 2)
             select label, (count(*) filter (where scored))::int as scored, (count(*) filter (where before and not scored))::int as assisted,
                    (count(*) filter (where opened))::int as opened
               from per group by 1 order by 2 desc, 3 desc, 1 limit 12`, p)),
  ]);
  return { goals: count.goals as number, multiVisit: count.multiVisit as number, pages: pages as { label: string; v: number }[], sources, campaigns };
}

// Player ratings: each of the most visited pages gets a score out of ten, from its reach (visitors, against the most
// visited page), how long people stay on it (against the site's typical page), how many goals it set up (against the
// site's rate), and how well it keeps people (the share of its views that end the visit). The best rated page with a
// fair share of visitors is the man of the match.
export async function ratings(pool: pg.Pool, site: Pick<Site, "id">, from: Date, to: Date, assisted: Map<string, number>, goals: number) {
  const rows = await q(pool, `
    with ev as (
      select path, name, visitor, session_id, ts, lead(ts) over (partition by session_id order by ts) as next_ts
        from events where project_id = $1 and ts >= $2 and ts < $3 and session_id is not null),
    pv as (
      select ev.path, ev.visitor, least(greatest(extract(epoch from coalesce(ev.next_ts, s.last_seen) - ev.ts), 0), 1800) as secs
        from ev left join sessions s on s.project_id = $1 and s.id = ev.session_id and s.started_at >= $2::timestamptz - interval '1 day' and s.started_at < $3
       where ev.name = 'pageview'),
    pages as (
      select path, count(distinct visitor)::int as visitors, count(*)::int as views, percentile_cont(0.5) within group (order by secs) as secs
        from pv group by 1 order by 2 desc, 1 limit 15),
    exits as (
      select exit_path as path, count(*)::int as exits from sessions where project_id = $1 and started_at >= $2 and started_at < $3 group by 1)
    select pages.*, coalesce(exits.exits, 0)::int as exits, (select percentile_cont(0.5) within group (order by secs) from pv) as site_secs,
           (select count(distinct visitor) from pv)::int as site_visitors
      from pages left join exits using (path)`, [site.id, from, to]);
  if (!rows.length) return { pages: [], best: null };
  const top = rows[0].visitors as number, siteSecs = Math.max(1, Number(rows[0].site_secs) || 1), rate = goals / Math.max(1, rows[0].site_visitors);
  const pages = rows.map((r) => {
    const views = r.views as number, visitors = r.visitors as number, secs = Number(r.secs) || 0, set = assisted.get(r.path) ?? 0;
    const parts: [number, number][] = [
      [0.3, (10 * Math.log1p(visitors)) / Math.log1p(top)],
      [0.25, 10 * Math.min(1, secs / (2 * siteSecs))],
      [0.2, 10 * (1 - Math.min(1, (r.exits as number) / views))],
    ];
    if (goals) parts.push([0.25, 10 * Math.min(1, set / Math.max(1, visitors) / (2 * rate))]);
    const weight = parts.reduce((a, [w]) => a + w, 0);
    const rating = Math.round(Math.max(1, Math.min(10, parts.reduce((a, [w, v]) => a + w * v, 0) / weight)) * 10) / 10;
    return { path: r.path as string, rating, visitors, views, secs: Math.round(secs), exitRate: Math.round((100 * (r.exits as number)) / views), assists: set };
  });
  const fair = Math.max(5, top * 0.05);
  const best = [...pages].filter((p) => p.visitors >= fair).sort((a, b) => b.rating - a.rating)[0] ?? null;
  // Best rated first; a page only a visitor or two saw isn't rated.
  const rated = pages.filter((p) => p.visitors >= Math.max(2, top * 0.01)).sort((a, b) => b.rating - a.rating || b.visitors - a.visitors);
  return { pages: rated, best: best?.path ?? null };
}

// Heatmap of one page on one kind of device: where clicks landed (on a grid a two-hundredth of the width across and
// eight pixels down), the links and buttons clicked most, and the share of visits that read down to each tenth of
// the page. The page asked for is the most clicked one unless another is named.
export async function heatmap(pool: pg.Pool, site: Pick<Site, "id">, from: Date, to: Date, path: string | null, device: string | null) {
  const pages = await q(pool, `select path, count(*)::int as clicks from clicks where project_id = $1 and ts >= $2 and ts < $3
                                group by 1 order by 2 desc, 1 limit 40`, [site.id, from, to]);
  const page = path ?? pages[0]?.path ?? null;
  if (!page) return { pages, path: null, device: null, devices: [], clicks: [], height: null, targets: [], scroll: [], views: 0 };
  const devices = await q(pool, `select coalesce(device, 'Unknown') as device, count(*)::int as clicks from clicks
                                  where project_id = $1 and ts >= $2 and ts < $3 and path = $4 group by 1 order by 2 desc`, [site.id, from, to, page]);
  const kind = device ?? devices[0]?.device ?? "Desktop";
  const p = [site.id, from, to, page, kind];
  const [grid, [size], targets, [scroll], [views]] = await Promise.all([
    q(pool, `select round(x * 200) / 200 as x, (round(y / 8.0) * 8)::int as y, count(*)::int as n from clicks
              where project_id = $1 and ts >= $2 and ts < $3 and path = $4 and coalesce(device, 'Unknown') = $5 group by 1, 2 limit 20000`, p),
    q(pool, `select percentile_cont(0.5) within group (order by page_h)::int as height from clicks
              where project_id = $1 and ts >= $2 and ts < $3 and path = $4 and coalesce(device, 'Unknown') = $5 and page_h > 0`, p),
    q(pool, `select target as label, count(*)::int as v from clicks
              where project_id = $1 and ts >= $2 and ts < $3 and path = $4 and coalesce(device, 'Unknown') = $5 and target is not null
              group by 1 order by 2 desc, 1 limit 12`, p),
    q(pool, `select count(*)::int as n, array[${[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((d) => `count(*) filter (where depth >= ${d})`).join(", ")}]::int[] as reached
               from scrolls where project_id = $1 and ts >= $2 and ts < $3 and path = $4 and coalesce(device, 'Unknown') = $5`, p),
    q(pool, `select count(*)::int as n from events where project_id = $1 and ts >= $2 and ts < $3 and name = 'pageview' and path = $4 and coalesce(device, 'Unknown') = $5`, p),
  ]);
  return {
    pages, path: page, device: kind, devices,
    clicks: grid.map((g) => ({ x: Number(g.x), y: g.y as number, n: g.n as number })),
    height: size?.height ?? null,
    targets,
    scroll: scroll.n ? scroll.reached.map((r: number, i: number) => ({ depth: (i + 1) * 10, share: Math.round((100 * r) / scroll.n) })) : [],
    scrolled: scroll.n as number,
    views: views.n as number,
  };
}

// Injuries: page speed as visitors got it (the 75th percentile, as Google judges it), the slowest pages, the script
// errors visitors hit most, and pages that answered with an error.
export async function injuries(pool: pg.Pool, site: Pick<Site, "id">, from: Date, to: Date) {
  const p = [site.id, from, to];
  const P75 = (c: string) => `percentile_cont(0.75) within group (order by ${c})`;
  const [[overall], slow, errors, broken] = await Promise.all([
    q(pool, `select ${P75("lcp")} as lcp, ${P75("inp")} as inp, ${P75("cls")} as cls, ${P75("ttfb")} as ttfb, count(*)::int as n
               from vitals where project_id = $1 and ts >= $2 and ts < $3`, p),
    q(pool, `select path, ${P75("lcp")} as lcp, ${P75("inp")} as inp, ${P75("cls")} as cls, count(*)::int as n
               from vitals where project_id = $1 and ts >= $2 and ts < $3 group by 1 having count(*) >= 3
              order by 2 desc nulls last limit 10`, p),
    q(pool, `select message, source, max(line)::int as line, count(*)::int as n, count(distinct path)::int as pages, max(ts) as last,
                    (array_agg(path order by ts desc))[1] as path, array_remove(array_agg(distinct browser), null) as browsers
               from page_errors where project_id = $1 and ts >= $2 and ts < $3 group by 1, 2 order by 4 desc, 6 desc limit 15`, p),
    q(pool, `select path, status, count(*)::int as n from vitals where project_id = $1 and ts >= $2 and ts < $3 and status >= 400
              group by 1, 2 order by 3 desc, 1 limit 15`, p),
  ]);
  const round = (v: unknown, d = 0) => (v == null ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
  return {
    vitals: { lcp: round(overall.lcp), inp: round(overall.inp), cls: round(overall.cls, 3), ttfb: round(overall.ttfb), samples: overall.n as number },
    slow: slow.map((s) => ({ path: s.path as string, lcp: round(s.lcp), inp: round(s.inp), cls: round(s.cls, 3), n: s.n as number })),
    errors,
    broken,
  };
}
